/**
 * Regression: inbound WhatsApp media must reach the container.
 *
 * The adapter used to save media to `DATA_DIR/attachments/` and hand the agent
 * `localPath: 'attachments/<file>'`. That directory is not mounted into the
 * container, so the formatter rendered `/workspace/attachments/<file>` and the
 * agent found nothing — every inbound image looked like a model limitation.
 *
 * The contract: an adapter emits BYTES (`data`), never a path. The host stages
 * them into the session inbox and owns `localPath`.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-wa-attachments' };
});

import { buildInboundAttachment, appendMediaNotes } from './whatsapp.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { initSessionFolder, sessionDir, withMailboxSession, writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-wa-attachments';
const AG = 'ag-wa-att';
const SESS = 'sess-wa-att';
const CAP = 1000;

function now(): string {
  return new Date().toISOString();
}

describe('buildInboundAttachment', () => {
  it('carries base64 bytes and never a localPath', () => {
    const { entry, note } = buildInboundAttachment('image', 'photo.jpg', 'image/jpeg', Buffer.from('JPEGBYTES'), CAP);

    expect(note).toBeUndefined();
    expect(entry.data).toBe(Buffer.from('JPEGBYTES').toString('base64'));
    expect(entry).toMatchObject({ type: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', size: 9 });
    // The load-bearing assertion: a host path here is unreachable from the
    // container, so the adapter must not invent one.
    expect(entry).not.toHaveProperty('localPath');
  });

  it('omits bytes over the inline cap and explains why instead', () => {
    const { entry, note } = buildInboundAttachment('video', 'clip.mp4', 'video/mp4', Buffer.alloc(CAP + 1), CAP);

    expect(entry.data).toBeUndefined();
    expect(entry).not.toHaveProperty('localPath');
    expect(note).toContain('clip.mp4');
    expect(note).toContain('too large');
    // The agent sees the note in the message text — not silence.
    expect(appendMediaNotes('look at this', [note!])).toBe(`look at this\n${note}`);
  });
});

describe('WhatsApp media → session inbox', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({ id: AG, name: 'WaAtt', folder: 'waatt', agent_provider: null, created_at: now() });
    const sess: Session = {
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    await createSession(sess);
    initSessionFolder(AG, SESS);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('stages the adapter payload under /workspace and rewrites localPath to it', async () => {
    const bytes = Buffer.from('JPEGBYTES');
    const { entry } = buildInboundAttachment('image', 'photo.jpg', 'image/jpeg', bytes, CAP);
    // `<waMessageId>:<agentGroupId>`, as messageIdForAgent builds it.
    const messageId = '3EB0ABCDEF:ag-wa-att';

    await writeSessionMessage(AG, SESS, {
      id: messageId,
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'was ist das?', attachments: [entry] }),
    });

    const staged = path.join(sessionDir(AG, SESS), 'inbox', messageId, 'photo.jpg');
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged)).toEqual(bytes);

    const stored = await withMailboxSession(AG, SESS, async (mailbox) => mailbox.getInboundHistory(10));
    const att = JSON.parse(stored[0].content).attachments[0];

    // The container reads /workspace/<localPath>, so it must be session-relative.
    expect(att.localPath).toBe(`inbox/${messageId}/photo.jpg`);
    expect(att.data).toBeUndefined();
  });
});
