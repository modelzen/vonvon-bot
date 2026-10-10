import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createClaudeBackend } from '../src/agent/claude-provider';
import type { Logger } from '../src/agent/paseo/logger';
import type { AgentInput } from '../src/agent/types';

const logger: Logger = {
  child: () => logger,
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
const dirs: string[] = [];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function image(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-sdk-image-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sdkUserMessage(input: AgentInput): Promise<SDKUserMessage> {
  let resolveMessage: (message: SDKUserMessage) => void = () => { throw new Error('SDK prompt was not captured'); };
  const captured = new Promise<SDKUserMessage>((resolve) => { resolveMessage = resolve; });
  let sentResult = false;
  const backend = createClaudeBackend({
    logger, resolveBinary: async () => '/mock/claude', resolveVersion: async () => '2.1.220',
    queryFactory: ({ prompt }) => {
      if (typeof prompt === 'string') throw new Error('Expected the SDK prompt stream');
      const iterator = prompt[Symbol.asyncIterator]();
      return {
        next: vi.fn(async () => {
          if (sentResult) return { done: true, value: undefined };
          const first = await iterator.next();
          if (first.done) throw new Error('SDK prompt ended before the user message');
          resolveMessage(first.value);
          sentResult = true;
          return { done: false, value: {
            type: 'result', subtype: 'success', is_error: false, result: '',
            session_id: 'sdk-images', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
          } };
        }),
        return: vi.fn(async () => ({ done: true, value: undefined })),
        [Symbol.asyncIterator]() { return this; },
        close: vi.fn(), interrupt: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}), supportedModels: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []), rewindFiles: vi.fn(async () => ({ canRewind: true })),
      } as unknown as Query;
    },
  });
  const thread = await backend.startThread({ cwd: '/repo' });
  try {
    for await (const event of thread.runStreamed(input).events) {
      if (event.type === 'error') throw new Error(event.message);
    }
    return await captured;
  } finally {
    await thread.close();
  }
}

it('sends exact image bytes and MIME types in text/image order through the public backend', async () => {
  const first = await image('wrong-extension.jpg', png);
  const second = await image('wrong-extension.png', jpeg);
  const message = await sdkUserMessage({ text: '看这两张图', images: [first, second] });
  expect(message).toMatchObject({ type: 'user', message: { role: 'user' }, parent_tool_use_id: null });
  expect(message.message.content).toEqual([
    { type: 'text', text: '看这两张图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
  ]);
});

it('sends an image-only message without an empty text block', async () => {
  const path = await image('photo.png', png);
  const message = await sdkUserMessage({ images: [path] });
  expect(message.message.content).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
  ]);
});

const textCases: Array<[string, AgentInput]> = [
  ['no images property', { text: 'hello' }],
  ['empty images array', { text: 'hello', images: [] }],
  ['missing text', {}],
];

it.each(textCases)('sends %s as one SDK text block', async (_label, input) => {
  const message = await sdkUserMessage(input);
  expect(message.message.content).toEqual([{ type: 'text', text: input.text ?? '' }]);
});
