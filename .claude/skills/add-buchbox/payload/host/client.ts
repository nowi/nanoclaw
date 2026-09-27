/**
 * Thin host-side wrapper around the buchbox Python CLI.
 *
 * The CLI is the single implementation of the shop protocol; this module only
 * spawns it and parses its `--json` envelope. Two calls:
 *   - previewOrder  → dry run, resolves title/price/availability/branch so the
 *                     approval card can state exactly what would be ordered.
 *   - executeOrder  → the approved replay, carrying the approval id so the CLI
 *                     skips its terminal y/N (the human already decided on the
 *                     card).
 *
 * Personal data (name, e-mail, phone) is passed through the child's ENV, never
 * argv — argv is world-readable via `ps`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** src/modules/buchbox/client.ts → repo root */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT_DIR = join(REPO_ROOT, 'scripts', 'buchbox');
const SCRIPT = join(SCRIPT_DIR, 'buchbox.py');

const EXECUTE_TIMEOUT_MS = 180_000;

export interface BuchboxOrderRequest {
  isbn: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  storeMatch?: string;
}

export interface BuchboxBook {
  ean: string;
  title: string;
  subtitle: string;
  author: string;
  publisher: string;
  category?: string;
  published?: string;
  binding?: string;
  price: number | null;
  price_text: string;
  availability: string;
  availability_schema?: string;
  url: string;
  /** The shop says "Erscheint am <date>" — not published yet. */
  is_preorder?: boolean;
  /** False when the shop offers no Abholbestellung for this article. */
  pickup_available?: boolean;
}

export interface BuchboxSearchRequest {
  query?: string;
  isbn?: string;
  author?: string;
  publisher?: string;
  limit?: number;
  availability?: boolean;
}

export interface BuchboxStore {
  store_id: string;
  name: string;
  address: string;
  label: string;
}

export interface BuchboxEnvelope {
  dry_run: boolean;
  sent: boolean;
  delivery: string;
  payment: string;
  book: BuchboxBook;
  store: BuchboxStore;
  orderer: { name: string; email: string; phone: string };
  missing: string[];
  messages: string[];
}

export class BuchboxCliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** The venv the skill installs, else an explicit override, else system python3. */
function interpreter(): string {
  const venv = join(SCRIPT_DIR, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return process.env.BUCHBOX_PYTHON || 'python3';
}

export function isInstalled(): boolean {
  return existsSync(SCRIPT);
}

async function runCli<T>(args: string[], req?: BuchboxOrderRequest): Promise<T> {
  if (!isInstalled()) {
    throw new BuchboxCliError(`buchbox CLI not found at ${SCRIPT}`, null, '');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The identity always comes from the request, never from an operator .env
    // that happens to sit next to the script. Search carries no identity at all.
    BUCHBOX_FIRST_NAME: req?.firstName ?? '',
    BUCHBOX_LAST_NAME: req?.lastName ?? '',
    BUCHBOX_EMAIL: req?.email ?? '',
    BUCHBOX_PHONE: req?.phone ?? '',
    BUCHBOX_NAME: '',
    BUCHBOX_ENV_FILE: '/dev/null',
  };
  if (req?.storeMatch) env.BUCHBOX_STORE_MATCH = req.storeMatch;

  let stdout: string;
  try {
    const result = await execFileAsync(interpreter(), [SCRIPT, '--json', ...args], {
      cwd: SCRIPT_DIR,
      env,
      timeout: EXECUTE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    throw new BuchboxCliError(
      (e.stderr || e.message || 'buchbox CLI failed').trim(),
      typeof e.code === 'number' ? e.code : null,
      e.stderr ?? '',
    );
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new BuchboxCliError('buchbox CLI returned unparseable output', null, stdout.slice(0, 500));
  }
}

/** Dry run: resolve the book and the pickup branch, send nothing. */
export function previewOrder(req: BuchboxOrderRequest): Promise<BuchboxEnvelope> {
  return runCli<BuchboxEnvelope>(['order', req.isbn], req);
}

/** Approved replay: actually place the pickup order. */
export function executeOrder(req: BuchboxOrderRequest, approvalId: string): Promise<BuchboxEnvelope> {
  return runCli<BuchboxEnvelope>(['order', req.isbn, '--execute', '--approved', approvalId], req);
}

/** Hard cap on hits, independent of what a caller asks for. */
export const SEARCH_LIMIT_MAX = 10;

/**
 * Read-only catalogue search. An exact ISBN resolves to the article page, so
 * that mode returns one fully-populated hit (availability included) from a
 * single request; a keyword search returns the list view, which the shop
 * renders without availability.
 */
export function searchBooks(req: BuchboxSearchRequest): Promise<BuchboxBook[]> {
  const limit = Math.min(Math.max(req.limit ?? 5, 1), SEARCH_LIMIT_MAX);
  const args = ['search', '--limit', String(limit)];
  if (req.isbn) args.push('--isbn', req.isbn);
  if (req.author) args.push('--author', req.author);
  if (req.publisher) args.push('--publisher', req.publisher);
  if (req.availability) args.push('--availability');
  // The free-text term is positional; keep it last so a term that begins with
  // a dash can never be read as a flag.
  if (req.query) args.push('--', req.query);
  return runCli<BuchboxBook[]>(args);
}
