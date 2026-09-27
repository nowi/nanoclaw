/**
 * Cancelling an order inside its grace window.
 *
 * The agent is the natural place for this: the operator "shouts" in whatever
 * words they like, the agent recognises it and calls buchbox_cancel_order.
 * Cancelling is always safe — it can only prevent a request, never cause one —
 * so it is unguarded and answered inline over the same transport as search.
 */
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelOrder } from './pending.js';

type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

async function respond(session: Session, requestId: string, frame: ResponseFrame): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `buchbox-cancel-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ type: 'cli_response', requestId, frame }),
    trigger: false,
  });
}

export async function handleBuchboxCancel(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  if (!requestId) {
    log.warn('buchbox_cancel_order missing requestId', { sessionId: session.id });
    return;
  }
  const result = cancelOrder(session.id);
  await respond(session, requestId, { id: requestId, ok: true, data: result });
}
