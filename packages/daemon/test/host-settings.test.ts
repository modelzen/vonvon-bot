import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSettings } from '../src/admin/host-settings';
import { readServiceCodexBin, saveServiceCodexBin } from '../src/service/codex-bin';
import { readCustomAcpCommand, resolveCustomAcpCommand } from '../src/agent/custom-acp-command';
import { parseSettingsEdit } from '../src/admin/settings-parse';
import type { HostSettingsView } from '../src/admin/settings-types';

const homes: string[] = [];
const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
beforeEach(() => { Object.defineProperty(process, 'send', { configurable: true, value: undefined }); });
afterEach(() => {
  if (originalSend) Object.defineProperty(process, 'send', originalSend);
  else Reflect.deleteProperty(process, 'send');
});
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const appDir = await mkdtemp(join(tmpdir(), 'vonvon-host-settings-'));
  homes.push(appDir);
  const first = join(appDir, process.platform === 'win32' ? 'codex-first.cmd' : 'codex-first');
  const second = join(appDir, process.platform === 'win32' ? 'codex-second.cmd' : 'codex-second');
  await writeFile(first, '', { mode: 0o700 });
  await writeFile(second, '', { mode: 0o700 });
  const settings = createHostSettings({ appDir, runningCodexBin: first, runningCustomAcpState: resolveCustomAcpCommand(appDir) });
  const read = async (): Promise<HostSettingsView> => {
    const value = await settings.read({ kind: 'host' });
    if (!('runtime' in value)) throw new Error('Expected host view');
    return value;
  };
  const save = (revision: string, codexBin: string | null) => settings.save({ scope: { kind: 'host' }, section: 'execution', revision, patch: { codexBin } });
  return { appDir, first, second, settings, read, save };
}

describe('Host executable settings', () => {
  it('stores a custom ACP argv while keeping the running command until restart', async () => {
    const f = await fixture();
    const initial = await f.read();
    const command = ['/opt/agent with spaces', '--literal=$SECRET'];
    const saved = await f.settings.save({ scope: { kind: 'host' }, section: 'execution', revision: initial.sections.execution.revision, patch: { customAcpCommand: command } });
    expect(saved.kind).toBe('saved');
    if (saved.kind === 'saved') expect(saved.effects).toMatchObject([{ when: 'restart', fields: ['codexBin', 'customAcpCommand'] }]);
    expect(readCustomAcpCommand(f.appDir)).toEqual(command);
    expect((await f.read()).sections.execution).toMatchObject({ stored: { customAcpCommand: command }, effective: { customAcpCommand: null } });
    const reopened = createHostSettings({ appDir: f.appDir, runningCustomAcpState: resolveCustomAcpCommand(f.appDir) });
    const restarted = await reopened.read({ kind: 'host' });
    if (!('runtime' in restarted)) throw new Error('Expected host view');
    expect(restarted.sections.execution.effective.customAcpCommand).toEqual(command);
    expect(restarted.sections.execution.revision).not.toBe(initial.sections.execution.revision);
  });

  it('rejects invalid custom ACP argv without replacing the stored command', async () => {
    const f = await fixture();
    const initial = await f.read();
    const saved = await f.settings.save({ scope: { kind: 'host' }, section: 'execution', revision: initial.sections.execution.revision, patch: { customAcpCommand: ['agent'] } });
    expect(saved.kind).toBe('saved');
    const current = await f.read();
    const invalid = await f.settings.save({ scope: { kind: 'host' }, section: 'execution', revision: current.sections.execution.revision, patch: { customAcpCommand: ['relative/agent'] } });
    expect(invalid).toMatchObject({ kind: 'rejected', fields: [{ field: 'customAcpCommand' }] });
    expect(readCustomAcpCommand(f.appDir)).toEqual(['agent']);
  });

  it('accepts a custom command through the owner edit parser', () => {
    const edit = { scope: { kind: 'host' }, section: 'execution', revision: 'current', patch: { customAcpCommand: ['agent', '--stdio'] } };
    expect(parseSettingsEdit(edit)).toEqual(edit);
    expect(() => parseSettingsEdit({ ...edit, patch: { customAcpCommand: ['relative/agent'] } })).toThrow();
  });

  it('shows invalid stored state without throwing and permits null repair', async () => {
    const f = await fixture();
    await writeFile(join(f.appDir, 'custom-acp.json'), '{bad-one');
    const first = await f.read();
    expect(first.sections.execution).toMatchObject({ stored: { customAcpCommand: null }, effective: { customAcpCommand: null } });
    await writeFile(join(f.appDir, 'custom-acp.json'), '{bad-two');
    const second = await f.read();
    expect(second.sections.execution.revision).not.toBe(first.sections.execution.revision);
    const saved = await f.settings.save({ scope: { kind: 'host' }, section: 'execution', revision: second.sections.execution.revision, patch: { customAcpCommand: null } });
    expect(saved.kind).toBe('saved');
    expect(readCustomAcpCommand(f.appDir)).toBeNull();
  });

  it('keeps a captured valid command effective after the file becomes corrupt', async () => {
    const f = await fixture();
    const command = ['agent-A'];
    const running = createHostSettings({ appDir: f.appDir, runningCustomAcpState: { kind: 'set', command: ['agent-A'] } });
    await writeFile(join(f.appDir, 'custom-acp.json'), '{corrupt');
    const view = await running.read({ kind: 'host' });
    if (!('runtime' in view)) throw new Error('Expected host view');
    expect(view.sections.execution).toMatchObject({ stored: { customAcpCommand: null }, effective: { customAcpCommand: command } });
    const saved = await running.save({ scope: { kind: 'host' }, section: 'execution', revision: view.sections.execution.revision, patch: { customAcpCommand: ['agent-B'] } });
    expect(saved.kind).toBe('saved');
    const after = await running.read({ kind: 'host' });
    if (!('runtime' in after)) throw new Error('Expected host view');
    expect(after.sections.execution).toMatchObject({ stored: { customAcpCommand: ['agent-B'] }, effective: { customAcpCommand: command } });
  });

  it('keeps startup-invalid effective state and diagnostics after repair until a new host captures it', async () => {
    const f = await fixture();
    const file = join(f.appDir, 'custom-acp.json');
    await writeFile(file, '{broken');
    vi.resetModules();
    const { paths } = await import('../src/config/paths');
    const previous = paths.appDir;
    paths.appDir = f.appDir;
    let restoreRestartedPath = () => {};
    try {
      const authority = await import('../src/agent/custom-acp-command');
      expect(await authority.initCustomAcpCommand()).toEqual({ kind: 'invalid', file, reason: 'not-json' });
      const { createHostSettings: createRunningSettings } = await import('../src/admin/host-settings');
      const { createBackend } = await import('../src/agent');
      const running = createRunningSettings({ appDir: f.appDir });
      const before = await running.read({ kind: 'host' });
      if (!('runtime' in before)) throw new Error('Expected host view');
      expect(before.sections.execution).toMatchObject({ stored: { customAcpCommand: null }, effective: { customAcpCommand: null } });
      const diagnostic = await createBackend('custom-acp').doctor();
      expect(diagnostic).toMatchObject({ ok: false, hint: expect.stringContaining(file) });
      expect((await running.save({ scope: { kind: 'host' }, section: 'execution', revision: before.sections.execution.revision, patch: { customAcpCommand: ['repaired-agent'] } })).kind).toBe('saved');
      const repaired = await running.read({ kind: 'host' });
      if (!('runtime' in repaired)) throw new Error('Expected host view');
      expect(repaired.sections.execution).toMatchObject({ stored: { customAcpCommand: ['repaired-agent'] }, effective: { customAcpCommand: null } });
      expect(await createBackend('custom-acp').doctor()).toEqual(diagnostic);
      expect(authority.customAcpCommand()).toEqual({ kind: 'invalid', file, reason: 'not-json' });

      vi.resetModules();
      const restartedPaths = (await import('../src/config/paths')).paths;
      const originalRestartedAppDir = restartedPaths.appDir;
      restartedPaths.appDir = f.appDir;
      restoreRestartedPath = () => { restartedPaths.appDir = originalRestartedAppDir; };
      const restartedAuthority = await import('../src/agent/custom-acp-command');
      expect(await restartedAuthority.initCustomAcpCommand()).toEqual({ kind: 'set', command: ['repaired-agent'] });
      const { createHostSettings: createRestartedSettings } = await import('../src/admin/host-settings');
      const restarted = await createRestartedSettings({ appDir: f.appDir }).read({ kind: 'host' });
      if (!('runtime' in restarted)) throw new Error('Expected host view');
      expect(restarted.sections.execution.effective.customAcpCommand).toEqual(['repaired-agent']);
    } finally {
      paths.appDir = previous;
      restoreRestartedPath();
    }
  });

  it('uses a stable unreadable fingerprint and still tracks the Codex selection', async () => {
    const f = await fixture();
    await mkdir(join(f.appDir, 'custom-acp.json'));
    const first = await f.read();
    expect((await f.read()).sections.execution.revision).toBe(first.sections.execution.revision);
    saveServiceCodexBin(f.first, f.appDir);
    expect((await f.read()).sections.execution.revision).not.toBe(first.sections.execution.revision);
  });
  it('persists a selection without pretending the running executable changed', async () => {
    const f = await fixture();
    const initial = await f.read();
    const result = await f.save(initial.sections.execution.revision, f.second);
    expect(result.kind).toBe('saved');
    if (result.kind === 'saved') expect(result.effects.map(effect => effect.when)).toEqual(['restart']);
    expect(readServiceCodexBin(f.appDir)).toBe(f.second);
    expect((await f.read()).sections.execution.effective.codexBin).toBe(f.first);
    const reopened = createHostSettings({ appDir: f.appDir, runningCodexBin: f.second, runningCustomAcpState: resolveCustomAcpCommand(f.appDir) });
    const value = await reopened.read({ kind: 'host' });
    if (!('runtime' in value)) throw new Error('Expected host view');
    expect(value.sections.execution.stored.codexBin).toBe(f.second);
    expect(value.sections.execution.effective.codexBin).toBe(f.second);
  });

  it('persists an explicit reset even when no previous service selection exists', async () => {
    const f = await fixture();
    const initial = await f.read();
    expect(readServiceCodexBin(f.appDir)).toBeUndefined();
    expect((await f.save(initial.sections.execution.revision, null)).kind).toBe('saved');
    expect(readServiceCodexBin(f.appDir)).toBeNull();
    expect((await f.read()).runtime.codexBin).toBe(f.first);
  });

  it('rejects a stale competing edit and accepts an identical retry', async () => {
    const f = await fixture();
    const initial = await f.read();
    const results = await Promise.all([
      f.save(initial.sections.execution.revision, f.first),
      f.save(initial.sections.execution.revision, f.second),
    ]);
    expect(results.map(result => result.kind)).toEqual(['saved', 'conflict']);
    expect(readServiceCodexBin(f.appDir)).toBe(f.first);
    const retry = await f.save(initial.sections.execution.revision, f.first);
    expect(retry.kind).toBe('saved');
    if (retry.kind === 'saved') expect(retry.effects).toEqual([]);
  });

  it('refuses missing, relative, directory and malformed paths without overwriting selection', async () => {
    const f = await fixture();
    saveServiceCodexBin(f.first, f.appDir);
    for (const path of ['relative/codex', join(f.appDir, 'missing'), f.appDir, `${f.second}\nother`]) {
      const before = await f.read();
      expect((await f.save(before.sections.execution.revision, path)).kind).toBe('rejected');
      expect(readServiceCodexBin(f.appDir)).toBe(f.first);
    }
  });

  it('refuses preview mutations and leaves the service record absent', async () => {
    const f = await fixture();
    const preview = createHostSettings({ appDir: f.appDir, readonly: true, runningCustomAcpState: resolveCustomAcpCommand(f.appDir) });
    const initial = await f.read();
    expect((await preview.save({ scope: { kind: 'host' }, section: 'execution', revision: initial.sections.execution.revision, patch: { codexBin: f.first } })).kind).toBe('unavailable');
    expect(readServiceCodexBin(f.appDir)).toBeUndefined();
  });
});
