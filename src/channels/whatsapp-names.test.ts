import { describe, expect, it } from 'vitest';

import { assistantNameFor, hasAssistantPrefix, parseAssistantNameByChat } from './whatsapp-names.js';

const GROUP = '120363430405377668@g.us';

describe('parseAssistantNameByChat', () => {
  it('parses jid=name pairs and ignores junk', () => {
    const m = parseAssistantNameByChat(` ${GROUP}=Paula , nonsense, 491@s.whatsapp.net=Max=Mustermann`);
    expect(m.get(GROUP)).toBe('Paula');
    expect(m.get('491@s.whatsapp.net')).toBe('Max=Mustermann');
    expect(m.size).toBe(2);
  });

  it('is empty when unset', () => {
    expect(parseAssistantNameByChat(undefined).size).toBe(0);
  });
});

describe('assistantNameFor / hasAssistantPrefix', () => {
  const m = parseAssistantNameByChat(`${GROUP}=Paula`);

  it('uses the per-chat name and falls back to the global one', () => {
    expect(assistantNameFor(GROUP, m, 'Andy')).toBe('Paula');
    expect(assistantNameFor('other@g.us', m, 'Andy')).toBe('Andy');
  });

  it('recognises echoes under any configured name', () => {
    expect(hasAssistantPrefix('Paula: Guten Morgen', m, 'Andy')).toBe(true);
    expect(hasAssistantPrefix('Andy: hi', m, 'Andy')).toBe(true);
    expect(hasAssistantPrefix('Paula ist nett', m, 'Andy')).toBe(false);
  });
});
