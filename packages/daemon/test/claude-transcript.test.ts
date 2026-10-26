import { claudeAccess } from '../src/agent/claude-agent/permission';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import { BRIDGE_ENTRYPOINT, findTranscript, readCustomTitle, scanTranscript } from '../src/agent/claude-agent/transcript';

// s15b: the bot reads what a terminal appended to its Claude session file.

const dirs: string[] = [];
const threads: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((t) => t.close()));
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-transcript-'));
  dirs.push(dir);
  return dir;
}

/** A throwaway CLAUDE_CONFIG_DIR; never the machine's ~/.claude. */
function claudeConfig(): string {
  const dir = tempDir();
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  return dir;
}

const line = (rec: object) => `${JSON.stringify(rec)}\n`;
const own = (uuid: string) => line({ type: 'user', uuid, entrypoint: BRIDGE_ENTRYPOINT, message: { role: 'user', content: 'hi' } });
const cli = (uuid: string) => line({ type: 'user', uuid, entrypoint: 'cli', message: { role: 'user', content: 'from terminal' } });
const boundary = (uuid: string, entrypoint = BRIDGE_ENTRYPOINT) => line({ type: 'system', subtype: 'compact_boundary', uuid, entrypoint });
const bookkeeping = [
  line({ type: 'last-prompt', lastPrompt: 'x', sessionId: 's' }),
  line({ type: 'ai-title', aiTitle: 't', sessionId: 's' }),
  line({ type: 'cost-state', uuid: 'cost-1' }),
].join('');

function transcript(content: string): string {
  const path = join(tempDir(), 'session.jsonl');
  writeFileSync(path, content);
  return path;
}

const size = (path: string) => statSync(path).size;

describe('readCustomTitle', () => {
  it('ignores automatic titles and keeps the last nonempty explicit title', async () => {
    expect(await readCustomTitle(transcript(line({ type: 'ai-title', customTitle: 'automatic' })))).toBeUndefined();
    const file = transcript(
      line({ type: 'custom-title', customTitle: 'first' })
      + '{"type":"custom-title",broken}\n'
      + line({ type: 'custom-title', customTitle: 42 })
      + line({ type: 'custom-title', customTitle: '  最后标题  ' })
      + line({ type: 'custom-title', customTitle: '  ' }),
    );
    expect(await readCustomTitle(file)).toBe('最后标题');
  });

  it('reads a custom-title line across a 1 MB boundary and an unterminated final line', async () => {
    const record = JSON.stringify({ type: 'custom-title', customTitle: '跨块标题' });
    const file = transcript(`${' '.repeat((1 << 20) - 5)}\n${record}`);
    expect(await readCustomTitle(file)).toBe('跨块标题');
  });

  it('propagates file read failures', async () => {
    await expect(readCustomTitle(join(tempDir(), 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('scanTranscript', () => {
  it('only records with a uuid and another entrypoint are foreign', async () => {
    const mine = transcript(own('a') + own('b') + bookkeeping);
    expect(await scanTranscript(mine, 0)).toEqual({ to: size(mine), foreign: false });

    const theirs = transcript(own('a') + cli('b'));
    expect((await scanTranscript(theirs, 0)).foreign).toBe(true);

    // sdk-cli is a headless terminal, still not the bot
    const sdk = transcript(line({ type: 'assistant', uuid: 'x', entrypoint: 'sdk-cli' }));
    expect((await scanTranscript(sdk, 0)).foreign).toBe(true);

    // an entrypoint without a uuid, or garbage, counts for nobody
    const odd = transcript(line({ type: 'summary', entrypoint: 'cli' }) + '{"entrypoint": not json\n');
    expect((await scanTranscript(odd, 0)).foreign).toBe(false);
  });

  it('reports the last compaction by uuid, whoever made it', async () => {
    const path = transcript(own('a') + boundary('c-1') + own('b') + boundary('c-2'));
    expect(await scanTranscript(path, 0)).toEqual({ to: size(path), foreign: false, compaction: 'c-2' });

    const terminal = transcript(own('a') + boundary('c-9', 'cli'));
    expect(await scanTranscript(terminal, 0)).toEqual({ to: size(terminal), foreign: true, compaction: 'c-9' });

    // the word alone, or a boundary that is not a system record, is no compaction
    const words = transcript(line({ type: 'user', uuid: 'u', entrypoint: BRIDGE_ENTRYPOINT, text: 'compact_boundary' }));
    expect((await scanTranscript(words, 0)).compaction).toBeUndefined();
  });

  it('leaves a line still being written for the next scan', async () => {
    const path = transcript(own('a'));
    const first = size(path);
    appendFileSync(path, cli('b').slice(0, -1));
    expect(await scanTranscript(path, 0)).toEqual({ to: first, foreign: false });

    appendFileSync(path, '\n');
    expect(await scanTranscript(path, first)).toEqual({ to: size(path), foreign: true });
  });

  it('reads on from an offset: only what was appended counts', async () => {
    const path = transcript(cli('old') + boundary('c-old', 'cli'));
    const mark = size(path);
    appendFileSync(path, own('a') + bookkeeping);
    expect(await scanTranscript(path, mark)).toEqual({ to: size(path), foreign: false });

    const next = size(path);
    appendFileSync(path, cli('b'));
    expect(await scanTranscript(path, next)).toEqual({ to: size(path), foreign: true });
    expect(await scanTranscript(path, size(path))).toEqual({ to: size(path), foreign: false });
  });

  it('a file shorter than the offset is reread from the start and counts as foreign', async () => {
    const path = transcript(own('a') + own('b') + own('c'));
    const mark = size(path);
    writeFileSync(path, own('a') + boundary('c-1'));
    expect(await scanTranscript(path, mark)).toEqual({ to: size(path), foreign: true, compaction: 'c-1' });
  });

  it('splits on bytes: a multi-byte character across the 1 MB read boundary stays whole', async () => {
    const CHUNK = 1 << 20;
    const head = '{"type":"system","subtype":"compact_boundary","entrypoint":"feishu-codex-bridge","pad":"';
    const tail = '","uuid":"';
    // the uuid's first 中 (3 bytes) starts one byte before the boundary
    const pad = 'x'.repeat(CHUNK - 1 - head.length - tail.length);
    const uuid = '中文压缩标记';
    const path = transcript(`${head}${pad}${tail}${uuid}"}\n${own('a')}`);
    expect(Buffer.byteLength(head + pad + tail)).toBe(CHUNK - 1);
    expect(await scanTranscript(path, 0)).toEqual({ to: size(path), foreign: false, compaction: uuid });
  });
});

describe('findTranscript', () => {
  it('finds the session in any project folder under CLAUDE_CONFIG_DIR', async () => {
    const dir = claudeConfig();
    mkdirSync(join(dir, 'projects', '-repo-a'), { recursive: true });
    mkdirSync(join(dir, 'projects', '-Users-me-Repo-b'), { recursive: true });
    const file = join(dir, 'projects', '-Users-me-Repo-b', 'sess-1.jsonl');
    writeFileSync(file, own('a'));

    expect(await findTranscript('sess-1')).toBe(file);
    expect(await findTranscript('sess-2')).toBeUndefined();
  });

  it('a bad id or a missing projects folder finds nothing', async () => {
    const dir = claudeConfig();
    expect(await findTranscript('sess-1')).toBeUndefined();

    mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'p', 'x.jsonl'), own('a'));
    writeFileSync(join(dir, 'secret.jsonl'), own('a'));
    expect(await findTranscript('x')).toBe(join(dir, 'projects', 'p', 'x.jsonl'));
    for (const bad of ['../secret', '../../secret', 'x.jsonl', '', 'a/b']) expect(await findTranscript(bad)).toBeUndefined();
  });
});

/** A query that never yields: checkNative does not touch it. */
function idleQuery(): Query {
  return Object.assign((async function* (): AsyncGenerator<SDKMessage> {})(), {
    getContextUsage: async () => null,
    interrupt: async () => {},
    close: () => {},
  }) as unknown as Query;
}

describe('ClaudeAgentThread.checkNative', () => {
  it('a fresh thread has nothing to read until its file appears, then reads on from there', async () => {
    const dir = claudeConfig();
    const thread = new ClaudeAgentThread({
      sessionId: 'fresh-1', resume: false, cwd: process.cwd(), access: claudeAccess(undefined, undefined, process.cwd(), process.cwd()), permission: {}, settingSources: [], query: idleQuery,
    });
    threads.push(thread);

    expect(await thread.checkNative()).toEqual({ foreign: false });
    expect(thread.lastCompaction).toBeUndefined();

    mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
    const file = join(dir, 'projects', '-repo', 'fresh-1.jsonl');
    writeFileSync(file, own('a') + bookkeeping + boundary('c-1'));
    expect(await thread.checkNative()).toEqual({ foreign: false });
    expect(thread.lastCompaction).toBe('c-1');

    appendFileSync(file, own('b'));
    expect(await thread.checkNative()).toEqual({ foreign: false });
    expect(thread.lastCompaction).toBe('c-1'); // kept when the new part has none

    appendFileSync(file, cli('c') + boundary('c-2', 'cli'));
    expect(await thread.checkNative()).toEqual({ foreign: true });
    expect(thread.lastCompaction).toBe('c-2');
    expect(await thread.checkNative()).toEqual({ foreign: false });
  });

  it('a given mark is read on from its offset', async () => {
    const file = transcript(cli('old'));
    const thread = new ClaudeAgentThread({
      sessionId: 'marked', resume: true, cwd: process.cwd(), access: claudeAccess(undefined, undefined, process.cwd(), process.cwd()), permission: {}, settingSources: [], query: idleQuery,
      transcript: { file, to: size(file), compaction: 'c-old' },
    });
    threads.push(thread);
    expect(thread.lastCompaction).toBe('c-old');
    expect(await thread.checkNative()).toEqual({ foreign: false });
    appendFileSync(file, cli('new'));
    expect(await thread.checkNative()).toEqual({ foreign: true });
    expect(thread.lastCompaction).toBe('c-old');
  });
});

describe('ClaudeAgentBackend.resumeThread sets the transcript mark', () => {
  function backend(): ClaudeAgentBackend {
    const sdk = { query: vi.fn(idleQuery), listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn() } as unknown as ClaudeSdkFacade;
    return new ClaudeAgentBackend(async () => sdk, () => undefined);
  }

  it('terminal records written before the resume are not foreign; ones after are', async () => {
    const dir = claudeConfig();
    mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
    const file = join(dir, 'projects', '-repo', 'sess-r.jsonl');
    writeFileSync(file, own('a') + cli('b') + boundary('c-term', 'cli') + cli('c'));

    const resumed = await backend().resumeThread({ cwd: '/repo', sessionId: 'sess-r' });
    threads.push(resumed);
    expect(resumed.lastCompaction).toBe('c-term');
    expect(await resumed.checkNative!()).toEqual({ foreign: false });

    appendFileSync(file, own('d'));
    expect(await resumed.checkNative!()).toEqual({ foreign: false });

    appendFileSync(file, cli('e'));
    expect(await resumed.checkNative!()).toEqual({ foreign: true });
    expect(resumed.lastCompaction).toBe('c-term');
  });

  it('a half-written last line at resume is read once it is complete', async () => {
    const dir = claudeConfig();
    mkdirSync(join(dir, 'projects', '-repo'), { recursive: true });
    const file = join(dir, 'projects', '-repo', 'sess-p.jsonl');
    writeFileSync(file, own('a') + cli('b').slice(0, -1));

    const resumed = await backend().resumeThread({ cwd: '/repo', sessionId: 'sess-p' });
    threads.push(resumed);
    expect(resumed.lastCompaction).toBeUndefined();
    appendFileSync(file, '\n');
    expect(await resumed.checkNative!()).toEqual({ foreign: true });
  });
});
