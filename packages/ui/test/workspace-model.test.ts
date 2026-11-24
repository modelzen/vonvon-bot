import {describe, expect, it} from 'vitest';
import {desktopSnapshotSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {routeBack} from '../src/collaboration-navigation';
import {
  addAdditionalDirectory,
  pathBaseName,
  promoteAdditionalDirectory,
  removeAdditionalDirectory,
  removeLegacyRepository,
  replacePrimary,
  sameWorkspaceDraft,
  sharedWorkspaceSummary,
  workspaceSummaryMeta,
} from '../src/settings/workspace-model';

const projectId = 'prj_00000001';
const makeSnapshot = (bindings: Array<{agentId: string; groupId: string}>): DesktopSnapshot => desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
  agents: [
    {id: 'cli_a', name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active'},
    {id: 'cli_b', name: '小发', enabled: true, running: true, connection: 'connected', activation: 'active'},
    {id: 'cli_c', name: '小测', enabled: true, running: true, connection: 'connected', activation: 'active'},
  ],
  groups: [
    {id: 'oc_pay', name: '支付组'},
    {id: 'oc_rel', name: '发布群'},
    {id: 'oc_ops', name: '运维群'},
  ],
  projects: [{id: projectId, name: '支付组', revision: 1, directory: '/code/pay', bindings}],
  memberships: bindings.map(({agentId, groupId}) => ({
    id: JSON.stringify([agentId, groupId]),
    agentId, groupId, projectId, name: groupId, directory: '/code/pay',
    backend: 'codex-appserver', conversation: 'threads', response: 'mention',
    permission: {administrator: 'qa', member: 'qa', network: false}, stale: false,
  })),
  tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/data'},
});

describe('workspace draft transformations', () => {
  it('replaces primary directory directly and removes any duplicate from additional directories', () => {
    const start = {primary: '/default/group', additional: ['/code/app', '/code/docs'], repositories: []};
    expect(replacePrimary(start, '/code/new')).toEqual({primary: '/code/new', additional: ['/code/app', '/code/docs'], repositories: []});
    expect(replacePrimary(start, '/code/app')).toEqual({primary: '/code/app', additional: ['/code/docs'], repositories: []});
  });

  it('adds, promotes, and removes additional directories and legacy repositories without duplicates', () => {
    const start = {primary: '/code/main', additional: ['/code/docs'], repositories: ['/code/legacy-repo']};
    expect(addAdditionalDirectory(start, '/code/main')).toEqual({draft: start, duplicate: 'primary'});
    expect(addAdditionalDirectory(start, '/code/docs')).toEqual({draft: start, duplicate: 'additional'});
    const added = addAdditionalDirectory(start, '/code/extra');
    expect(added.duplicate).toBeUndefined();
    expect(added.draft.additional).toEqual(['/code/docs', '/code/extra']);
    const promoted = promoteAdditionalDirectory(added.draft, '/code/docs');
    expect(promoted).toEqual({primary: '/code/docs', additional: ['/code/main', '/code/extra'], repositories: ['/code/legacy-repo']});
    expect(removeAdditionalDirectory(promoted, '/code/extra').additional).toEqual(['/code/main']);
    expect(removeLegacyRepository(promoted, '/code/legacy-repo').repositories).toEqual([]);
    expect(sameWorkspaceDraft(start, {...start})).toBe(true);
    expect(sameWorkspaceDraft(start, promoted)).toBe(false);
  });

  it('extracts basenames for both POSIX and Windows paths', () => {
    expect(pathBaseName('/Users/clay/code/vonvon-bot')).toBe('vonvon-bot');
    expect(pathBaseName('C:\\work\\vonvon-bot\\')).toBe('vonvon-bot');
    expect(pathBaseName('/')).toBe('/');
  });
});

describe('shared workspace summary and return navigation', () => {
  it('stays quiet for single-binding groups and names peers for same-group or cross-group sharing', () => {
    const single = makeSnapshot([{agentId: 'cli_a', groupId: 'oc_pay'}]);
    expect(sharedWorkspaceSummary(single, single.projects![0], single.memberships[0])).toEqual({shared: false, peerCount: 0, groupCount: 1});
    expect(workspaceSummaryMeta(0, 0)).toBeUndefined();
    expect(workspaceSummaryMeta(2, 0)).toBe('另含 2 个其他目录');

    const sameGroup = makeSnapshot([{agentId: 'cli_a', groupId: 'oc_pay'}, {agentId: 'cli_b', groupId: 'oc_pay'}]);
    expect(sharedWorkspaceSummary(sameGroup, sameGroup.projects![0], sameGroup.memberships[0])).toEqual({
      shared: true, peerCount: 1, groupCount: 1, summary: '与本群「小发」共用',
    });

    const crossGroup = makeSnapshot([
      {agentId: 'cli_a', groupId: 'oc_pay'},
      {agentId: 'cli_a', groupId: 'oc_rel'},
      {agentId: 'cli_a', groupId: 'oc_ops'},
    ]);
    expect(sharedWorkspaceSummary(crossGroup, crossGroup.projects![0], crossGroup.memberships[0])).toEqual({
      shared: true, peerCount: 2, groupCount: 3, summary: '与「发布群」等 2 个群共用',
    });
    expect(workspaceSummaryMeta(1, 1, '与「发布群」共用')).toBe('另含 1 个其他目录 · 另有 1 个代码仓库 · 与「发布群」共用');
  });

  it('returns to the originating group route when a project page was opened from a group', () => {
    const origin = {kind: 'membership' as const, id: 'm1' as never, pane: {kind: 'settings' as const}, parent: {kind: 'group' as const, id: 'oc_pay' as never}};
    const fromGroup = {kind: 'project' as const, id: projectId as never, pane: {kind: 'workspace' as const}, from: {route: origin, label: '支付组'}};
    expect(routeBack(fromGroup)).toEqual(origin);
    expect(routeBack({kind: 'project', id: projectId as never, pane: {kind: 'workspace'}})).toEqual({kind: 'list', view: 'projects'});
  });
});
