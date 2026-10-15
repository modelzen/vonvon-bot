import { mkdtemp, mkdir, rm, writeFile, symlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeGeneratedDefinition, renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-definition-'));
  directories.push(base);
  const root = await resolveServiceRoot(base);
  return { root, port: 43121, distribution: { kind: 'npm' as const, executable: '/usr/local/bin/node', entry: '/opt/Vonvon/bin/vonvon.mjs' }, capturedPath: '/usr/local/bin:/usr/bin' };
}

describe.skipIf(process.platform === 'win32')('POSIX definition bytes and real filesystem readback', () => {
  it('owns root verification and resolves directory aliases', async () => {
    const input = await fixture();
    const alias = join(input.root, 'alias');
    await symlink(input.root, alias);
    expect(await resolveServiceRoot(alias)).toBe(input.root);
    const file = join(input.root, 'file');
    await writeFile(file, '');
    await expect(resolveServiceRoot(file)).rejects.toThrow('not a directory');
    await expect(resolveServiceRoot(join(input.root, 'missing'))).rejects.toThrow();
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} recognizes ours, other-root, absent and malformed without invoking a manager`, async () => {
      const input = await fixture();
      const target = serviceTarget({ platform, home: input.root, xdgConfigHome: undefined });
      const location = target.platform === 'darwin' ? target.plistPath : target.unitPath;
      const bytes = renderDefinition({ ...input, target });
      const content = bytes.platform === 'darwin' ? bytes.plist : bytes.unit;
      expect(await readRegistration({ target, requestedRoot: input.root })).toEqual({ kind: 'absent' });
      await mkdir(join(location, '..'), { recursive: true });
      await writeFile(location, content);
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('ours');
      const other = await fixture();
      expect((await readRegistration({ target, requestedRoot: other.root })).kind).toBe('other-root');
      await writeFile(location, Buffer.concat([content, Buffer.from('\nmalicious command\n')]));
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
      await writeFile(location, Buffer.from([0xff, 0xfe, 0xff]));
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
      await rm(location);
      await symlink(join(input.root, 'missing'), location);
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
    });
  }

  it('fails closed for directories, unreadable files, unresolved roots and noncanonical recorded roots', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    if (target.platform !== 'linux') throw new Error('Expected unit target');
    await mkdir(target.unitPath, { recursive: true });
    expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
    await rm(target.unitPath, { recursive: true });
    const bytes = renderDefinition({ ...input, target });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    await writeFile(target.unitPath, bytes.unit);
    expect((await readRegistration({ target, requestedRoot: join(input.root, 'missing') })).kind).toBe('unrecognized');
    await chmod(target.unitPath, 0);
    try {
      if (process.getuid?.() !== 0) {
        const result = await readRegistration({ target, requestedRoot: input.root });
        expect(result.kind).toBe('unrecognized');
        if (result.kind === 'unrecognized') expect(result.location).toBe(target.unitPath);
      }
    } finally { await chmod(target.unitPath, 0o600); }
    const alias = join(input.root, 'alias');
    await symlink(input.root, alias);
    const aliased = Buffer.from(bytes.unit).toString().split(input.root).join(alias);
    await writeFile(target.unitPath, aliased);
    expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
    await rm(alias);
    expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
  });

  it('serializes independent launchd argv, XML literals and restart policy', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'darwin', home: input.root });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'desktop', executable: '/Applications/Vonvon & "Bot".app/Electron', entry: "/app/<entry>'/main.js" } });
    if (bytes.platform !== 'darwin') throw new Error('Expected plist');
    const text = Buffer.from(bytes.plist).toString();
    expect(text).toContain('<key>ProgramArguments</key><array><string>/Applications/Vonvon &amp; &quot;Bot&quot;.app/Electron</string><string>/app/&lt;entry&gt;&apos;/main.js</string><string>daemon</string><string>run</string><string>--port</string><string>43121</string></array>');
    expect(text).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>');
    expect(text).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(text).toContain('<key>ThrottleInterval</key><integer>5</integer>');
    expect(text).not.toMatch(/ExitTimeOut|CODEX_BIN/);
    expect(decodeGeneratedDefinition(target, bytes).distribution.kind).toBe('desktop');
    for (const changed of [text.replace('&amp;', '&unknown;'), text.replace('<key>PATH</key>', '<key>PATH</key><key>PATH</key>'), text.replace('<false/>', '<true/>'), text + '<!-- extra -->']) {
      expect(() => decodeGeneratedDefinition(target, { platform: 'darwin', plist: Buffer.from(changed) })).toThrow();
    }
  });

  it('serializes systemd percent and dollar literals with fixed policy and rejects injected directives', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'npm', executable: '/node %n/$HOME/"bin"', entry: '/app/$HOME/中文\\entry.mjs' }, capturedPath: '/bin/%n:$HOME' });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    const text = Buffer.from(bytes.unit).toString();
    expect(text).toContain('ExecStart="/node %%n/$HOME/\\"bin\\"" "/app/$$HOME/中文\\\\entry.mjs" daemon run --port 43121\n');
    expect(text).toContain('Environment="PATH=/bin/%%n:$HOME"\n');
    expect(text).toContain('Restart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\n');
    expect(text).toContain('WantedBy=default.target\n');
    expect(text).not.toMatch(/CODEX_BIN|ELECTRON_RUN_AS_NODE/);
    expect(decodeGeneratedDefinition(target, bytes).distribution.executable).toBe('/node %n/$HOME/"bin"');
    for (const changed of [text + 'ExecStartPre=/bin/evil\n', text.replace('Restart=on-failure', 'Restart=always'), text.replace('%%n', '%n'), text.replace('$$HOME', '$HOME'), text.replace('[Service]', '[Service]\nEnvironment="VONVON_HOME=/evil"')]) {
      expect(() => decodeGeneratedDefinition(target, { platform: 'linux', unit: Buffer.from(changed) })).toThrow();
    }
  });

  it('decodes literal executable dollars separately from expanded argument dollars', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'npm', executable: '/opt/$literal/node', entry: '/opt/$literal/main.mjs' } });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    const text = Buffer.from(bytes.unit).toString();
    expect(text.split('\n').find((line) => line.startsWith('ExecStart='))).toBe('ExecStart="/opt/$literal/node" "/opt/$$literal/main.mjs" daemon run --port 43121');
    expect(decodeGeneratedDefinition(target, bytes).distribution).toEqual({ kind: 'npm', executable: '/opt/$literal/node', entry: '/opt/$literal/main.mjs' });
    const doubledExecutable = text.replace('"/opt/$literal/node"', () => '"/opt/$$literal/node"');
    expect(decodeGeneratedDefinition(target, { platform: 'linux', unit: Buffer.from(doubledExecutable) }).distribution.executable).toBe('/opt/$$literal/node');
  });

  it('includes Electron Node mode only for the desktop systemd definition', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'desktop', executable: '/opt/Vonvon/electron', entry: '/opt/Vonvon/main.js' } });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    expect(Buffer.from(bytes.unit).toString()).toContain('ExecStart="/opt/Vonvon/electron" "/opt/Vonvon/main.js" daemon run --port 43121\n');
    expect(Buffer.from(bytes.unit).toString()).toContain('Environment="ELECTRON_RUN_AS_NODE=1"\n');
    expect(decodeGeneratedDefinition(target, bytes).distribution.kind).toBe('desktop');
  });

  it('rejects unsafe input before serialization', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    for (const port of [0, 65536, NaN, 1.5]) expect(() => renderDefinition({ ...input, target, port })).toThrow();
    for (const kind of ['development', 'unknown'] as const) expect(() => renderDefinition({ ...input, target, distribution: { kind } })).toThrow();
    for (const capturedPath of ['a\nb', 'a\u0000b', '\ud800']) expect(() => renderDefinition({ ...input, target, capturedPath })).toThrow();
    expect(() => renderDefinition({ ...input, target, distribution: { kind: 'npm', executable: 'node', entry: '/entry' } })).toThrow();
  });
});

it('keeps pure service modules disconnected from legacy mutation and process execution', async () => {
  for (const file of ['identity', 'definitions', 'registration']) {
    const source = await readFile(new URL(`../src/service/${file}.ts`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:child_process|from ['"]\.\/(?:control|adapter|launchd|systemd)['"]|CODEX_BIN|feishu|bridge/);
  }
});
