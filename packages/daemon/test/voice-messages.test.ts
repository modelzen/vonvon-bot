import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { VoiceMessages } from '../src/voice/messages';
import { lineOfMessage } from '../src/bot/recent-lines';
import { bareText } from '../src/bot/salience';

function audio(id = 'voice'): NormalizedMessage {
  return { messageId: id, chatId: 'chat', chatType: 'group', threadId: 'topic', rootId: 'root', replyToMessageId: 'quote',
    senderId: 'person', senderName: 'Someone', createTime: 123, content: '[audio]', rawContentType: 'audio',
    mentionedBot: false, mentionAll: false, mentions: [], resources: [{ type: 'audio', fileKey: 'file' }],
    raw: { sender: { sender_type: 'user' }, message: { message_id: id, message_type: 'audio', content: '{"file_key":"file"}' } },
  } as NormalizedMessage;
}
const result = (text: string, messageId = 'voice') => ({ text, voice: { messageId, text, transcribed: true } });
afterEach(() => vi.useRealTimers());

describe('voice text normalization', () => {
  it('makes both raw-body and normalized readers see text without mutating the source or losing identity', () => {
    const cache = new VoiceMessages(); const source = audio(); const original = structuredClone(source);
    const message = cache.remember(source, result('小码，帮我看一下\n第二行'));
    expect(source).toEqual(original);
    expect(message).toMatchObject({ ...source, content: '小码，帮我看一下\n第二行', rawContentType: 'text', resources: [],
      raw: { sender: { sender_type: 'user' }, message: { message_type: 'text', content: JSON.stringify({ text: '小码，帮我看一下\n第二行' }) } },
    });
    expect(lineOfMessage(message, 'Someone').text).toBe('小码，帮我看一下\n第二行');
    expect(bareText(message)).toBe('小码，帮我看一下\n第二行');
    expect(cache.get(message)?.voice).toEqual(result('小码，帮我看一下\n第二行').voice);
  });

  it('keeps failed ASR metadata out of text routing and history', () => {
    const cache = new VoiceMessages(); const source = audio();
    const failed = { text: '语音未转写，原音频附件：/fixture/voice.ogg', voice: { messageId: 'voice', text: '转写失败', transcribed: false } };
    expect(cache.remember(source, failed)).toBe(source);
    expect(cache.get(source)).toBe(failed);
    expect(cache.context({ messageId: 'voice', text: '[语音]' }).text).toBe('[语音]');
  });

  it('bounds history transcripts by capacity and age, while a pending turn retains its own voice display', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const cache = new VoiceMessages(1, 1000);
    const first = cache.remember(audio(), result('first'));
    cache.remember(audio('second'), result('second', 'second'));
    expect(cache.context({ messageId: 'voice', text: '[语音]' }).text).toBe('[语音]');
    expect(cache.context({ messageId: 'second', text: '[语音]' }).text).toBe('second');
    vi.setSystemTime(1000);
    expect(cache.context({ messageId: 'second', text: '[语音]' }).text).toBe('[语音]');
    expect(cache.get(first)?.voice?.text).toBe('first');
  });

  it('forgets recalled transcripts', () => {
    const cache = new VoiceMessages(); cache.remember(audio(), result('recalled'));
    cache.forget('voice');
    expect(cache.context({ messageId: 'voice', text: '[语音]' }).text).toBe('[语音]');
  });
});
