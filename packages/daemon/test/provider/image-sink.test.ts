import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/provider/model';
import { ImageSink } from '../../src/provider/runtime/image-sink';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vonvon-image-sink-'));
  roots.push(path);
  return path;
}

const payload = { base64: Buffer.from('real image bytes').toString('base64'), mime: 'image/png' as const, placement: { kind: 'answer' as const } };

describe('ImageSink', () => {
  it('writes exact bytes before emitting a disk-only image reference', async () => {
    const dataDir = await root();
    const seen: { event: RunEvent; bytes: string }[] = [];
    const sink = new ImageSink({ dataDir, runId: 'run_1', isOpen: () => true, emit: event => {
      if (event.type !== 'image') throw new Error('unexpected notice');
      seen.push({ event, bytes: readFileSync(event.image.path, 'utf8') });
    } });
    const image = await sink.accept(payload);
    expect(image?.path.startsWith(join(dataDir, 'images', 'run_1'))).toBe(true);
    expect(image?.mime).toBe('image/png');
    expect(seen[0]?.event).toEqual({ type: 'image', image });
    expect(seen[0]?.bytes).toBe('real image bytes');
    expect(await readFile(image?.path ?? '', 'utf8')).toBe('real image bytes');
    expect(JSON.stringify(seen)).not.toContain('data:');
  });

  it('allows 12 concurrent successful writes and sends one cap notice', async () => {
    const dataDir = await root();
    const events: RunEvent[] = [];
    const sink = new ImageSink({ dataDir, runId: 'run_2', isOpen: () => true, emit: event => events.push(event) });
    const results = await Promise.all(Array.from({ length: 17 }, () => sink.accept(payload)));
    expect(results.filter(Boolean)).toHaveLength(12);
    expect(events.filter(event => event.type === 'image')).toHaveLength(12);
    expect(events.filter(event => event.type === 'notice')).toEqual([{ type: 'notice', kind: 'image-cap', text: '最多保留 12 张图片。' }]);
    expect(await readdir(join(dataDir, 'images', 'run_2'))).toHaveLength(12);
  });

  it('emits no image for malformed base64 or a filesystem failure', async () => {
    const dataDir = await root();
    const events: RunEvent[] = [];
    const sink = new ImageSink({ dataDir, runId: 'run_3', isOpen: () => true, emit: event => events.push(event) });
    expect(await sink.accept({ ...payload, base64: 'data:image/png;base64,abc' })).toBeUndefined();
    await writeFile(join(dataDir, 'images'), 'blocks directory');
    expect(await sink.accept(payload)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('does not write or emit for a run that has ended', async () => {
    const dataDir = await root();
    const events: RunEvent[] = [];
    const sink = new ImageSink({ dataDir, runId: 'run_4', isOpen: () => false, emit: event => events.push(event) });
    expect(await sink.accept(payload)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('rejects unsafe run path components', async () => {
    const dataDir = await root();
    expect(() => new ImageSink({ dataDir, runId: '../other', isOpen: () => true, emit: () => undefined })).toThrow('invalid run id');
  });
});
