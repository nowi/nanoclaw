/**
 * The grace window between approval and the order actually going out.
 *
 * Approving does not place the order any more: it schedules it. The agent is
 * told to say so, and any objection during the window cancels it before a
 * single request reaches the shop. Approval stays the hard gate — this only
 * adds a second chance to change your mind, which matters because the approval
 * can now be a single tap on a 👍 reaction.
 *
 * Deliberately in-memory: a host restart during the window drops the timer and
 * the order is simply never placed. That is the safe direction — the failure
 * mode is "nothing was ordered", never a surprise order after a restart.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { BuchboxOrderRequest } from './client.js';

export const GRACE_MS = 120_000;

interface PendingOrder {
  req: BuchboxOrderRequest;
  title: string;
  approvalId: string;
  dueAt: number;
  timer: NodeJS.Timeout;
}

/** One pending order per session — a second approval supersedes the first. */
const pending = new Map<string, PendingOrder>();

export interface ScheduleArgs {
  session: Session;
  req: BuchboxOrderRequest;
  title: string;
  approvalId: string;
  /** Runs when the window elapses without a cancellation. */
  place: () => Promise<void>;
}

export function scheduleOrder({ session, req, title, approvalId, place }: ScheduleArgs): { dueAt: number } {
  // A fresh approval for the same session replaces any earlier pending order
  // rather than racing it.
  cancelOrder(session.id);

  const dueAt = Date.now() + GRACE_MS;
  const timer = setTimeout(() => {
    pending.delete(session.id);
    void place().catch((err: unknown) => {
      log.error('buchbox pending order failed to place', { approvalId, err });
    });
  }, GRACE_MS);

  pending.set(session.id, { req, title, approvalId, dueAt, timer });
  log.info('buchbox order scheduled after approval', { approvalId, sessionId: session.id, graceMs: GRACE_MS });
  return { dueAt };
}

export interface CancelResult {
  cancelled: boolean;
  title?: string;
  reason?: string;
}

export function cancelOrder(sessionId: string): CancelResult {
  const entry = pending.get(sessionId);
  if (!entry) return { cancelled: false, reason: 'no order is waiting to be placed' };
  clearTimeout(entry.timer);
  pending.delete(sessionId);
  log.info('buchbox pending order cancelled', { approvalId: entry.approvalId, sessionId });
  return { cancelled: true, title: entry.title };
}

/** Seconds left in the window, for a human-readable message. */
export function secondsRemaining(sessionId: string): number | undefined {
  const entry = pending.get(sessionId);
  return entry ? Math.max(Math.round((entry.dueAt - Date.now()) / 1000), 0) : undefined;
}
