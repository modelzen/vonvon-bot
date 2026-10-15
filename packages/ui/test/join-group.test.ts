import {expect, it} from 'vitest';
import {collaborationRequestSchema} from '@vonvon/protocol';
import {projectNameProblem} from '../src/JoinGroupDialog';
import {canSaveAll} from '../src/settings/DraftGuard';

it('rejects the names the protocol would refuse, before submit', () => {
  for (const name of ['前端/后端', 'a\\b', '换\n行', '制\t表']) {
    expect(projectNameProblem(name)).toBeDefined();
    expect(collaborationRequestSchema.safeParse({action: 'createProject', agentId: 'cli_join', name, folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}).success).toBe(false);
  }
  expect(projectNameProblem('前端/后端')).toContain('/ 或 \\');
  // The dialog sends the trimmed name, like the protocol's own trim.
  for (const name of ['研发群', '（未命名群）', 'A-B_C.d 1', ' 末尾换行\n']) {
    expect(projectNameProblem(name)).toBeUndefined();
    expect(collaborationRequestSchema.safeParse({action: 'createProject', agentId: 'cli_join', name, folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}).success).toBe(true);
  }
});

it('offers 保存并离开 only when every open draft can be saved', () => {
  const save = async () => true;
  expect(canSaveAll([{save}, {save}])).toBe(true);
  // JoinGroupDialog registers no save: saving would create a real Feishu group.
  expect(canSaveAll([{}])).toBe(false);
  expect(canSaveAll([{save}, {}])).toBe(false);
});
