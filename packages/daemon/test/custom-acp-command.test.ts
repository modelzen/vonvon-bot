import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseCustomAcpCommand, readCustomAcpCommand, resolveCustomAcpCommand, saveCustomAcpCommand,
} from '../src/agent/custom-acp-command';

let root: string;
let appDir: string;
const recordPath = (): string => join(appDir, 'custom-acp.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'custom-acp-command-'));
  appDir = join(root, 'state');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('custom ACP command storage', () => {
  it('resolves missing and valid files to unset and set states', () => {
    expect(resolveCustomAcpCommand(appDir)).toEqual({ kind: 'unset' });
    saveCustomAcpCommand(['agent', '--stdio'], appDir);
    expect(resolveCustomAcpCommand(appDir)).toEqual({ kind: 'set', command: ['agent', '--stdio'] });
  });
  it('reads absence as null and round trips an argv list without shell interpretation', () => {
    expect(readCustomAcpCommand(appDir)).toBeNull();
    const command = ['/opt/ACP Agent/bin/agent', '--token=$SECRET', 'a b; echo no', '中文'];
    saveCustomAcpCommand(command, appDir);
    expect(readCustomAcpCommand(appDir)).toEqual(command);
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({ version: 1, command });
    if (process.platform !== 'win32') expect(statSync(recordPath()).mode & 0o777).toBe(0o600);

    saveCustomAcpCommand(['acp-agent', '--stdio'], appDir);
    expect(readCustomAcpCommand(appDir)).toEqual(['acp-agent', '--stdio']);
    expect(readdirSync(appDir)).toEqual(['custom-acp.json']);

    saveCustomAcpCommand(null, appDir);
    expect(readCustomAcpCommand(appDir)).toBeNull();
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({ version: 1, command: null });
  });

  it('rejects invalid input before touching an existing record', () => {
    saveCustomAcpCommand(['acp-agent', '--kept'], appDir);
    const original = readFileSync(recordPath(), 'utf8');
    const invalid: unknown[] = [
      undefined, [], Array(65).fill('arg'), [''], ['a'.repeat(4097)],
      ['relative/agent'], ['relative\\agent'], ['agent', ''], ['agent', 'bad\narg'],
      ['agent', 'bad\rarg'], ['agent', 'bad\0arg'], ['agent', 12],
    ];
    for (const value of invalid) {
      expect(() => parseCustomAcpCommand(value)).toThrow();
      expect(() => saveCustomAcpCommand(value, appDir)).toThrow();
      expect(readFileSync(recordPath(), 'utf8')).toBe(original);
    }
    expect(readdirSync(appDir)).toEqual(['custom-acp.json']);
  });

  it.each([
    '{',
    '{}',
    '{"version":2,"command":null}',
    '{"version":1}',
    '{"version":1,"command":[]}',
    '{"version":1,"command":["relative/agent"]}',
    '{"version":1,"command":["agent","bad\\narg"]}',
    '{"version":1,"command":null,"unexpected":true}',
  ])('reports a corrupt or invalid record with its path: %s', content => {
    mkdirSync(appDir);
    writeFileSync(recordPath(), content);
    expect(() => readCustomAcpCommand(appDir)).toThrow(recordPath());
    expect(readFileSync(recordPath(), 'utf8')).toBe(content);
  });

  it('distinguishes an unreadable record from an absent one', () => {
    mkdirSync(recordPath(), { recursive: true });
    expect(() => readCustomAcpCommand(appDir)).toThrow(recordPath());
  });

  it('keeps the previous record and removes the temporary file if replacement fails', () => {
    mkdirSync(recordPath(), { recursive: true });
    expect(() => saveCustomAcpCommand(['acp-agent'], appDir)).toThrow();
    expect(statSync(recordPath()).isDirectory()).toBe(true);
    expect(readdirSync(appDir)).toEqual(['custom-acp.json']);
  });

  it('does not create a directory for an invalid first save', () => {
    expect(() => saveCustomAcpCommand(['./agent'], appDir)).toThrow();
    expect(existsSync(appDir)).toBe(false);
  });

  it('classifies each invalid file without exposing file content in state or errors', () => {
    mkdirSync(appDir);
    const secret = 'PRIVATE_ARGUMENT_123';
    for (const [content, reason] of [
      [`{"version":1,"command":["${secret}"`, 'not-json'],
      ['{"version":2,"command":null}', 'unsupported-version'],
      [`{"version":1,"command":["agent","${secret}\\n"]}`, 'invalid-command'],
    ] as const) {
      writeFileSync(recordPath(), content);
      const state = resolveCustomAcpCommand(appDir);
      expect(state).toMatchObject({ kind: 'invalid', reason, file: recordPath() });
      expect(JSON.stringify(state)).not.toContain(secret);
      let error: unknown;
      try { readCustomAcpCommand(appDir); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
    }
    rmSync(recordPath());
    mkdirSync(recordPath());
    expect(resolveCustomAcpCommand(appDir)).toMatchObject({ kind: 'invalid', reason: 'unreadable' });
  });

  it('captures a parent IPC state and ignores a different on-disk command', async () => {
    saveCustomAcpCommand(['disk-agent'], appDir);
    const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
    const send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      expect(message).toEqual({ fcb: 'fcb.custom-acp.req' });
      queueMicrotask(() => { process.emit('message', { fcb: 'other' }, undefined); process.emit('message', { fcb: 'fcb.custom-acp', state: { kind: 'set', command: ['parent-agent'] } }, undefined); callback?.(null); });
      return true;
    });
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    let restorePath = () => {};
    try {
      vi.resetModules();
      const runtimePaths = (await import('../src/config/paths')).paths;
      const previous = runtimePaths.appDir;
      runtimePaths.appDir = appDir;
      restorePath = () => { runtimePaths.appDir = previous; };
      const module = await import('../src/agent/custom-acp-command');
      expect(await module.initCustomAcpCommand()).toEqual({ kind: 'set', command: ['parent-agent'] });
      expect(module.customAcpCommand()).toEqual({ kind: 'set', command: ['parent-agent'] });
      expect(await module.initCustomAcpCommand()).toEqual({ kind: 'set', command: ['parent-agent'] });
      expect(send).toHaveBeenCalledTimes(1);
      expect(module.readCustomAcpCommand()).toEqual(['disk-agent']);
    } finally {
      restorePath();
      if (originalSend) Object.defineProperty(process, 'send', originalSend);
      else Reflect.deleteProperty(process, 'send');
    }
  });

  it('rejects malformed parent replies without reading the file', async () => {
    saveCustomAcpCommand(['disk-agent'], appDir);
    const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: (_message: unknown, callback?: (error: Error | null) => void) => {
      queueMicrotask(() => { process.emit('message', { fcb: 'fcb.custom-acp', state: { kind: 'set', command: ['relative/agent'] } }, undefined); callback?.(null); });
      return true;
    } });
    let restorePath = () => {};
    try {
      vi.resetModules();
      const runtimePaths = (await import('../src/config/paths')).paths;
      const previous = runtimePaths.appDir;
      runtimePaths.appDir = appDir;
      restorePath = () => { runtimePaths.appDir = previous; };
      const module = await import('../src/agent/custom-acp-command');
      await expect(module.initCustomAcpCommand()).rejects.toThrow('未收到主进程的自定义 ACP 设置');
    } finally {
      restorePath();
      if (originalSend) Object.defineProperty(process, 'send', originalSend);
      else Reflect.deleteProperty(process, 'send');
    }
  });

  it('times out a parent that never replies without falling back to disk', async () => {
    saveCustomAcpCommand(['disk-agent'], appDir);
    const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: () => true });
    vi.useFakeTimers();
    let restorePath = () => {};
    try {
      vi.resetModules();
      const runtimePaths = (await import('../src/config/paths')).paths;
      const previous = runtimePaths.appDir;
      runtimePaths.appDir = appDir;
      restorePath = () => { runtimePaths.appDir = previous; };
      const module = await import('../src/agent/custom-acp-command');
      const pending = module.initCustomAcpCommand();
      const result = expect(pending).rejects.toThrow('未收到主进程的自定义 ACP 设置');
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      restorePath();
      vi.useRealTimers();
      if (originalSend) Object.defineProperty(process, 'send', originalSend);
      else Reflect.deleteProperty(process, 'send');
    }
  });

  it('round trips the maximum argv through a real Node IPC channel', async () => {
    const childFile = join(root, 'ipc-child.cjs');
    writeFileSync(childFile, `process.on('message', message => process.send({ count: message.command.length, lengths: message.command.map(s => s.length) }));`);
    const child = fork(childFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const command = Array(64).fill('a'.repeat(4096));
      const response = new Promise<unknown>((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
      child.send({ command });
      expect(await response).toEqual({ count: 64, lengths: Array(64).fill(4096) });
    } finally { child.disconnect(); }
  });
});
