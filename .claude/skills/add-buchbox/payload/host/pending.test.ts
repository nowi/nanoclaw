/**
 * The grace window is the safety net behind a one-tap 👍 approval, so its
 * timing behaviour is covered directly: nothing may reach the shop before the
 * window elapses, a cancellation must prevent the order entirely, and a second
 * approval must not leave two timers racing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GRACE_MS, cancelOrder, scheduleOrder, secondsRemaining } from './pending.js';
import type { BuchboxOrderRequest } from './client.js';

const REQ: BuchboxOrderRequest = {
  isbn: '9783897948228',
  firstName: 'Philipp',
  lastName: 'Nowakowski',
  email: 'p@example.com',
  phone: '01724272095',
};

// Only the two fields pending.ts touches.
const session = (id: string) => ({ id, agent_group_id: 'ag-1' }) as never;

describe('buchbox order grace window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelOrder('s1');
    cancelOrder('s2');
    vi.useRealTimers();
  });

  it('places nothing before the window elapses', () => {
    const place = vi.fn().mockResolvedValue(undefined);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'Sansibar', approvalId: 'a1', place });

    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(place).not.toHaveBeenCalled();
  });

  it('places the order once the window elapses', () => {
    const place = vi.fn().mockResolvedValue(undefined);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'Sansibar', approvalId: 'a1', place });

    vi.advanceTimersByTime(GRACE_MS);
    expect(place).toHaveBeenCalledTimes(1);
  });

  it('a cancellation inside the window prevents the order entirely', () => {
    const place = vi.fn().mockResolvedValue(undefined);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'Sansibar', approvalId: 'a1', place });

    vi.advanceTimersByTime(30_000);
    expect(cancelOrder('s1')).toEqual({ cancelled: true, title: 'Sansibar' });

    // Well past the original deadline — the timer must be gone, not merely late.
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(place).not.toHaveBeenCalled();
  });

  it('reports honestly when there is nothing to cancel', () => {
    expect(cancelOrder('s1')).toEqual({ cancelled: false, reason: expect.stringContaining('no order') });
  });

  it('cancelling after the window cannot un-place the order', () => {
    const place = vi.fn().mockResolvedValue(undefined);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'Sansibar', approvalId: 'a1', place });

    vi.advanceTimersByTime(GRACE_MS);
    expect(place).toHaveBeenCalledTimes(1);
    // The agent must be told it was too late rather than getting a false "cancelled".
    expect(cancelOrder('s1').cancelled).toBe(false);
  });

  it('a second approval supersedes the first instead of racing it', () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'First', approvalId: 'a1', place: first });
    vi.advanceTimersByTime(60_000);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'Second', approvalId: 'a2', place: second });

    vi.advanceTimersByTime(GRACE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps sessions independent', () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    scheduleOrder({ session: session('s1'), req: REQ, title: 'A', approvalId: 'a1', place: a });
    scheduleOrder({ session: session('s2'), req: REQ, title: 'B', approvalId: 'a2', place: b });

    cancelOrder('s1');
    vi.advanceTimersByTime(GRACE_MS);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('counts down the remaining seconds while pending', () => {
    scheduleOrder({
      session: session('s1'),
      req: REQ,
      title: 'Sansibar',
      approvalId: 'a1',
      place: vi.fn().mockResolvedValue(undefined),
    });
    expect(secondsRemaining('s1')).toBe(120);
    vi.advanceTimersByTime(90_000);
    expect(secondsRemaining('s1')).toBe(30);
    expect(secondsRemaining('nope')).toBeUndefined();
  });
});
