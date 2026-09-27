/**
 * buchbox module — catalogue search plus admin-approved pickup orders at
 * BUCHBOX! Berlin.
 *
 * Optional tier. Depends on the approvals default module for the request/
 * handler plumbing and on the guard for the decision. On install it registers:
 *   - Its guard-catalog entry (./guard.ts): unconditional hold from the
 *     container path.
 *   - One guard-wrapped delivery action (buchbox_order): validation runs as the
 *     wrapper's precheck, the hold builder resolves the article via a dry run
 *     and cards the admin with the real title/price/branch, and the handler
 *     body (./apply.ts) runs only on allow — i.e. on an approved replay.
 *   - The approve continuation that re-enters the wrapped action with the
 *     approval row as the grant.
 *
 *   - Two unguarded request/response actions, both answered inline over the
 *     same transport `ncl` uses: buchbox_search (read-only lookup) and
 *     buchbox_cancel_order (aborts an approved order inside its grace window —
 *     it can only prevent a request, never cause one).
 *
 * Approval opens a 2-minute grace window rather than ordering outright
 * (./pending.ts), so a mistapped 👍 can still be taken back.
 *
 * Without this module: the MCP tools in the container still write outbound
 * system messages, but delivery logs "Unknown system action" and drops them.
 * No card, no order, and search requests time out.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyBuchboxOrder } from './apply.js';
import { buchboxOrder } from './guard.js';
import { requestBuchboxOrderHold, validateBuchboxOrder } from './request.js';
import { handleBuchboxCancel } from './cancel.js';
import { handleBuchboxSearch } from './search.js';

registerDeliveryAction('buchbox_order', applyBuchboxOrder, {
  guardAction: buchboxOrder,
  precheck: validateBuchboxOrder,
  requestHold: requestBuchboxOrderHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `buchbox_order denied: ${reason}`),
});

registerApprovalHandler('buchbox_order', reenterGuardedDeliveryAction('buchbox_order'));

registerDeliveryAction(
  'buchbox_search',
  handleBuchboxSearch,
  unguarded('read-only catalogue lookup — no money, no personal data, nothing to approve'),
);

registerDeliveryAction(
  'buchbox_cancel_order',
  handleBuchboxCancel,
  unguarded('can only prevent an order, never cause one — safe in the cancelling direction'),
);
