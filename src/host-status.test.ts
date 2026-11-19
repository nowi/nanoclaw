import fs from 'fs';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-test-host-status' }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { clearHostStatus, readHostStatus, writeHostStatus } from './host-status.js';

beforeEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('host-status', () => {
  it('reads null when no status was written', () => {
    expect(readHostStatus()).toBeNull();
  });

  it('records the state, reason and this process', () => {
    writeHostStatus('blocked', 'upgrade check');
    expect(readHostStatus()).toMatchObject({ state: 'blocked', reason: 'upgrade check', pid: process.pid });
  });

  it('a later state replaces the earlier one', () => {
    writeHostStatus('blocked', 'upgrade check');
    writeHostStatus('running');
    expect(readHostStatus()).toMatchObject({ state: 'running' });
    expect(readHostStatus()?.reason).toBeUndefined();
  });

  it('clear removes the file, and is a no-op when it is already gone', () => {
    writeHostStatus('running');
    clearHostStatus();
    expect(readHostStatus()).toBeNull();
    expect(() => clearHostStatus()).not.toThrow();
  });
});
