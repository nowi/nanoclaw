/**
 * Read-only catalogue search for container agents.
 *
 * Unlike ordering there is nothing to approve: no money moves, no personal
 * data is sent, and the only thing leaving the install is the search term. So
 * this is a plain request/response bridge rather than a guarded action.
 *
 * It reuses the transport `ncl` already uses (src/cli/delivery-action.ts): the
 * container writes a system message carrying a `requestId`, the host does the
 * work and writes the answer straight back into the inbound mailbox with
 * `trigger: false`, and the tool polls for it. The container's
 * `findCliResponse` matches on `requestId` alone, so reusing the
 * `cli_response` envelope needs no new mailbox surface.
 */
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { BuchboxCliError, SEARCH_LIMIT_MAX, isInstalled, searchBooks, type BuchboxSearchRequest } from './client.js';

/**
 * Minimum spacing between searches from one session. The CLI throttles within
 * a single run, but each run is a fresh process, so without this an agent in a
 * loop could hammer the shop.
 */
const MIN_SEARCH_INTERVAL_MS = 1500;
const lastSearchAt = new Map<string, number>();

/** Bound the reply so a wide search can't blow up the agent's context. */
const MAX_FIELD_CHARS = 300;

type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

function clamp(value: string | undefined): string {
  if (!value) return '';
  return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
}

export function parseSearchRequest(content: Record<string, unknown>): { req: BuchboxSearchRequest } | { error: string } {
  const str = (key: string): string | undefined => {
    const raw = content[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  };
  const req: BuchboxSearchRequest = {
    query: str('query'),
    isbn: str('isbn'),
    author: str('author'),
    publisher: str('publisher'),
    availability: content.availability === true,
  };
  const limit = Number(content.limit);
  if (Number.isFinite(limit) && limit > 0) req.limit = Math.min(Math.trunc(limit), SEARCH_LIMIT_MAX);

  if (!req.query && !req.isbn && !req.author && !req.publisher) {
    return { error: 'one of query, isbn, author or publisher is required' };
  }
  return { req };
}

async function respond(session: Session, requestId: string, frame: ResponseFrame): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `buchbox-search-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    // `cli_response` + requestId is what the container's findCliResponse
    // matches on; the agent is not woken, this is an inline tool reply.
    content: JSON.stringify({ type: 'cli_response', requestId, frame }),
    trigger: false,
  });
}

export async function handleBuchboxSearch(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  if (!requestId) {
    log.warn('buchbox_search missing requestId', { sessionId: session.id });
    return;
  }

  if (!isInstalled()) {
    await respond(session, requestId, {
      id: requestId,
      ok: false,
      error: { code: 'not_installed', message: 'the buchbox CLI is not installed on the host' },
    });
    return;
  }

  const parsed = parseSearchRequest(content);
  if ('error' in parsed) {
    await respond(session, requestId, {
      id: requestId,
      ok: false,
      error: { code: 'bad_request', message: parsed.error },
    });
    return;
  }

  const since = Date.now() - (lastSearchAt.get(session.id) ?? 0);
  if (since < MIN_SEARCH_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_SEARCH_INTERVAL_MS - since));
  }
  lastSearchAt.set(session.id, Date.now());

  try {
    const hits = await searchBooks(parsed.req);
    const data = hits.map((book) => ({
      isbn: book.ean,
      title: clamp(book.title),
      subtitle: clamp(book.subtitle),
      author: clamp(book.author),
      publisher: clamp(book.publisher),
      binding: clamp(book.binding),
      price: book.price_text || (book.price !== null ? `${book.price} EUR` : ''),
      availability: clamp(book.availability),
      url: book.url,
    }));
    log.info('buchbox_search served', { requestId, hits: data.length, sessionId: session.id });
    await respond(session, requestId, { id: requestId, ok: true, data: { hits: data } });
    // eslint-disable-next-line no-catch-all/no-catch-all -- a search failure is reported to the requester, never rethrown into delivery
  } catch (err) {
    const message = err instanceof BuchboxCliError ? err.message : String(err);
    log.warn('buchbox_search failed', { requestId, message });
    await respond(session, requestId, {
      id: requestId,
      ok: false,
      error: { code: 'search_failed', message },
    });
  }
}
