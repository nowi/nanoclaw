import { describe, expect, it } from 'vitest';

import { InboundKeyCache, bareWhatsAppMessageId, toReactionEmoji } from './whatsapp-reactions.js';

describe('bareWhatsAppMessageId', () => {
  it('strips the router agent-group namespace', () => {
    expect(bareWhatsAppMessageId('3AC152F92E78100F8E19:ag-1789547176439-np0djs')).toBe('3AC152F92E78100F8E19');
  });

  it('passes bare ids through', () => {
    expect(bareWhatsAppMessageId('3AC152F92E78100F8E19')).toBe('3AC152F92E78100F8E19');
  });
});

describe('toReactionEmoji', () => {
  it('maps shortcodes with or without colons', () => {
    expect(toReactionEmoji('thumbs_up')).toBe('👍');
    expect(toReactionEmoji(':eyes:')).toBe('👀');
    expect(toReactionEmoji('White_Check_Mark')).toBe('✅');
  });

  it('passes emoji characters through', () => {
    expect(toReactionEmoji('👍')).toBe('👍');
    expect(toReactionEmoji('❤️')).toBe('❤️');
  });

  it('refuses unknown names instead of guessing', () => {
    expect(toReactionEmoji('definitely_not_an_emoji')).toBeNull();
    expect(toReactionEmoji('')).toBeNull();
  });
});

describe('InboundKeyCache', () => {
  it('returns the real key for a remembered message', () => {
    const cache = new InboundKeyCache();
    cache.remember({
      remoteJid: '120363421802270057@g.us',
      id: 'ABC',
      fromMe: true,
      participant: '491724272095@s.whatsapp.net',
    });
    expect(cache.get('ABC')).toEqual({
      remoteJid: '120363421802270057@g.us',
      id: 'ABC',
      fromMe: true,
      participant: '491724272095@s.whatsapp.net',
    });
  });

  it('ignores keys without id or chat and evicts oldest entries', () => {
    const cache = new InboundKeyCache();
    cache.remember({ remoteJid: null, id: 'x' });
    expect(cache.get('x')).toBeUndefined();
    for (let i = 0; i < 600; i++) cache.remember({ remoteJid: 'c@s.whatsapp.net', id: `m${i}`, fromMe: false });
    expect(cache.get('m0')).toBeUndefined();
    expect(cache.get('m599')?.fromMe).toBe(false);
  });
});
