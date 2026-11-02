import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managedCommand, managedToolCommand, stableNode, terminalCommand, toolCommand } from '../src/environment/tool-command';

// 0.9.0 Linux acceptance (task 287): a managed Codex or Claude is on no PATH, yet `vonvon env scan` said 在终端里运行 codex.
describe.skipIf(process.platform === 'win32')('what a terminal types to start a managed copy', () => {
  const roots: string[] = [];
  const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'vonvon-tool-command-')); roots.push(dir); return dir; };
  afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** A managed release laid out as npm writes it: bin/<tool> links to the package's entry. */
  const release = (data: string, tool: 'codex' | 'claude', head: string): string => {
    const generation = '0b6c3c3e-8c1e-4f43-9d1e-2f7f0f6a1b2c';
    const prefix = join(data, 'managed-tools', tool, 'releases', generation);
    const entry = join(prefix, 'lib', 'node_modules', tool, tool === 'codex' ? 'codex.js' : 'claude.exe');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, head, { mode: 0o755 });
    symlinkSync(entry, join(prefix, 'bin', tool));
    writeFileSync(join(data, 'managed-tools', tool, 'current.json'), JSON.stringify({ schemaVersion: 1, tool, state: 'active', generation, version: '1.2.3' }));
    return join(prefix, 'bin', tool);
  };

  it('puts a Node script behind a real node, a native program alone, and quotes what a shell would split', () => {
    const data = root();
    const codex = release(data, 'codex', '#!/usr/bin/env node\nimport "x";\n');
    const claude = release(data, 'claude', '\u007fELF\u0002\u0001');
    expect(terminalCommand(codex, '/srv/vonvon/releases/0.9.0/node/bin/node', 'linux')).toBe(`/srv/vonvon/releases/0.9.0/node/bin/node ${codex}`);
    expect(terminalCommand(claude, '/srv/vonvon/releases/0.9.0/node/bin/node', 'linux')).toBe(claude);
    // the desktop app runs on Electron, not a node: its managed copies run on the computer's own Node
    expect(terminalCommand(codex, '/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot', 'darwin')).toBe(codex);
    expect(terminalCommand('/missing/codex', '/usr/bin/node', 'linux')).toBe('/missing/codex');
    const spaced = join(data, "it's here", 'codex');
    mkdirSync(join(spaced, '..'));
    writeFileSync(spaced, '#! /usr/bin/node --no-warnings\n', { mode: 0o755 });
    expect(terminalCommand(spaced, '/opt/my node/node', 'linux')).toBe(`'/opt/my node/node' '${data}/it'\\''s here/codex'`);
    writeFileSync(spaced, '#!/bin/sh\nexec node x\n', { mode: 0o755 });
    expect(terminalCommand(spaced, '/opt/node/bin/node', 'linux')).toBe(`'${data}/it'\\''s here/codex'`);
    expect(terminalCommand('C:\\Users\\Jo Ann\\.vonvon-bot\\managed-tools\\codex\\releases\\g\\codex.cmd', 'C:\\x\\node.exe', 'win32'))
      .toBe("& 'C:\\Users\\Jo Ann\\.vonvon-bot\\managed-tools\\codex\\releases\\g\\codex.cmd'");
    expect(terminalCommand("C:\\Users\\O'Brien\\codex.cmd", 'C:\\x\\node.exe', 'win32')).toBe("& 'C:\\Users\\O''Brien\\codex.cmd'");
    expect(terminalCommand('C:\\Users\\jo\\codex.cmd', 'C:\\x\\node.exe', 'win32')).toBe('C:\\Users\\jo\\codex.cmd');
  });

  it('names a standalone server\'s Node through current/, which outlives the release it runs from', () => {
    expect(stableNode('/srv/vonvon/releases/0.9.0/node/bin/node', '/srv/vonvon')).toBe('/srv/vonvon/current/node/bin/node');
    expect(stableNode('/srv/vonvon/current/node/bin/node', '/srv/vonvon')).toBe('/srv/vonvon/current/node/bin/node');
    expect(stableNode('/usr/bin/node', '/srv/vonvon')).toBe('/usr/bin/node');
    expect(stableNode('/srv/vonvon/releases/0.9.0/app/node', '/srv/vonvon')).toBe('/srv/vonvon/releases/0.9.0/app/node');
    expect(stableNode('/srv/vonvon/releases/0.9.0/node/bin/node', undefined)).toBe('/srv/vonvon/releases/0.9.0/node/bin/node');
  });

  it('names the managed copy in use, and only that: another install keeps the tool\'s name', () => {
    const data = root();
    expect(managedCommand('/usr/local/bin/codex', data)).toBeUndefined();
    expect(managedCommand(join(data, 'managed-tools-other', 'codex'), data)).toBeUndefined();
    expect(managedCommand(join(data, 'codex-cli', 'releases', 'g', 'node_modules', '.bin', 'codex'), data)).toBe(join(data, 'codex-cli', 'releases', 'g', 'node_modules', '.bin', 'codex'));
    expect(managedToolCommand('claude', data)).toBeUndefined();
    expect(toolCommand('claude', data)).toBe('claude');
    const claude = release(data, 'claude', '\u007fELF\u0002\u0001');
    expect(toolCommand('claude', data)).toBe(claude);
    writeFileSync(join(data, 'managed-tools', 'claude', 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'claude', state: 'disabled' }));
    expect(toolCommand('claude', data)).toBe('claude');
  });
});
