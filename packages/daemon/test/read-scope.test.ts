import { describe, expect, it } from 'vitest';
import { claudeReadScope, SECRETS_GET_FILES } from '../src/config/read-scope';

describe('Claude group read scope', () => {
  it('denies private data while allowing bot skills and the credential getter', () => {
    expect(SECRETS_GET_FILES).toEqual(['secrets.enc', 'master.key']);
    expect(claudeReadScope({ dataRoot: '/d', projectsRoot: '/d/projects', appId: 'A', chatId: 'g1' })).toEqual({
      deny: ['/d/bots', '/d/projects', '/d/library', '/d/.keystore.salt', '/d/local-credential', '/d/config.json'],
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
});
