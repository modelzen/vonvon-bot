import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureNode } from './fixture-node';
import type { EnvironmentRequest } from '@vonvon/protocol';
import { EnvironmentService } from '../src/environment/service';

const processTestTimeout = process.platform === 'win32' ? 30_000 : 5_000;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'environment-boundaries-'));
  directories.push(dir);
  const nodePath = await fixtureNode(dir);
  const cli = join(dir, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
  const script = process.platform === 'win32' ? join(dir, 'lark-cli.cjs') : cli;
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'profile' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'profile') {
  fs.appendFileSync(path.join(process.env.HOME, 'events'), args[1] + '\\n');
  process.stdin.resume();
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(process.env.HOME, 'release'))) { clearInterval(timer); process.exit(0); }
  }, 10);
}
`, { mode: 0o700 });
  if (process.platform === 'win32') await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0lark-cli.cjs" %*\r\n`);
  const service = new EnvironmentService({ home: dir, getDataRoot: () => dir, resolveCodex: () => null, nodePath, path: dir, fetchLatest: async () => null });
  return { dir, cli, service };
}

const mutations = [
  { type: 'profileUse', name: 'one' },
  { type: 'profileAdd', name: 'one', appId: 'test-app', appSecret: 'test-secret', brand: 'feishu', use: true },
] satisfies EnvironmentRequest[];

for (const request of mutations) {
  it(`${request.type} reserves ownership during resolution and execution, then releases it`, async () => {
    const { dir, service } = await fixture();
    let releaseResolution = () => {};
    const resolution = new Promise<void>(resolve => { releaseResolution = resolve; });
    const resolveTool = service['resolveTool'].bind(service);
    let first = true;
    service['resolveTool'] = async tool => {
      if (first) { first = false; await resolution; }
      return resolveTool(tool);
    };
    const events = join(dir, 'events');
    await writeFile(events, '');
    const watcher = watch(events);
    const executionStarted = once(watcher, 'change');
    const pending = service.run(request);
    try {
      for (const competitor of [{ type: 'startLogin', tool: 'lark-cli' } satisfies EnvironmentRequest, ...mutations]) {
        expect(await service.run(competitor)).toMatchObject({ kind: 'refused', code: 'busy' });
      }
      releaseResolution();
      await Promise.race([executionStarted, pending.then(reply => { throw new Error(`Profile mutation completed before execution was observed: ${JSON.stringify(reply)}`); })]);
      expect(await readFile(events, 'utf8')).toBe(request.type === 'profileUse' ? 'use\n' : 'add\n');
      for (const competitor of [{ type: 'startLogin', tool: 'lark-cli' } satisfies EnvironmentRequest, ...mutations]) {
        expect(await service.run(competitor)).toMatchObject({ kind: 'refused', code: 'busy' });
      }
      await writeFile(join(dir, 'release'), 'go');
      expect(await pending).toEqual({ kind: 'profiles', profiles: [] });
      expect(await service.run(request)).toEqual({ kind: 'profiles', profiles: [] });
    } finally {
      watcher.close();
      releaseResolution();
      await writeFile(join(dir, 'release'), 'go');
      await pending;
      await service.close();
    }
  }, processTestTimeout);

  it(`${request.type} releases ownership after resolution failure or a missing tool`, async () => {
    const { service } = await fixture();
    service['resolveTool'] = async () => { throw new Error('fixture resolution failure'); };
    try {
      expect(await service.run(request)).toMatchObject({ kind: 'refused', code: 'environment-failed' });
      service['resolveTool'] = async () => null;
      expect(await service.run(request)).toMatchObject({ kind: 'refused', code: 'tool-missing' });
      expect(await service.run(request)).toMatchObject({ kind: 'refused', code: 'tool-missing' });
    } finally { await service.close(); }
  });
}

for (const tool of ['claude', 'lark-cli'] as const) {
  for (const suffix of ['.exe', '.cmd', '.bat', '.com']) {
    it(`resolves an external ${tool}${suffix} with controlled Windows platform semantics`, async () => {
      const { dir, cli, service } = await fixture();
      await rm(cli);
      const executable = join(dir, `${tool}${suffix}`);
      await writeFile(executable, 'fake Windows executable');
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      if (!descriptor) throw new Error('Missing platform descriptor');
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        expect(await service['resolveTool'](tool)).toEqual({ executable, ownership: 'external' });
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
        await service.close();
      }
    });
  }
}

it('preserves exact executable precedence on Windows', async () => {
  const { dir, service } = await fixture();
  const cli = join(dir, 'lark-cli');
  await writeFile(cli, 'fake exact executable');
  await writeFile(join(dir, 'lark-cli.cmd'), 'fake Windows shim');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Missing platform descriptor');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(await service['resolveTool']('lark-cli')).toEqual({ executable: cli, ownership: 'external' });
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    await service.close();
  }
});
