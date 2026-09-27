/**
 * buchbox wiring guards.
 *
 * Behaviour tests through the REAL production barrels: they go red if the
 * modules-barrel import is deleted, if the delivery action or approval handler
 * registration is removed, or if the guard stops holding. Importing this
 * module's own files directly would self-register and stay green — that is a
 * unit test, not a wiring guard.
 */
import { afterEach, describe, expect, it } from 'vitest';

import '../index.js'; // the real modules barrel — must carry the buchbox import

import { getDeliveryAction } from '../../delivery.js';
import { guard } from '../../guard/index.js';
import { listGuardedActions } from '../../guard/guard-actions.js';
import { getApprovalHandler } from '../approvals/primitive.js';
import { SEARCH_LIMIT_MAX } from './client.js';
import { parseOrderRequest } from './request.js';
import { parseSearchRequest } from './search.js';

/** The catalog entry, or a hard failure — never a silently-undefined lookup. */
function catalogEntry() {
  const entry = listGuardedActions().find((spec) => spec.action === 'buchbox.order');
  if (!entry) throw new Error('guard catalog is missing "buchbox.order" — is the modules-barrel import gone?');
  return entry;
}

describe('buchbox module wiring', () => {
  it('the modules barrel registers the buchbox_order delivery action', () => {
    expect(getDeliveryAction('buchbox_order')).toBeDefined();
  });

  it('registers the approve continuation, so a held card can resolve', () => {
    expect(getApprovalHandler('buchbox_order')).toBeDefined();
  });

  it('declares its guard-catalog entry with buchbox_order as the grant name', () => {
    expect(catalogEntry().grantActionName).toBe('buchbox_order');
  });

  it('holds an agent-originated order — an agent can ask, never decide', async () => {
    const decision = await guard(catalogEntry(), {
      actor: { kind: 'agent', agentGroupId: 'g1', sessionId: 's1' },
      payload: { isbn: '9783897948228' },
    });
    expect(decision.effect).toBe('hold');
  });

  it('denies a non-agent actor — the host path is the operator CLI, not this action', async () => {
    const decision = await guard(catalogEntry(), { actor: { kind: 'host' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });

  it('registers the read-only search action alongside the guarded order action', () => {
    expect(getDeliveryAction('buchbox_search')).toBeDefined();
  });

  it('keeps search out of the guard catalog — read-only, nothing to approve', () => {
    const actions = listGuardedActions().map((spec) => spec.action);
    expect(actions).not.toContain('buchbox.search');
    // …while the order action is still guarded, so the two can't be confused.
    expect(actions).toContain('buchbox.order');
  });

  it('search needs no approval continuation, unlike order', () => {
    expect(getApprovalHandler('buchbox_search')).toBeUndefined();
    expect(getApprovalHandler('buchbox_order')).toBeDefined();
  });

  it('registers the cancel action — the escape hatch for the grace window', () => {
    expect(getDeliveryAction('buchbox_cancel_order')).toBeDefined();
    // Cancelling can only prevent an order, so it is deliberately unguarded.
    expect(listGuardedActions().map((s) => s.action)).not.toContain('buchbox.cancel_order');
  });
});

describe('buchbox search request parsing', () => {
  it('rejects a request with no search term at all', () => {
    expect(parseSearchRequest({})).toEqual({ error: expect.stringContaining('required') });
  });

  it('accepts a free-text query and caps the limit', () => {
    const parsed = parseSearchRequest({ query: 'Sansibar', limit: 999 });
    expect(parsed).toEqual({ req: expect.objectContaining({ query: 'Sansibar', limit: SEARCH_LIMIT_MAX }) });
  });

  it('ignores blank strings rather than treating them as a term', () => {
    expect(parseSearchRequest({ query: '   ' })).toEqual({ error: expect.stringContaining('required') });
  });
});

/**
 * The default orderer.
 *
 * An agent normally sends only an ISBN; the host fills the rest from the
 * configured identity. What matters is that the RESOLVED identity is what gets
 * validated and returned, because the caller persists it into the approval
 * payload — so the card and the eventual order can never disagree.
 *
 * Hermetic: driven through process env, never the real ~/.config/buchbox/env.
 */
describe('default orderer resolution', () => {
  const ENV_KEYS = [
    'BUCHBOX_FIRST_NAME',
    'BUCHBOX_LAST_NAME',
    'BUCHBOX_EMAIL',
    'BUCHBOX_PHONE',
    'BUCHBOX_ENV_FILE',
  ] as const;
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function withDefaults(): void {
    // Point at a file that cannot exist so only the env vars below apply.
    process.env.BUCHBOX_ENV_FILE = '/dev/null';
    process.env.BUCHBOX_FIRST_NAME = 'Philipp';
    process.env.BUCHBOX_LAST_NAME = 'Nowakowski';
    process.env.BUCHBOX_EMAIL = 'p.nowakowski@example.com';
    process.env.BUCHBOX_PHONE = '01724272095';
  }

  function withoutDefaults(): void {
    process.env.BUCHBOX_ENV_FILE = '/dev/null';
    for (const k of ['BUCHBOX_FIRST_NAME', 'BUCHBOX_LAST_NAME', 'BUCHBOX_EMAIL', 'BUCHBOX_PHONE'] as const) {
      delete process.env[k];
    }
  }

  it('fills an ISBN-only request from the configured default', () => {
    withDefaults();
    expect(parseOrderRequest({ isbn: '9783897948228' })).toEqual({
      req: {
        isbn: '9783897948228',
        firstName: 'Philipp',
        lastName: 'Nowakowski',
        email: 'p.nowakowski@example.com',
        phone: '01724272095',
      },
    });
  });

  it('lets an explicit request override the default, field by field', () => {
    withDefaults();
    const parsed = parseOrderRequest({ isbn: '9783897948228', first_name: 'Anna', last_name: 'Becker' });
    expect(parsed).toEqual({
      req: expect.objectContaining({
        firstName: 'Anna',
        lastName: 'Becker',
        // untouched fields still come from the default
        email: 'p.nowakowski@example.com',
        phone: '01724272095',
      }),
    });
  });

  it('refuses rather than ordering anonymously when no default is configured', () => {
    withoutDefaults();
    expect(parseOrderRequest({ isbn: '9783897948228' })).toEqual({
      error: expect.stringContaining('no default orderer is configured'),
    });
  });

  it('still rejects a malformed override even when a default exists', () => {
    withDefaults();
    expect(parseOrderRequest({ isbn: '9783897948228', email: 'not-an-email' })).toEqual({
      error: expect.stringContaining('e-mail'),
    });
  });

  it('still requires a valid ISBN — the default never supplies one', () => {
    withDefaults();
    expect(parseOrderRequest({})).toEqual({ error: expect.stringContaining('isbn') });
  });
});
