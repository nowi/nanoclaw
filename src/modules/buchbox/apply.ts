/**
 * The approved side of an agent-initiated pickup order.
 *
 * Runs only on `allow` — i.e. on an approved replay, after the guard re-ran its
 * checks live (see ./guard.ts). Approval no longer places the order directly:
 * it opens a grace window (./pending.ts), tells the agent to say so, and places
 * the order when the window elapses without an objection. Approval is still the
 * hard gate; the window exists because an approval can be a single tap on a 👍.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { BuchboxCliError, executeOrder, type BuchboxOrderRequest } from './client.js';
import { GRACE_MS, scheduleOrder } from './pending.js';
import { parseOrderRequest } from './request.js';

async function placeOrder(session: Session, req: BuchboxOrderRequest, approvalId: string): Promise<void> {
  try {
    const result = await executeOrder(req, approvalId);
    if (!result.sent) {
      await notifyAgent(session, 'buchbox_order: the shop did not confirm the order — please check manually.');
      return;
    }
    log.info('buchbox_order placed', { ean: result.book.ean, store: result.store.store_id });
    await notifyAgent(
      session,
      `Abholbestellung aufgegeben: "${result.book.title}" (${result.book.ean}), ` +
        `${result.book.price_text} — Abholung bei ${result.store.label}. ` +
        'Sag dem Nutzer, dass die Bestätigungs-E-Mail unterwegs ist.',
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- an order failure is reported to the requester, never rethrown into delivery
  } catch (err) {
    const reason = err instanceof BuchboxCliError ? err.message : String(err);
    log.warn('buchbox_order failed', { reason });
    await notifyAgent(session, `buchbox_order failed: ${reason}`);
  }
}

export async function applyBuchboxOrder(content: Record<string, unknown>, session: Session): Promise<void> {
  const parsed = parseOrderRequest(content);
  if ('error' in parsed) {
    await notifyAgent(session, `buchbox_order failed: ${parsed.error}.`);
    return;
  }
  const approvalId = typeof content.__approval_id === 'string' ? content.__approval_id : 'approved';
  // Carried on the approval payload so the notice can name the book without
  // spending another request on the shop.
  const title = typeof content.title === 'string' && content.title ? content.title : parsed.req.isbn;

  scheduleOrder({
    session,
    req: parsed.req,
    title,
    approvalId,
    place: () => placeOrder(session, parsed.req, approvalId),
  });

  // A relative window, not a clock time: it is two minutes, and an absolute
  // timestamp would need the group's timezone for no added clarity.
  const minutes = Math.round(GRACE_MS / 60_000);
  await notifyAgent(
    session,
    `Freigabe erhalten für "${title}". Die Bestellung geht in ${minutes} Minuten raus. ` +
      'Sag das dem Nutzer und bitte ihn, sich zu melden, wenn er es sich anders überlegt. ' +
      'Widerspricht er — egal in welchen Worten — ruf sofort buchbox_cancel_order auf.',
  );
}
