import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionBackendThread } from '../src/agent/paseo/session-backend';
import type { AgentPromptInput, AgentSession, AgentStreamEvent } from '../src/agent/paseo/agent-sdk-types';
import type { AgentEvent } from '../src/agent/types';

const dirs: string[] = [];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

async function image(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-image-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function send(text: string | undefined, images: string[]): Promise<{ prompt: AgentPromptInput | undefined; events: AgentEvent[] }> {
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  let prompt: AgentPromptInput | undefined;
  const session = {
    id: 'images-session',
    subscribe(listener: (event: AgentStreamEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    startTurn: vi.fn(async (value: AgentPromptInput) => {
      prompt = value;
      for (const listener of listeners) listener({ type: 'turn_completed', provider: 'claude', turnId: 'images-turn' });
      return { turnId: 'images-turn' };
    }),
    close: vi.fn(async () => {}),
  } as unknown as AgentSession;
  const thread = new SessionBackendThread(session);
  const events: AgentEvent[] = [];
  try {
    for await (const event of thread.runStreamed({ text, images }).events) events.push(event);
  } finally {
    await thread.close();
  }
  return { prompt, events };
}

it('keeps text and valid images when an unsupported or unreadable image is present', async () => {
  const good = await image('actually-jpeg.png', jpeg);
  const bad = await image('unsupported.bmp', Buffer.from([0x42, 0x4d, 0, 0]));
  const result = await send('看这张图', [bad, '/no/such/claude-image.png', good]);
  expect(result.events.at(-1)?.type).toBe('done');
  expect(result.prompt).toEqual([
    { type: 'text', text: '看这张图' },
    { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
  ]);
});

it('uses plain text when all images are unusable', async () => {
  const result = await send('继续回答', ['/no/such/claude-image.png']);
  expect(result.events.at(-1)?.type).toBe('done');
  expect(result.prompt).toBe('继续回答');
});

it('preserves supported PNG images and image-only prompts', async () => {
  const good = await image('actually-binary.bin', png);
  const result = await send(undefined, [good]);
  expect(result.events.at(-1)?.type).toBe('done');
  expect(result.prompt).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
});

it.each([
  [png, 'image/png'], [jpeg, 'image/jpeg'], [gif, 'image/gif'], [webp, 'image/webp'],
] as const)('detects supported image type from bytes rather than filename', async (bytes, mimeType) => {
  const path = await image('misleading.bin', bytes);
  const result = await send('look', [path]);
  expect(result.prompt).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', data: bytes.toString('base64'), mimeType },
  ]);
});

it('preserves the order of multiple valid images', async () => {
  const first = await image('first.png', png);
  const second = await image('second.jpg', jpeg);
  const result = await send('both', [first, second]);
  expect(result.prompt).toEqual([
    { type: 'text', text: 'both' },
    { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
  ]);
});

it.each([
  Buffer.from([0x42, 0x4d, 0, 0]),
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
  Buffer.from([0x49, 0x49, 0x2a, 0]),
  Buffer.alloc(0),
])('skips an unsupported or empty image and sends plain text', async (bytes, _label) => {
  const path = await image('fake.png', bytes);
  const result = await send('continue', [path]);
  expect(result.events.at(-1)?.type).toBe('done');
  expect(result.prompt).toBe('continue');
});

it('sends an empty string for an image-only prompt when all images fail', async () => {
  const result = await send(undefined, ['/no/such/claude-image.png']);
  expect(result.prompt).toBe('');
});

it('skips an image over the V3 20 MiB limit and retains the message text', async () => {
  const oversized = await image('large.png', Buffer.alloc(20 * 1024 * 1024 + 1, 0));
  const result = await send('keep answering', [oversized]);
  expect(result.events.at(-1)?.type).toBe('done');
  expect(result.prompt).toBe('keep answering');
});

it.each([
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'short PNG'],
  [Buffer.from([0xff, 0xd8]), 'short JPEG'],
  [Buffer.from('GIF8'), 'short GIF'],
  [Buffer.from('RIFF0000'), 'short WebP'],
] as const)('rejects a truncated magic header: %s', async (bytes, _label) => {
  const path = await image('truncated.bin', bytes);
  const result = await send('keep answering', [path]);
  expect(result.events.at(-1)?.type).toBe('done');
  expect(result.prompt).toBe('keep answering');
});
