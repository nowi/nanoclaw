/**
 * Local customization (nowi): helpers that make agent reactions actually land
 * on WhatsApp. Kept out of whatsapp.ts so the adapter patch stays small.
 *
 * Three things trunk's adapter gets wrong for this install:
 *  - the router namespaces inbound ids as `<wa-id>:<agent-group-id>` and the
 *    agent reacts with that id verbatim — WhatsApp needs the bare `<wa-id>`;
 *  - the agent tool speaks emoji shortcodes (`thumbs_up`) while Baileys wants
 *    the character;
 *  - the reaction key was hardcoded `fromMe: false`, which never matches the
 *    operator's own messages on a shared number (they are `fromMe: true`) nor
 *    group messages from others (which need `participant`). We remember the
 *    real key of every forwarded inbound message instead.
 */

export interface WaMessageKey {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  participant?: string;
}

const INBOUND_KEY_CACHE_MAX = 512;

/** Bounded FIFO of inbound WhatsApp message keys, by bare message id. */
export class InboundKeyCache {
  private readonly map = new Map<string, WaMessageKey>();

  remember(key: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  }): void {
    if (!key.id || !key.remoteJid) return;
    const entry: WaMessageKey = { remoteJid: key.remoteJid, id: key.id, fromMe: key.fromMe === true };
    if (key.participant) entry.participant = key.participant;
    this.map.set(key.id, entry);
    if (this.map.size > INBOUND_KEY_CACHE_MAX) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get(id: string): WaMessageKey | undefined {
    return this.map.get(id);
  }
}

/** `<wa-id>:<agent-group-id>` → `<wa-id>`; ids without the namespace pass through. */
export function bareWhatsAppMessageId(messageId: string): string {
  const cut = messageId.indexOf(':');
  return cut === -1 ? messageId : messageId.slice(0, cut);
}

const SHORTCODES: Record<string, string> = {
  thumbs_up: '👍',
  thumbsup: '👍',
  '+1': '👍',
  like: '👍',
  thumbs_down: '👎',
  thumbsdown: '👎',
  '-1': '👎',
  eyes: '👀',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  check: '✅',
  check_mark: '✅',
  done: '✅',
  x: '❌',
  cross_mark: '❌',
  heart: '❤️',
  red_heart: '❤️',
  tada: '🎉',
  party: '🎉',
  rocket: '🚀',
  fire: '🔥',
  warning: '⚠️',
  question: '❓',
  exclamation: '❗',
  pray: '🙏',
  ok_hand: '👌',
  ok: '👌',
  clap: '👏',
  raised_hands: '🙌',
  wave: '👋',
  hourglass: '⏳',
  hourglass_flowing_sand: '⏳',
  thinking: '🤔',
  thinking_face: '🤔',
  smile: '😄',
  grinning: '😀',
  joy: '😂',
  laughing: '😆',
  100: '💯',
  star: '⭐',
  sparkles: '✨',
  bulb: '💡',
  memo: '📝',
  calendar: '📅',
  mag: '🔍',
  robot: '🤖',
  zap: '⚡',
  muscle: '💪',
  handshake: '🤝',
  see_no_evil: '🙈',
  sob: '😭',
  cry: '😢',
  sweat_smile: '😅',
};

/**
 * Turn what the agent sent into a reaction character. Anything that already
 * contains a non-ASCII character is assumed to be an emoji and passed through;
 * ASCII names are looked up as shortcodes (with or without colons). Returns
 * null for unknown names so the caller can refuse rather than react wrongly.
 */
export function toReactionEmoji(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(raw)) return raw;
  const name = raw.replace(/^:|:$/g, '').toLowerCase();
  return SHORTCODES[name] ?? null;
}
