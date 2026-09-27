/**
 * buchbox guard adapter — the module's catalog entry, composed at the module
 * edge (imported by ./index.ts).
 *
 * Placing a pickup order spends the operator's money and puts their name and
 * e-mail into a third party's system, so from the container path it is held
 * unconditionally for the agent group's admin chain. There is no
 * configuration that turns the hold off: an agent can always *ask*, never
 * decide. Host-originated ordering is the operator running the CLI, which has
 * its own terminal y/N and never reaches this guard.
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

export const buchboxOrder = defineGuardedAction({
  action: 'buchbox.order',
  grantActionName: 'buchbox_order',
  decide: (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY('buchbox_order is a container-originated action.');
    }
    return HOLD('placing a paid pickup order always requires admin approval');
  },
});
