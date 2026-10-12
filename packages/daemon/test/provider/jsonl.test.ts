import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonlPeer } from '../../src/provider/transport/jsonl';
import type { JsonlFrame } from '../../src/provider/transport/jsonl';

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output);
  const outbound: JsonlFrame[] = [];
  output.on('data', (chunk: Buffer) => {
    outbound.push(JSON.parse(chunk.toString('utf8')));
  });
  return { input, output, peer, outbound };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('JsonlPeer', () => {
  it('decodes split UTF-8 and lines, then multiple objects in one chunk', () => {
    const { input, peer } = fixture();
    const frames: JsonlFrame[] = [];
    peer.onFrame = frame => frames.push(frame);
    const first = Buffer.from('{"local":"咖"}\n');
    const split = first.indexOf(Buffer.from('咖')) + 1;
    input.write(first.subarray(0, split));
    input.write(first.subarray(split));
    input.write('{"local":"A"}\n{"local":"B"}\n');
    expect(frames).toEqual([{ local: '咖' }, { local: 'A' }, { local: 'B' }]);
  });

  it('observes replies and unknown objects before dispatch and answers a server request', async () => {
    const { input, peer, outbound } = fixture();
    const seen: JsonlFrame[] = [];
    peer.onFrame = frame => seen.push(frame);
    peer.isRequest = frame => frame.localKind === 'ask';
    peer.onRequest = frame => ({ localKind: 'answer', localToken: frame.localToken, accepted: true });
    const pending = peer.request({ localKind: 'outbound', localToken: 'mine' },
      frame => frame.localKind === 'reply' && frame.localToken === 'mine');
    input.write('{"localKind":"reply","localToken":"mine"}\n');
    input.write('{"localKind":"unknown"}\n{"localKind":"ask","localToken":"theirs"}\n');
    await expect(pending).resolves.toEqual({ localKind: 'reply', localToken: 'mine' });
    await settle();
    expect(seen).toEqual([
      { localKind: 'reply', localToken: 'mine' },
      { localKind: 'unknown' },
      { localKind: 'ask', localToken: 'theirs' },
    ]);
    expect(outbound).toEqual([
      { localKind: 'outbound', localToken: 'mine' },
      { localKind: 'answer', localToken: 'theirs', accepted: true },
    ]);
  });

  it('times out one request without changing another matcher', async () => {
    const { input, peer } = fixture();
    const timed = peer.request({ localToken: 'slow' }, frame => frame.localToken === 'slow', 10);
    const live = peer.request({ localToken: 'live' }, frame => frame.localToken === 'live');
    await expect(timed).rejects.toThrow('JSONL response timed out; delivery unknown');
    expect(peer.pendingCount).toBe(1);
    input.write('{"localToken":"live","value":7}\n');
    await expect(live).resolves.toEqual({ localToken: 'live', value: 7 });
    expect(peer.pendingCount).toBe(0);
  });

  it('rejects pending work and settles closed on EOF', async () => {
    const { input, peer } = fixture();
    const pending = peer.request({ localToken: 'held' }, frame => frame.localToken === 'held');
    input.end();
    await expect(pending).rejects.toThrow('JSONL input ended');
    await expect(peer.closed).resolves.toBeUndefined();
    expect(peer.pendingCount).toBe(0);
    await expect(peer.request({ localToken: 'late' }, () => true)).rejects.toThrow('JSONL peer closed');
  });

  it('stops dispatching buffered frames when onFrame closes the peer', async () => {
    const { input, peer, outbound } = fixture();
    const seen: JsonlFrame[] = [];
    let handled = 0;
    peer.onFrame = frame => { seen.push(frame); peer.close(); };
    peer.isRequest = () => true;
    peer.onRequest = () => { handled++; return { answer: true }; };
    input.write('{"local":"first"}\n{"local":"second"}\n');
    await peer.closed;
    expect(seen).toEqual([{ local: 'first' }]);
    expect(handled).toBe(0);
    expect(outbound).toEqual([]);
  });

  it('suppresses an async server answer after close', async () => {
    const { input, peer, outbound } = fixture();
    let answer!: (frame: JsonlFrame) => void;
    peer.isRequest = () => true;
    peer.onRequest = () => new Promise<JsonlFrame>(resolve => { answer = resolve; });
    input.write('{"local":"ask"}\n');
    peer.close();
    answer({ local: 'late-answer' });
    await settle();
    expect(outbound).toEqual([]);
  });

  it('ignores invalid JSON and non-object values while reporting each invalid line', () => {
    const { input, peer } = fixture();
    const invalid: string[] = [];
    const valid: JsonlFrame[] = [];
    peer.onInvalidLine = line => invalid.push(line);
    peer.onFrame = frame => valid.push(frame);
    input.write('bad\n[]\nnull\n5\n{"local":"ok"}\n');
    expect(invalid).toEqual(['bad', '[]', 'null', '5']);
    expect(valid).toEqual([{ local: 'ok' }]);
  });

  it('closes and rejects waits when a matcher throws or output errors', async () => {
    const first = fixture();
    const matchError = new Error('matcher failed');
    const matching = first.peer.request({ local: 'one' }, () => { throw matchError; });
    first.input.write('{"local":"reply"}\n');
    await expect(matching).rejects.toBe(matchError);
    await first.peer.closed;

    const second = fixture();
    const writing = second.peer.request({ local: 'two' }, () => true);
    const outputError = new Error('output failed');
    second.output.emit('error', outputError);
    await expect(writing).rejects.toBe(outputError);
    await second.peer.closed;
  });
});
