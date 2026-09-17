/**
 * Local customization (nowi): per-chat assistant names on a shared number.
 *
 * On a shared/personal number the adapter prefixes every outbound line with
 * the assistant name ("Andy: …") so a group can tell the bot from the human,
 * and uses the same prefix to recognise its own echoes. Trunk has one global
 * name; the outbound path never learns which agent group produced a message.
 * `ASSISTANT_NAME_BY_CHAT` maps chat JIDs to names so e.g. the "Phil PA"
 * group speaks as "Paula" while every other chat stays "Andy":
 *
 *   ASSISTANT_NAME_BY_CHAT=120363430405377668@g.us=Paula,491…@s.whatsapp.net=Max
 */

export function parseAssistantNameByChat(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const jid = entry.slice(0, eq).trim();
    const name = entry.slice(eq + 1).trim();
    if (jid && name) map.set(jid, name);
  }
  return map;
}

/** Name to speak as in `jid`: the per-chat override, else the global default. */
export function assistantNameFor(jid: string, byChat: Map<string, string>, fallback: string): string {
  return byChat.get(jid) ?? fallback;
}

/** True when `content` starts with any configured assistant name prefix ("Name: "). */
export function hasAssistantPrefix(content: string, byChat: Map<string, string>, fallback: string): boolean {
  if (content.startsWith(`${fallback}:`)) return true;
  for (const name of byChat.values()) {
    if (content.startsWith(`${name}:`)) return true;
  }
  return false;
}
