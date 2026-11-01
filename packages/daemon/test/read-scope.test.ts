import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realScope } from '../src/agent/claude-agent/read-scope';
import { claudeReadScope, ROOT_SECRETS, SECRETS_GET_FILES } from '../src/config/read-scope';
import { createClientRegistry } from '../src/remote/clients';
import { startFixture } from './server-fixture';

describe('Claude group read scope', () => {
  it('denies private data while allowing bot skills and the credential getter', () => {
    expect(SECRETS_GET_FILES).toEqual(['secrets.enc', 'master.key']);
    expect(claudeReadScope({ dataRoot: '/d', projectsRoot: '/d/projects', appId: 'A', chatId: 'g1' })).toEqual({
      deny: ['/d/bots', '/d/projects', '/d/library', '/d/devices', '/d/.keystore.salt', '/d/local-credential', '/d/config.json'],
      allow: ['/d/bots/A/skills'],
    });
  });
  it('includes an external projects root and explicitly allowed inbox', () => {
    const scope = claudeReadScope({ dataRoot: '/d', projectsRoot: '/p', appId: 'A', extraAllow: ['/d/bots/A/inbox'] });
    expect(scope.deny).toContain('/p');
    expect(scope.allow).toEqual(['/d/bots/A/skills', '/d/bots/A/inbox']);
  });
  it('does not form paths from unsafe bot or chat identifiers or allow file memories', () => {
    expect(claudeReadScope({ dataRoot: '/d', projectsRoot: '/p', appId: 'a/b', chatId: '../g2' }).allow).toEqual([]);
    expect(claudeReadScope({ dataRoot: '/d', projectsRoot: '/p', appId: 'A', chatId: '../g2' }).allow).toEqual(['/d/bots/A/skills']);
  });
  // devices 4.1: the device key and the client list are owner-only files a bot session must not read. They sit in `devices/`,
  // denied as a directory (D1-SEC-2, D1-SEC-3, D1-R6): a session started before clients.json existed still cannot read it, a
  // replaced file stays hidden in the sandbox, and so do the temporary files. main 必败: they were not listed.
  it.skipIf(process.platform === 'win32')('keeps every owner-only file in the deny list, the devices files under one denied directory', async () => {
    const fixture = await startFixture();
    const cwd = await mkdtemp(join(tmpdir(), 'vonvon-scope-cwd-'));
    try {
      const devices = join(fixture.home, 'devices');
      const thread = await realScope(claudeReadScope({ dataRoot: fixture.home, projectsRoot: join(fixture.home, 'projects'), appId: 'A' }), cwd, cwd);
      expect(thread.deny).toContain(devices);
      expect(await readdir(devices)).not.toContain('clients.json');
      const clients = await createClientRegistry(fixture.home);
      await clients.add({ name: '笔记本', publicKey: 'k'.repeat(43), clientKind: 'desktop', address: '192.0.2.5:50000', invitedBy: 'local' });
      await clients.close();
      const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
      expect(await mode(devices)).toBe(0o700);
      for (const name of await readdir(devices)) expect([name, await mode(join(devices, name))]).toEqual([name, 0o600]);
      expect(await readdir(devices)).toEqual(expect.arrayContaining(['device.json', 'clients.json']));
      const ownerOnly: string[] = [];
      for (const name of await readdir(fixture.home)) if (await mode(join(fixture.home, name)) === 0o600) ownerOnly.push(name);
      expect(ownerOnly).toContain('local-credential');
      // machine-id is the device id every server info and pairing link carries: owner-only, but no secret.
      expect(ownerOnly.filter(name => name !== 'machine-id' && !(ROOT_SECRETS as readonly string[]).includes(name))).toEqual([]);
    } finally {
      await fixture.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
