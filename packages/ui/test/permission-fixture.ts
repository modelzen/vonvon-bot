import type {ProjectSettingsView} from '@vonvon/protocol';

type Permission = ProjectSettingsView['sections']['permission']['stored'];
export const permissionValue = (mode: Permission['mode'] = 'full'): Permission => ({
  mode, custom: null, guestMode: mode, network: mode !== 'qa',
  options: {
    tiers: [
      {tier: 'qa', name: '只读', summary: '能看工作区，不改文件，不联网。', native: 'Codex：Read Only（read-only 沙箱）'},
      {tier: 'write', name: '工作区可写', summary: '能改工作区里的文件，能联网。', native: 'Codex：Default（workspace-write）'},
      {tier: 'full', name: '完全访问', summary: '不限制，你这个账号能做的它都能做。', native: 'Codex：Full Access（danger-full-access）'},
    ],
    strength: '系统沙箱管住命令的读、写和联网。',
  },
});
