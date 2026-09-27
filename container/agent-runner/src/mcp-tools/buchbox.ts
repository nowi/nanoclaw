/**
 * buchbox MCP tools: buchbox_search, buchbox_order, buchbox_cancel_order.
 *
 * Fire-and-forget — the tool writes a system action row and returns
 * immediately. The host looks the article up, asks an admin for approval, and
 * notifies the agent via a chat message when the order is placed or refused.
 * The agent can never place the order itself.
 *
 * Inputs are sanitized here at the tool boundary AND re-validated on the host
 * (defense in depth); the host's copy is the one that gates the card.
 *
 * `buchbox_search` is the opposite shape: read-only, so it is request/response
 * rather than fire-and-forget. It writes a system message carrying a requestId
 * and polls the inbound mailbox for the answer — the same transport `ncl` uses,
 * and `findCliResponse` matches on requestId alone, so no new mailbox surface
 * is needed.
 */
import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * Mirrors the host's parseOrderRequest (src/modules/buchbox/request.ts) — the
 * host re-validates on receipt, but this copy answers the agent instantly.
 * No shared modules across the host/container boundary; keep the two in sync.
 */
const ISBN_RE = /^(?:\d[\d\s-]{8,16}[\dxX])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[\d\s()/.-]{6,25}$/;
const NAME_RE = /^[\p{L}\p{M}'\-. ]{1,60}$/u;

/** How long to wait for the host to answer a search before giving up. */
const SEARCH_TIMEOUT_MS = 90_000;
const SEARCH_POLL_MS = 400;
const SEARCH_LIMIT_MAX = 10;

type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

async function pollResponse(requestId: string, timeoutMs = SEARCH_TIMEOUT_MS): Promise<ResponseFrame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = findCliResponse(requestId);
    if (row) {
      // Mark it done or the poll loop would hand this response to the agent
      // as ordinary inbound content.
      markCompleted([row.id]);
      return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
    }
    await new Promise((resolve) => setTimeout(resolve, SEARCH_POLL_MS));
  }
  return null;
}

export const buchboxSearch: McpToolDefinition = {
  tool: {
    name: 'buchbox_search',
    description:
      'Search the BUCHBOX! Berlin catalogue. Read-only and needs no approval. Give a free-text `query` (title/keyword), or `author`, or `publisher`, or an exact `isbn`. An exact ISBN returns one fully-populated hit including availability; a keyword search returns a list WITHOUT availability (the shop omits it there) — pass `availability: true` to fetch it per hit, which costs one extra request each, so keep `limit` small. Use this to find a book and its ISBN, then pass that ISBN to buchbox_order.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text title or keyword' },
        isbn: { type: 'string', description: 'Exact ISBN-10 or ISBN-13' },
        author: { type: 'string', description: 'Author name' },
        publisher: { type: 'string', description: 'Publisher name' },
        limit: { type: 'number', description: `Max hits, 1-${SEARCH_LIMIT_MAX} (default 5)` },
        availability: {
          type: 'boolean',
          description: 'Fetch availability per hit (one extra request each; default false)',
        },
      },
    },
  },
  async handler(args) {
    const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const query = str('query');
    const isbn = str('isbn');
    const author = str('author');
    const publisher = str('publisher');
    if (!query && !isbn && !author && !publisher) {
      return err('Provide at least one of query, isbn, author or publisher');
    }
    if (isbn && !ISBN_RE.test(isbn)) return err('isbn must be a valid ISBN-10 or ISBN-13');

    const requestId = `buchbox-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'buchbox_search',
        requestId,
        query,
        isbn,
        author,
        publisher,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        availability: args.availability === true,
      }),
    });

    const frame = await pollResponse(requestId);
    if (!frame) return err('Search timed out — the host did not answer');
    if (!frame.ok) return err(frame.error.message);

    const hits = (frame.data as { hits?: unknown[] }).hits ?? [];
    if (hits.length === 0) return ok('No matches.');
    log(`buchbox_search: ${requestId} → ${hits.length} hit(s)`);
    return ok(JSON.stringify(hits, null, 2));
  },
};

export const buchboxOrder: McpToolDefinition = {
  tool: {
    name: 'buchbox_order',
    description:
      'Order a book at BUCHBOX! Berlin for PICKUP (never shipping). Identity defaults to the operator configured on the host, so normally pass only `isbn`. Pass first_name/last_name/email/phone ONLY when ordering for somebody else — never invent values; ask if unsure. Requires admin approval and is fire-and-forget: you will be notified once the order is placed or refused. Payment happens in the shop, so no payment details are involved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        isbn: { type: 'string', description: 'ISBN-10 or ISBN-13 of the book, with or without hyphens' },
        first_name: { type: 'string', description: 'Given name — omit to use the configured default orderer' },
        last_name: { type: 'string', description: 'Family name — omit to use the configured default orderer' },
        email: { type: 'string', description: 'E-mail for the pickup notification — omit to use the default' },
        phone: { type: 'string', description: 'Phone so the branch can reach the customer — omit to use the default' },
        reason: { type: 'string', description: 'Why this book is being ordered (shown to the approver)' },
      },
      required: ['isbn'],
    },
  },
  async handler(args) {
    const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const isbn = str('isbn');
    const firstName = str('first_name');
    const lastName = str('last_name');
    const email = str('email');
    const phone = str('phone');

    // Only what the agent actually supplied is checked here; omitted fields
    // fall back to the host's configured default orderer, and the host
    // re-validates the merged result before any card is minted.
    if (!ISBN_RE.test(isbn)) return err('isbn must be a valid ISBN-10 or ISBN-13');
    if (firstName && !NAME_RE.test(firstName)) return err('first_name must be a plain name');
    if (lastName && !NAME_RE.test(lastName)) return err('last_name must be a plain name');
    if (email && !EMAIL_RE.test(email)) return err('email must be a valid e-mail address');
    if (phone && !PHONE_RE.test(phone)) return err('phone must be a valid phone number');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'buchbox_order',
        isbn,
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        reason: str('reason'),
      }),
    });

    log(`buchbox_order: ${requestId} → ${isbn}`);
    return ok(
      'Pickup order request submitted for admin approval. You will be notified when it is approved or rejected.',
    );
  },
};

export const buchboxCancelOrder: McpToolDefinition = {
  tool: {
    name: 'buchbox_cancel_order',
    description:
      'Abort an approved buchbox order while it is still inside its grace window. After an approval the host waits ~2 minutes before contacting the shop; call this the moment the user objects in ANY wording ("stop", "warte", "nein doch nicht", "cancel that") — it is always safe, it can only prevent the order. Reports whether something was actually waiting.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const requestId = `buchbox-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'buchbox_cancel_order', requestId }),
    });

    // Short timeout: this is a race against the grace window, so a slow answer
    // is worse than a clear failure the agent can report and retry.
    const frame = await pollResponse(requestId, 20_000);
    if (!frame) return err('Cancel timed out — the host did not answer; tell the user to check immediately');
    if (!frame.ok) return err(frame.error.message);

    const data = frame.data as { cancelled?: boolean; title?: string; reason?: string };
    if (data.cancelled) {
      log(`buchbox_cancel_order: ${requestId} → cancelled`);
      return ok(`Cancelled. "${data.title ?? 'the order'}" was NOT ordered.`);
    }
    return ok(`Nothing to cancel: ${data.reason ?? 'no order was waiting'}. It may already have been placed.`);
  },
};

registerTools([buchboxSearch, buchboxOrder, buchboxCancelOrder]);
