import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-upgrade-state' };
});

// Real desktop notifications must not pop up during a test run.
vi.mock('./host-status.js', async () => {
  const actual = await vi.importActual<typeof import('./host-status.js')>('./host-status.js');
  return { ...actual, notifyOperator: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-upgrade-state';

import { notifyOperator, readHostStatus } from './host-status.js';
import {
  checkLocalCommits,
  currentUpgradeState,
  enforceUpgradeTripwire,
  getCodeIdentity,
  getCodeVersion,
  isUpgradeCurrent,
  markerPath,
  readUpgradeState,
  writeUpgradeState,
} from './upgrade-state.js';

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('upgrade-state', () => {
  it('getCodeVersion reads the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(getCodeVersion()).toBe(pkg.version);
  });

  it('readUpgradeState returns null when the marker is absent', () => {
    expect(readUpgradeState()).toBeNull();
  });

  it('write then read round-trips, with version/commit/tree/via/updatedAt', () => {
    const written = writeUpgradeState({ version: '9.9.9', via: 'test' });
    expect(written).toMatchObject({ version: '9.9.9', via: 'test' });
    expect(written.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(written.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(written.updatedAt).toBeTruthy();
    expect(readUpgradeState()).toEqual(written);
  });

  it('write defaults the version to the code version', () => {
    expect(writeUpgradeState({ via: 'test' }).version).toBe(getCodeVersion());
  });

  it('binds the marker to the exact Git commit and tree', () => {
    expect(writeUpgradeState({ via: 'test' })).toMatchObject(getCodeIdentity());
  });

  it('can stamp and validate a recovery marker when Git is unavailable', () => {
    const projectRoot = fs.mkdtempSync('/tmp/nanoclaw-no-git-');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    try {
      expect(getCodeIdentity(projectRoot)).toEqual({ version: '1.2.3', commit: 'unknown', tree: 'unknown' });
      expect(writeUpgradeState({ via: 'recovery', projectRoot })).toMatchObject({
        version: '1.2.3',
        commit: 'unknown',
        tree: 'unknown',
      });
      expect(isUpgradeCurrent(projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('isUpgradeCurrent: false when absent, false on mismatch, true on match', () => {
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    expect(isUpgradeCurrent()).toBe(true);
  });

  it('rejects a legacy version-only marker even when the package version matches', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_DIR, 'upgrade-state.json'),
      JSON.stringify({ version: getCodeVersion(), updatedAt: new Date().toISOString(), via: 'legacy' }),
    );
    expect(isUpgradeCurrent()).toBe(false);
  });

  it('treats a corrupt marker as absent (fails closed, never throws)', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'upgrade-state.json'), '{ this is not json');
    expect(() => readUpgradeState()).not.toThrow();
    expect(readUpgradeState()).toBeNull();
    expect(isUpgradeCurrent()).toBe(false);
  });

  it('markerPath is upgrade-state.json under the data dir', () => {
    expect(markerPath()).toBe(path.join(TEST_DIR, 'upgrade-state.json'));
    expect(markerPath('/srv/nanoclaw')).toBe(path.join('/srv/nanoclaw', 'data', 'upgrade-state.json'));
  });

  it('currentUpgradeState returns the marker only while it matches the checkout', () => {
    expect(currentUpgradeState()).toBeNull();
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(currentUpgradeState()).toBeNull();
    const written = writeUpgradeState({ via: 'update-nanoclaw', channel: 'stable', ref: 'refs/tags/v1' });
    expect(currentUpgradeState()).toEqual(written);
    expect(written).toMatchObject({ channel: 'stable', ref: 'refs/tags/v1' });
  });

  it('enforceUpgradeTripwire exits when not current and passes when current', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // No marker → trips.
    expect(() => enforceUpgradeTripwire()).toThrow('exit:1');

    // Stale marker → trips.
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(() => enforceUpgradeTripwire()).toThrow('exit:1');

    // Matching marker → passes.
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    expect(() => enforceUpgradeTripwire()).not.toThrow();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('git-less runtimes', () => {
  const GITLESS = path.join(TEST_DIR, 'gitless-checkout');

  function gitlessCheckout(version: string): string {
    fs.mkdirSync(GITLESS, { recursive: true });
    fs.writeFileSync(path.join(GITLESS, 'package.json'), JSON.stringify({ version }));
    return GITLESS;
  }

  function writeMarker(marker: Record<string, string>, projectRoot?: string): void {
    fs.mkdirSync(path.dirname(markerPath(projectRoot)), { recursive: true });
    fs.writeFileSync(
      markerPath(projectRoot),
      JSON.stringify({ updatedAt: new Date().toISOString(), via: 'update', ...marker }),
    );
  }

  it('accepts a version-matching marker when Git cannot identify the checkout', () => {
    writeMarker({ version: '9.9.9', commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, GITLESS);
    expect(isUpgradeCurrent(gitlessCheckout('9.9.9'))).toBe(true);
  });

  it('still trips on a version mismatch when Git is unavailable', () => {
    writeMarker({ version: '1.0.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, GITLESS);
    expect(isUpgradeCurrent(gitlessCheckout('9.9.9'))).toBe(false);
  });

  it('a marker recorded without Git still trips where Git identifies the checkout', () => {
    writeMarker({ version: getCodeVersion(), commit: 'unknown', tree: 'unknown' });
    expect(isUpgradeCurrent()).toBe(false);
  });
});

describe('local commits', () => {
  let root: string;

  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

  function commitFile(file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', `change ${file}`);
  }

  function expectTrip(): void {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => enforceUpgradeTripwire(root)).toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  // A stamped checkout whose official remote has seen the stamped commit.
  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/nanoclaw-local-commits-');
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, '.gitignore'), 'data/\n');
    commitFile('package.json', JSON.stringify({ version: '1.0.0' }));
    git('remote', 'add', 'upstream', 'https://github.com/nanocoai/nanoclaw.git');
    git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
    writeUpgradeState({ via: 'test', channel: 'stable', ref: 'refs/tags/v1.0.0', projectRoot: root });
    vi.mocked(notifyOperator).mockClear();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts a local commit and re-stamps the marker to it, keeping channel and ref', () => {
    commitFile('tools/gateway.mjs', 'export {};\n');
    expect(checkLocalCommits(root)).toMatchObject({ local: true });

    expect(() => enforceUpgradeTripwire(root)).not.toThrow();
    expect(readUpgradeState(root)).toMatchObject({
      commit: git('rev-parse', 'HEAD'),
      via: 'local-commit',
      channel: 'stable',
      ref: 'refs/tags/v1.0.0',
    });
    expect(isUpgradeCurrent(root)).toBe(true);
  });

  it('finds the official remote by URL when it is not named upstream', () => {
    git('remote', 'rename', 'upstream', 'origin');
    git('remote', 'set-url', 'origin', 'https://github.com/qwibitai/NanoClaw.git');
    commitFile('tools/gateway.mjs', 'export {};\n');
    expect(checkLocalCommits(root)).toMatchObject({ local: true });
  });

  it('trips on a commit that touches a gated path', () => {
    commitFile('src/db/migrations/099-local.ts', 'export {};\n');
    expect(checkLocalCommits(root)).toEqual({ local: false, reason: 'they change src/db/migrations/099-local.ts' });
    expectTrip();
  });

  it('trips on commits that come from the official remote', () => {
    commitFile('src/router.ts', 'export {};\n');
    git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
    expect(checkLocalCommits(root)).toEqual({ local: false, reason: '1 commit(s) come from upstream' });
  });

  it('trips on a merge', () => {
    git('checkout', '-q', '-b', 'side');
    commitFile('tools/side.mjs', 'export {};\n');
    git('checkout', '-q', 'main');
    commitFile('tools/main.mjs', 'export {};\n');
    git('merge', '-q', '--no-ff', '--no-edit', '--no-verify', 'side');
    expect(checkLocalCommits(root)).toEqual({ local: false, reason: 'a merge brought in other history' });
  });

  it('trips when the recorded commit was rewritten away', () => {
    commitFile('tools/gateway.mjs', 'export {};\n');
    writeUpgradeState({ via: 'test', projectRoot: root });
    git('commit', '-q', '--amend', '--no-verify', '-m', 'reworded');
    expect(checkLocalCommits(root)).toMatchObject({ local: false, reason: expect.stringContaining('not an ancestor') });
  });

  it('trips when there is no official remote to compare against', () => {
    git('remote', 'remove', 'upstream');
    commitFile('tools/gateway.mjs', 'export {};\n');
    expect(checkLocalCommits(root)).toMatchObject({ local: false, reason: expect.stringContaining('no official') });
  });

  it('notifies once per stop and leaves the host status blocked', () => {
    commitFile('package.json', JSON.stringify({ version: '1.0.1' }));
    expectTrip();
    expectTrip();
    expect(notifyOperator).toHaveBeenCalledTimes(1);
    expect(readHostStatus()).toMatchObject({ state: 'blocked', reason: 'upgrade check' });
  });
});
