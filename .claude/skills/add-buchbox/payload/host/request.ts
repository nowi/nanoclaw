/**
 * Validation + approval-card builder for agent-initiated pickup orders.
 *
 * The precheck rejects malformed requests without ever minting a card. The
 * hold builder runs the CLI as a *dry run* first, so the card states the real
 * title, price, availability and branch the shop resolved — an approver is
 * never asked to sign an ISBN they cannot read.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { BuchboxCliError, isInstalled, previewOrder, type BuchboxOrderRequest } from './client.js';
import { resolveDefaultIdentity } from './identity.js';

/** ISBN-10/13 with optional hyphens/spaces. */
const ISBN_RE = /^(?:\d[\d\s-]{8,16}[\dxX])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[\d\s()/.-]{6,25}$/;
const NAME_RE = /^[\p{L}\p{M}'\-. ]{1,60}$/u;
const MAX_CARD_BYTES = 1500;

/**
 * Resolve an order request: the agent's explicit fields win, anything omitted
 * falls back to the configured default orderer. The merged identity is what
 * the approval card shows AND what the approved replay orders with — callers
 * persist this result into the approval payload, so a later change to the
 * default file cannot retroactively alter an approved order.
 */
export function parseOrderRequest(content: Record<string, unknown>): { req: BuchboxOrderRequest } | { error: string } {
  const str = (key: string): string => (typeof content[key] === 'string' ? (content[key] as string).trim() : '');
  const fallback = resolveDefaultIdentity();
  const isbn = str('isbn');
  const firstName = str('first_name') || fallback.firstName;
  const lastName = str('last_name') || fallback.lastName;
  const email = str('email') || fallback.email;
  const phone = str('phone') || fallback.phone;

  const missing = 'not supplied and no default orderer is configured';
  if (!ISBN_RE.test(isbn)) return { error: 'isbn must be a valid ISBN-10 or ISBN-13' };
  if (!firstName) return { error: `first_name is ${missing}` };
  if (!lastName) return { error: `last_name is ${missing}` };
  if (!email) return { error: `email is ${missing}` };
  if (!phone) return { error: `phone is ${missing}` };
  if (!NAME_RE.test(firstName)) return { error: 'first_name must be a plain name' };
  if (!NAME_RE.test(lastName)) return { error: 'last_name must be a plain name' };
  if (!EMAIL_RE.test(email)) return { error: 'email must be a valid e-mail address' };
  if (!PHONE_RE.test(phone)) return { error: 'phone must be a valid phone number' };

  return { req: { isbn, firstName, lastName, email, phone } };
}

export async function validateBuchboxOrder(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (!isInstalled()) {
    await notifyAgent(session, 'buchbox_order failed: the buchbox CLI is not installed on the host.');
    return false;
  }
  const parsed = parseOrderRequest(content);
  if ('error' in parsed) {
    await notifyAgent(session, `buchbox_order failed: ${parsed.error}.`);
    return false;
  }
  return true;
}

export async function requestBuchboxOrderHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return; // precheck already answered the requester
  const parsed = parseOrderRequest(content);
  if ('error' in parsed) return;
  const { req } = parsed;

  let preview;
  try {
    preview = await previewOrder(req);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a lookup failure is reported to the requester, never rethrown into delivery
  } catch (err) {
    const reason = err instanceof BuchboxCliError ? err.message : String(err);
    log.warn('buchbox_order: dry run failed, no card minted', { reason });
    await notifyAgent(session, `buchbox_order failed: could not look up the article — ${reason}`);
    return;
  }

  if (preview.missing.length > 0) {
    await notifyAgent(session, `buchbox_order failed: missing ${preview.missing.join('; ')}.`);
    return;
  }

  const price = preview.book.price_text || (preview.book.price !== null ? `${preview.book.price} EUR` : 'unbekannt');
  const question =
    `Agent "${agentGroup.name}" möchte eine Abholbestellung aufgeben:\n` +
    '```\n' +
    [
      `Titel:         ${preview.book.title}`,
      `Autor:         ${preview.book.author}`,
      `ISBN:          ${preview.book.ean}`,
      `Preis:         ${price}`,
      `Verfügbarkeit: ${preview.book.availability}`,
      `Lieferart:     Abholung (kein Versand)`,
      `Filiale:       ${preview.store.label}`,
      `Zahlung:       vor Ort`,
      `Besteller:     ${preview.orderer.name} / ${preview.orderer.email} / ${preview.orderer.phone}`,
    ].join('\n') +
    '\n```';

  if (Buffer.byteLength(question, 'utf8') > MAX_CARD_BYTES) {
    await notifyAgent(session, 'buchbox_order failed: rendered approval card too large.');
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'buchbox_order',
    // The RESOLVED identity rides in the payload (defaults already merged in)
    // so the approved replay orders exactly what the card showed — the card
    // itself only ever shows masked values.
    payload: {
      isbn: req.isbn,
      first_name: req.firstName,
      last_name: req.lastName,
      email: req.email,
      phone: req.phone,
      // Lets the post-approval notice name the book without another lookup.
      title: preview.book.title,
    },
    title: 'Abholbestellung freigeben',
    question,
  });
}
