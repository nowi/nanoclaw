/**
 * Host status file — a file-based answer to "is the host actually serving?"
 * for readers that can't speak the ncl socket (the macOS menu-bar app).
 *
 * A live process is not enough: during a circuit-breaker backoff or an
 * upgrade-tripwire stop the process exists but serves nothing. The states:
 *
 *   blocked  — a startup gate refused to run. Persists across the breaker's
 *              retries until a start gets past the gate.
 *   starting — past the startup gates, not serving yet.
 *   running  — serving. Trust it only while `pid` is the live process.
 *
 * The file is removed on clean shutdown.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export type HostState = 'blocked' | 'starting' | 'running';

export interface HostStatus {
  state: HostState;
  pid: number;
  reason?: string;
  updatedAt: string;
}

const STATUS_PATH = path.join(DATA_DIR, 'host-status.json');

export function readHostStatus(): HostStatus | null {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as HostStatus;
  } catch {
    return null;
  }
}

/** Never throws — a status file must not stop the host from starting. */
export function writeHostStatus(state: HostState, reason?: string): void {
  const status: HostStatus = { state, pid: process.pid, reason, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  } catch (err) {
    log.warn('Could not write host status', { path: STATUS_PATH, err: String(err) });
  }
}

export function clearHostStatus(): void {
  try {
    fs.unlinkSync(STATUS_PATH);
  } catch {
    // Already absent.
  }
}

/**
 * Best-effort desktop notification for a host that stopped serving. macOS
 * only (osascript); elsewhere the log line is the signal. Never throws.
 */
export function notifyOperator(title: string, message: string): void {
  if (process.platform !== 'darwin') return;
  try {
    // Pass the text as argv so quotes in it can't break the script.
    execFileSync(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        title,
        message,
      ],
      { stdio: 'ignore', timeout: 5000 },
    );
  } catch (err) {
    log.warn('Desktop notification failed', { title, err: String(err) });
  }
}
