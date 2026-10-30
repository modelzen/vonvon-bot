import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentService } from '../src/environment/service';
import { refreshCodexResolution } from '../src/agent/codex-appserver/locate';
import { managedToolSelection } from '../src/agent/codex-appserver/managed-tools';
import { writeNodeExecutable } from './helpers/node-executable';

const roots: string[] = [];
const services: EnvironmentService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture(externalVersion?: string) {
  const home = mkdtempSync(join(tmpdir(), 'codex-environment-install-'));
  roots.push(home);
  const dataRoot = join(home, 'data');
  const control = join(home, 'npm-mode');
  const trace = join(home, 'npm-args');
  writeFileSync(control, 'success');
  const template = writeNodeExecutable(home, 'codex-template', 'console.log("codex-cli 9.2.0")');
  const launcher = readFileSync(template.bin, 'utf8');
  const npm = writeNodeExecutable(home, 'npm-fixture', `
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)));
    const mode = fs.readFileSync(${JSON.stringify(control)}, 'utf8');
    if (mode === 'fail') process.exit(1);
    const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
    const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    const pkg = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@openai/codex');
    fs.mkdirSync(pkg, {recursive: true}); fs.mkdirSync(binDir, {recursive: true});
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name:'@openai/codex',version:'9.2.0'}));
    const script = path.join(binDir, 'codex.cjs');
    fs.writeFileSync(script, mode === 'wrong-version' ? 'console.log("codex-cli 9.1.0")' : 'console.log("codex-cli 9.2.0")');
    const bin = path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    fs.writeFileSync(bin, ${JSON.stringify(launcher)}.split(${JSON.stringify(template.script)}).join(script), {mode:0o755});
  `).bin;
  const externalDir = join(home, 'external');
  mkdirSync(externalDir);
  const external = externalVersion ? writeNodeExecutable(externalDir, 'codex', `console.log('codex-cli ${externalVersion}')`).bin : null;
  vi.stubEnv('CODEX_BIN', '');
  vi.stubEnv('VONVON_NPM_CLI', '');
  const context = { home, dataRoot, env: { PATH: externalDir } };
  const resolve = vi.fn(() => refreshCodexResolution({ ...context, force: true }));
  const service = new EnvironmentService({ home, getDataRoot: () => dataRoot, nodePath: process.execPath, npmPath: npm, path: externalDir, resolveCodex: resolve });
  services.push(service);
  const pointer = join(dataRoot, 'managed-tools', 'codex', 'current.json');
  return { service, home, npm, externalDir, dataRoot, control, trace, resolve, pointer, external };
}

it('installs latest through the real environment engine, publishes its pointer and selects the new executable', async () => {
  const f = fixture();
  const reply = await f.service.run({ type: 'install', tool: 'codex' });
  expect(reply, JSON.stringify(reply)).toMatchObject({ kind: 'applied' });
  expect(JSON.parse(readFileSync(f.trace, 'utf8'))).toContain('@openai/codex@latest');
  const selected = managedToolSelection(f.dataRoot, 'codex');
  expect(selected).toMatchObject({ kind: 'active', version: '9.2.0' });
  expect(await f.resolve()).toBe(selected.kind === 'active' ? selected.executable : null);
  expect(existsSync(join(f.dataRoot, 'codex-cli', 'current.json'))).toBe(false);
});

it.each(['fail', 'wrong-version'])('retains the prior generation and pointer after %s', async mode => {
  const f = fixture();
  expect(await f.service.run({ type: 'install', tool: 'codex' })).toMatchObject({ kind: 'applied' });
  const pointer = readFileSync(f.pointer, 'utf8');
  const previous = await f.resolve();
  const releases = join(dirname(f.pointer), 'releases');
  const generations = readdirSync(releases);
  writeFileSync(f.control, mode);
  expect(await f.service.run({ type: 'update', tool: 'codex' })).toMatchObject({ kind: 'refused' });
  expect(readFileSync(f.pointer, 'utf8')).toBe(pointer);
  expect(readdirSync(releases)).toEqual(generations);
  expect(await f.resolve()).toBe(previous);
  expect(previous && existsSync(previous)).toBe(true);
});

it('keeps a verified managed fallback when a newer external Codex remains selected', async () => {
  const f = fixture('9.3.0');
  expect(await f.service.run({ type: 'install', tool: 'codex' })).toMatchObject({ kind: 'applied' });
  const fallback = managedToolSelection(f.dataRoot, 'codex');
  expect(fallback).toMatchObject({ kind: 'active', version: '9.2.0' });
  expect(await f.resolve()).toBe(f.external);
  rmSync(f.external!);
  expect(await f.resolve()).toBe(fallback.kind === 'active' ? fallback.executable : null);
});


it('serializes publication and uninstall across service instances sharing a data root', async () => {
  const f = fixture();
  let published!: () => void;
  const atPublication = new Promise<void>(resolve => { published = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resolveNormally = f.resolve.getMockImplementation()!;
  f.resolve.mockImplementationOnce(async () => {
    published();
    await gate;
    return resolveNormally();
  });
  const other = new EnvironmentService({ home: f.home, getDataRoot: () => f.dataRoot,
    nodePath: process.execPath, npmPath: f.npm, path: f.externalDir, resolveCodex: f.resolve });
  services.push(other);
  const installing = f.service.run({ type: 'install', tool: 'codex' });
  try {
    await Promise.race([atPublication, installing.then(reply => { throw new Error(JSON.stringify(reply)); })]);
    const pointer = readFileSync(f.pointer, 'utf8');
    for (const type of ['install', 'update', 'uninstall'] as const) {
      expect(await other.run({ type, tool: 'codex' }), type).toMatchObject({ kind: 'refused', code: 'busy' });
      expect(readFileSync(f.pointer, 'utf8')).toBe(pointer);
    }
  } finally {
    release();
  }
  expect(await installing).toMatchObject({ kind: 'applied' });
  expect(await other.run({ type: 'uninstall', tool: 'codex' })).toMatchObject({ kind: 'applied' });
  expect(managedToolSelection(f.dataRoot, 'codex')).toEqual({ kind: 'disabled' });
});
