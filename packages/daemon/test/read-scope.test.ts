import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeReadScope, ROOT_SECRETS, SECRETS_GET_FILES } from '../src/config/read-scope';
import { createClientRegistry } from '../src/remote/clients';
import { startFixture } from './server-fixture';

describe('Claude group read scope', () => {
  it('denies private data while allowing bot skills and the credential getter', () => {
    expect(SECRETS_GET_FILES).toEqual(['secrets.enc', 'master.key']);
    expect(claudeReadScope({ dataRoot: '/d', projectsRoot: '/d/projects', appId: 'A', chatId: 'g1' })).toEqual({
      deny: ['/d/bots', '/d/projects', '/d/library', '/d/.keystore.salt', '/d/local-credential', '/d/config.json', '/d/device.json', '/d/clients.json', '/d/remote.json'],
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
  // devices 4.1: the device key and the client list are owner-only files a bot session must not read. main 必败: they were not listed.
  it.skipIf(process.platform === 'win32')('lists every owner-only file the daemon keeps at the data root', async () => {
    const fixture = await startFixture();
    try {
      const clients = await createClientRegistry(fixture.home);
      await clients.add({ name: '笔记本', publicKey: 'k'.repeat(43), clientKind: 'desktop', address: '192.0.2.5:50000', invitedBy: 'local' });
      await clients.close();
      const ownerOnly: string[] = [];
      for (const name of await readdir(fixture.home)) if (((await stat(join(fixture.home, name))).mode & 0o777) === 0o600) ownerOnly.push(name);
      expect(ownerOnly).toEqual(expect.arrayContaining(['local-credential', 'device.json', 'clients.json']));
      // machine-id is the device id every server info and pairing link carries: owner-only, but no secret.
      expect(ownerOnly.filter(name => name !== 'machine-id' && !(ROOT_SECRETS as readonly string[]).includes(name))).toEqual([]);
    } finally { await fixture.close(); }
  });
});
