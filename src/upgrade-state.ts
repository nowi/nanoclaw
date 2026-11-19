/**
 * Upgrade marker — the record that an install reached its current version
 * through a sanctioned path (setup / `/update-nanoclaw` / `/migrate-nanoclaw`).
 *
 * The startup tripwire (enforceUpgradeTripwire) refuses to run if the marker
 * is missing or its version doesn't match the running code — i.e. if the
 * install was updated by a raw `git pull` instead of the supported flow.
 *
 * The marker lives in `data/` (gitignored), so a `git pull` can't touch it.
 * Only the sanctioned paths call writeUpgradeState(), plus the tripwire
 * itself when what changed is only the operator's own local commits;
 * clearing the tripwire by hand is the same `set` — see
 * docs/upgrade-recovery.md. Setup's own local commits
 * (setup/lib/setup-commit.ts) carry a current marker forward.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { DATA_DIR } from './config.js';
import { notifyOperator, readHostStatus, writeHostStatus } from './host-status.js';
import { log } from './log.js';

export interface UpgradeState {
  version: string;
  commit: string;
  tree: string;
  updatedAt: string;
  via: string;
  /** Update channel and ref the updater merged; absent for setup and older stamps. */
  channel?: string;
  ref?: string;
}

export interface CodeIdentity {
  version: string;
  commit: string;
  tree: string;
}

const MARKER_PATH = path.join(DATA_DIR, 'upgrade-state.json');
const FIX_COMMAND = 'pnpm exec tsx scripts/upgrade-state.ts set';

/**
 * Paths whose change needs work only the sanctioned flow does — a migration
 * to run, dependencies to install, an image to rebuild. A local commit that
 * touches one still trips. A trailing slash means "anything under".
 */
const GATED_PATHS = [
  'src/db/migrations/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'container/Dockerfile',
  'container/agent-runner/package.json',
  'container/agent-runner/bun.lock',
];

/** Same rule /update-nanoclaw uses to find the official remote, plus the pre-rename owner. */
const OFFICIAL_REPO_URL = /(^|[:/])(nanocoai|qwibitai)\/nanoclaw(\.git)?$/i;

/** Version the running code declares, read from package.json. */
export function getCodeVersion(projectRoot: string = process.cwd()): string {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`No version field in ${pkgPath}`);
  return pkg.version;
}

/** Git identity of the exact checkout the host is about to run. */
export function getCodeIdentity(projectRoot: string = process.cwd()): CodeIdentity {
  const git = (rev: string): string =>
    execFileSync('git', ['rev-parse', '--verify', rev], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  const version = getCodeVersion(projectRoot);
  try {
    return { version, commit: git('HEAD'), tree: git('HEAD^{tree}') };
  } catch {
    return { version, commit: 'unknown', tree: 'unknown' };
  }
}

/**
 * Read the upgrade marker, or null if it's absent, unreadable, or corrupt.
 * Never throws — a boot gate must fail closed (treat anything it can't trust
 * as "no valid marker" → trip), not crash with a stack trace.
 */
export function readUpgradeState(projectRoot?: string): UpgradeState | null {
  const marker = markerPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(marker, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn('Could not read upgrade marker; treating as absent', { path: marker, err: String(e) });
    return null;
  }
  try {
    return JSON.parse(raw) as UpgradeState;
  } catch {
    log.warn('Upgrade marker is corrupt; treating as absent', { path: marker });
    return null;
  }
}

/**
 * Stamp the marker. Only the sanctioned paths (setup / update / migrate)
 * call this on success; `version` defaults to the current code version.
 */
export function writeUpgradeState(opts: {
  version?: string;
  via: string;
  channel?: string;
  ref?: string;
  projectRoot?: string;
}): UpgradeState {
  const identity = getCodeIdentity(opts.projectRoot);
  const state: UpgradeState = {
    ...identity,
    version: opts.version ?? identity.version,
    updatedAt: new Date().toISOString(),
    via: opts.via,
  };
  if (opts.channel !== undefined) state.channel = opts.channel;
  if (opts.ref !== undefined) state.ref = opts.ref;
  const marker = markerPath(opts.projectRoot);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify(state, null, 2) + '\n');
  return state;
}

/** The marker when it matches the checkout exactly, else null. */
export function currentUpgradeState(projectRoot?: string): UpgradeState | null {
  return isUpgradeCurrent(projectRoot) ? readUpgradeState(projectRoot) : null;
}

/** True when the marker exists and matches the exact running checkout. */
export function isUpgradeCurrent(projectRoot?: string): boolean {
  const state = readUpgradeState(projectRoot);
  if (state === null) return false;
  try {
    const code = getCodeIdentity(projectRoot);
    if (state.version !== code.version) return false;
    if (code.commit === 'unknown' || code.tree === 'unknown') {
      // Git cannot identify this checkout (no git binary, or a tree
      // exported/mounted without .git). Commit and tree cannot strengthen
      // the check here — the sanctioned recovery path in this world records
      // 'unknown' for both — so the version match is the whole signal.
      // Accept it, loudly, rather than making the tripwire a permanent
      // boot-stop wherever Git is absent.
      log.warn('Upgrade marker accepted on version match alone — Git cannot identify this checkout', {
        version: code.version,
      });
      return true;
    }
    return state.commit === code.commit && state.tree === code.tree;
  } catch (err) {
    log.warn('Could not resolve running code identity; upgrade marker fails closed', {
      err: String(err),
    });
    return false;
  }
}

/** Absolute path to the marker file: this process's data dir, or `<projectRoot>/data`. */
export function markerPath(projectRoot?: string): string {
  return projectRoot === undefined ? MARKER_PATH : path.join(projectRoot, 'data', 'upgrade-state.json');
}

export type LocalCommitCheck =
  | { local: true; commits: string[]; recorded: UpgradeState }
  | { local: false; reason: string };

/**
 * Whether everything since the recorded marker is the operator's own
 * customization rather than an update that skipped the sanctioned flow:
 * linear commits on top of the recorded checkout, at the same version, none
 * of them from the official remote, touching no gated path. Anything it
 * cannot verify counts as not local — the tripwire still fails closed.
 */
export function checkLocalCommits(projectRoot?: string): LocalCommitCheck {
  const recorded = readUpgradeState(projectRoot);
  if (recorded === null) return { local: false, reason: 'there is no upgrade marker' };

  const cwd = projectRoot ?? process.cwd();
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const lines = (out: string): string[] => out.split('\n').filter(Boolean);

  try {
    const code = getCodeIdentity(projectRoot);
    if (code.commit === 'unknown') return { local: false, reason: 'Git cannot identify this checkout' };
    if (recorded.version !== code.version) {
      return { local: false, reason: `the version changed (${recorded.version} → ${code.version})` };
    }
    try {
      git('merge-base', '--is-ancestor', recorded.commit, 'HEAD');
    } catch {
      return { local: false, reason: 'the recorded commit is not an ancestor of HEAD (rebased or reset)' };
    }

    const range = `${recorded.commit}..HEAD`;
    const commits = lines(git('rev-list', range));
    if (commits.length === 0) return { local: false, reason: 'the marker does not match this commit' };
    if (git('rev-list', '--merges', range)) return { local: false, reason: 'a merge brought in other history' };

    const remotes = lines(git('remote'));
    const upstream = remotes.includes('upstream')
      ? 'upstream'
      : remotes.find((r) => OFFICIAL_REPO_URL.test(git('remote', 'get-url', r)));
    if (!upstream) return { local: false, reason: 'no official remote to tell local commits apart from updates' };
    if (!git('for-each-ref', '--count=1', `refs/remotes/${upstream}`)) {
      return { local: false, reason: `remote ${upstream} has never been fetched` };
    }
    const notUpstream = lines(git('rev-list', range, '--not', `--remotes=${upstream}`));
    if (notUpstream.length !== commits.length) {
      return { local: false, reason: `${commits.length - notUpstream.length} commit(s) come from ${upstream}` };
    }

    const gated = lines(git('diff', '--name-only', range)).filter((file) =>
      GATED_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)),
    );
    if (gated.length > 0) return { local: false, reason: `they change ${gated.join(', ')}` };

    return { local: true, commits, recorded };
  } catch (err) {
    return { local: false, reason: `the commits could not be inspected (${String(err)})` };
  }
}

/**
 * Startup gate. If the install didn't reach the current version through a
 * sanctioned path, stop with a message written for the coding agent that
 * just ran the upgrade to act on automatically. The operator's own local
 * commits (see checkLocalCommits) are accepted and stamped instead.
 */
export function enforceUpgradeTripwire(projectRoot?: string): void {
  if (isUpgradeCurrent(projectRoot)) return;

  const localCheck = checkLocalCommits(projectRoot);
  if (localCheck.local) {
    // Same carry-forward as setup's own commits: keep the channel and ref.
    const { channel, ref } = localCheck.recorded;
    const state = writeUpgradeState({ via: 'local-commit', channel, ref, projectRoot });
    log.warn('Upgrade tripwire: accepted local commits and re-stamped the marker', {
      commits: localCheck.commits.length,
      commit: state.commit,
    });
    return;
  }

  const code = getCodeIdentity(projectRoot);
  const recorded = readUpgradeState(projectRoot);
  const gitUnavailable = code.commit === 'unknown' || code.tree === 'unknown';
  const exactCheckoutChanged =
    recorded !== null &&
    recorded.version === code.version &&
    (recorded.commit !== code.commit || recorded.tree !== code.tree);
  const humanGuidance = gitUnavailable
    ? [
        'Git could not identify this checkout. Restore Git access, then run',
        '/update-nanoclaw. If a supported update already completed, the coding',
        `agent can use the recovery command below even while Git is unavailable.`,
      ]
    : exactCheckoutChanged
      ? [
          'The code changed without a matching update record. This can happen',
          'after pulling upstream changes or committing a local customization.',
          'Run /update-nanoclaw for upstream changes. For an intentional local',
          'commit, follow the local-customization steps in the recovery guide.',
          `Not accepted as a local commit because ${localCheck.reason}.`,
        ]
      : [
          "You most likely ran `git pull` directly. Don't fix this by hand —",
          'open Claude Code in this folder and run /update-nanoclaw, which',
          'repairs the install and clears this stop.',
        ];

  console.error(
    [
      '',
      '='.repeat(64),
      'NanoClaw stopped: update did not go through the supported path',
      '='.repeat(64),
      'This install was updated outside the sanctioned upgrade flow',
      '(no upgrade marker, or its version/commit/tree does not match the code).',
      '',
      `  code version:     ${code?.version ?? 'unknown'}`,
      `  code commit:      ${code?.commit ?? 'unknown'}`,
      `  recorded version: ${recorded?.version ?? 'none'}`,
      `  recorded commit:  ${recorded?.commit ?? 'none'}`,
      '',
      "IF YOU'RE A HUMAN:",
      ...humanGuidance,
      '',
      'CODING AGENT: if you just ran /update-nanoclaw, /migrate-nanoclaw, or',
      'setup and it completed successfully, clear this automatically by running:',
      '',
      `  ${FIX_COMMAND}`,
      '',
      'then restart NanoClaw. If the upgrade did NOT complete, stop and',
      'investigate instead of clearing.',
      '',
      'Details: docs/upgrade-recovery.md',
      '='.repeat(64),
      '',
    ].join('\n'),
  );
  log.error('Upgrade tripwire: install not on the sanctioned path', { code, recorded, notLocal: localCheck.reason });
  // Once per stop, not on every circuit-breaker retry.
  if (readHostStatus()?.state !== 'blocked') {
    notifyOperator('NanoClaw stopped', 'Startup blocked by the upgrade check. See logs/nanoclaw.error.log.');
  }
  writeHostStatus('blocked', 'upgrade check');
  process.exit(1);
}
