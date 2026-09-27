import { describe, expect, it } from 'vitest';

import {
  InboundKeyCache,
  bareWhatsAppMessageId,
  baseEmoji,
  reactionToOptionValue,
  toReactionEmoji,
} from './whatsapp-reactions.js';
import { optionCommands } from './whatsapp.js';

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

/**
 * Reaction → approval mapping.
 *
 * WhatsApp has no buttons, so a 👍/👎 reaction on an approval card is the
 * fastest way to answer it. Two properties matter: the thumbs must resolve
 * regardless of skin tone or variation selector, and anything else must map to
 * null rather than be guessed at — a wrong guess would resolve somebody's
 * approval for them.
 */
describe('reactionToOptionValue', () => {
  it('maps a plain thumbs up/down to approve/reject', () => {
    expect(reactionToOptionValue('👍')).toBe('approve');
    expect(reactionToOptionValue('👎')).toBe('reject');
  });

  it('ignores skin tone and variation selectors', () => {
    for (const thumb of ['👍🏻', '👍🏽', '👍🏿', '👍️']) {
      expect(reactionToOptionValue(thumb), thumb).toBe('approve');
    }
    for (const thumb of ['👎🏻', '👎🏽', '👎🏿', '👎️']) {
      expect(reactionToOptionValue(thumb), thumb).toBe('reject');
    }
  });

  it('refuses to guess at any other emoji', () => {
    for (const other of ['❤️', '😀', '✅', '❌', '🙏', '🤔', 'x', '']) {
      expect(reactionToOptionValue(other), other).toBeNull();
    }
  });

  it('baseEmoji strips modifiers without mangling the codepoint', () => {
    expect(baseEmoji('👍🏽')).toBe('👍');
    expect(baseEmoji('👍')).toBe('👍');
  });
});

describe('optionCommands', () => {
  const APPROVAL_LABELS = ['Approve', 'Reject', 'Reject with reason…'];

  it('makes the approval card answerable with plain ASCII', () => {
    expect(optionCommands(APPROVAL_LABELS)).toEqual(['/approve', '/reject', '/reject-with-reason']);
  });

  it('never emits an untypeable character', () => {
    for (const command of optionCommands(APPROVAL_LABELS)) {
      expect(command).toMatch(/^\/[a-z0-9-]+$/);
    }
  });

  it('keeps colliding labels distinguishable instead of aliasing them', () => {
    expect(optionCommands(['Yes', 'Yes!', 'Yes?'])).toEqual(['/yes', '/yes-2', '/yes-3']);
  });

  it('falls back to the 1-based position when a label sanitizes to nothing', () => {
    expect(optionCommands(['…', 'OK'])).toEqual(['/1', '/ok']);
  });
});
