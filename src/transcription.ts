/**
 * Local customization (nowi): host-side voice-note transcription with
 * whisper.cpp, ported from NanoClaw v1.
 *
 * Trunk hands audio to the agent as an opaque `.ogg` attachment; the Claude
 * provider can't listen to it, so a voice note was effectively dropped. The
 * WhatsApp adapter calls `transcribeVoiceNote()` on push-to-talk audio after
 * the media download and prepends `[Voice: …]` to the message text — the
 * same shape v1 delivered, which the agents' memory and instructions expect.
 *
 * Requirements on the host: `ffmpeg` (ogg/opus → 16 kHz mono wav) and
 * `whisper-cli` (whisper.cpp) plus a ggml model. Binaries are resolved from
 * `.env` overrides first, then Homebrew/usr-local prefixes — the launchd
 * service PATH does not include /opt/homebrew/bin.
 *
 *   WHISPER_BIN    default: whisper-cli
 *   FFMPEG_BIN     default: ffmpeg
 *   WHISPER_MODEL  default: data/models/ggml-base.bin
 *   WHISPER_LANG   default: auto (e.g. "de" pins the language)
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const env = readEnvFile(['WHISPER_BIN', 'FFMPEG_BIN', 'WHISPER_MODEL', 'WHISPER_LANG']);

const SEARCH_PREFIXES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function resolveBinary(override: string | undefined, name: string): string {
  if (override) return override;
  for (const prefix of SEARCH_PREFIXES) {
    const candidate = path.join(prefix, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name; // fall back to PATH lookup
}

const WHISPER_BIN = resolveBinary(env.WHISPER_BIN, 'whisper-cli');
const FFMPEG_BIN = resolveBinary(env.FFMPEG_BIN, 'ffmpeg');
const WHISPER_MODEL = env.WHISPER_MODEL || path.join(DATA_DIR, 'models', 'ggml-base.bin');
const WHISPER_LANG = env.WHISPER_LANG || 'auto';

export const VOICE_UNAVAILABLE = '[Voice message — transcription unavailable]';

let availabilityLogged = false;

/** True when both binaries and the model are present; logs the gap once. */
export function transcriptionAvailable(): boolean {
  const missing: string[] = [];
  if (!fs.existsSync(WHISPER_MODEL)) missing.push(`model ${WHISPER_MODEL}`);
  for (const bin of [WHISPER_BIN, FFMPEG_BIN]) {
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) missing.push(bin);
  }
  if (missing.length > 0 && !availabilityLogged) {
    availabilityLogged = true;
    log.warn('Voice transcription disabled — missing prerequisites', { missing });
  }
  return missing.length === 0;
}

/**
 * Transcribe an audio file already on disk. Returns the transcript text, or
 * null when transcription is unavailable or produced nothing.
 */
export async function transcribeVoiceNote(audioPath: string): Promise<string | null> {
  if (!transcriptionAvailable()) return null;
  const id = `nanoclaw-voice-${Date.now()}-${process.pid}`;
  const tmpWav = path.join(os.tmpdir(), `${id}.wav`);
  try {
    // whisper.cpp wants 16 kHz mono PCM wav.
    await execFileAsync(
      FFMPEG_BIN,
      ['-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      {
        timeout: 30_000,
      },
    );
    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '-l', WHISPER_LANG, '--no-timestamps', '-nt'],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const transcript = stdout.trim();
    return transcript.length > 0 ? transcript : null;
  } catch (err) {
    log.error('whisper.cpp transcription failed', { audioPath, err });
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Merge a transcript into the inbound text the way v1 did: `[Voice: …]`,
 * after any caption. A failed transcription still tells the agent a voice
 * message arrived instead of silently dropping it.
 */
export function withVoiceTranscript(content: string, transcript: string | null): string {
  const note = transcript ? `[Voice: ${transcript}]` : VOICE_UNAVAILABLE;
  return content ? `${content}\n${note}` : note;
}
