/**
 * The default orderer.
 *
 * An agent request may name who is ordering; when it doesn't, the order falls
 * back to the identity configured here. One file serves both callers — the
 * operator CLI reads it directly, and the host reads it for the agent path —
 * so there is a single place to change.
 *
 * Resolution order (first hit wins per field):
 *   1. process env  BUCHBOX_FIRST_NAME / _LAST_NAME / _EMAIL / _PHONE
 *   2. $BUCHBOX_ENV_FILE, else ~/.config/buchbox/env
 *
 * The file lives outside the repo on purpose: it holds personal data, so it
 * must never be committable. Values are read at request time, never cached,
 * and the resolved identity is written verbatim into the approval payload so
 * the card and the eventual order can never disagree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DefaultIdentity {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const KEYS = ['BUCHBOX_FIRST_NAME', 'BUCHBOX_LAST_NAME', 'BUCHBOX_EMAIL', 'BUCHBOX_PHONE'] as const;

export function identityFilePath(): string {
  return process.env.BUCHBOX_ENV_FILE || join(homedir(), '.config', 'buchbox', 'env');
}

/** Minimal KEY=VALUE reader — mirrors the CLI's own parser. */
function readIdentityFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!path || path === '/dev/null' || !existsSync(path)) return values;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable config file just means "no default"
  } catch {
    return values;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if ((KEYS as readonly string[]).includes(key) && !(key in values)) values[key] = value;
  }
  return values;
}

export function resolveDefaultIdentity(): DefaultIdentity {
  const file = readIdentityFile(identityFilePath());
  const pick = (key: (typeof KEYS)[number]): string => (process.env[key] || file[key] || '').trim();
  const first = pick('BUCHBOX_FIRST_NAME');
  const last = pick('BUCHBOX_LAST_NAME');
  return { firstName: first, lastName: last, email: pick('BUCHBOX_EMAIL'), phone: pick('BUCHBOX_PHONE') };
}

/** True when a usable default exists, so callers can say so in an error. */
export function hasDefaultIdentity(): boolean {
  const d = resolveDefaultIdentity();
  return Boolean(d.firstName && d.lastName && d.email && d.phone);
}
