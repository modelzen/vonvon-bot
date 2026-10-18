import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {collaborationRequestSchema} from '@vonvon/protocol';
import {RpcError} from '@vonvon/client/browser';
import {CREATION_UNKNOWN, CreationLockNotice, creationFailure, projectNameProblem} from '../src/JoinGroupDialog';
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

it('s36d1: says a creation may have made a group unless the daemon itself refused it', () => {
  expect(creationFailure(new RpcError('conflict', '项目名「x」已存在'))).toEqual({kind: 'refused', message: '项目名「x」已存在'});
  expect(creationFailure(new RpcError('invalid_folder_token', '目录选择已过期，请重新选择。'))).toEqual({kind: 'refused', message: '目录选择已过期，请重新选择。'});
  for (const failure of [new RpcError('outcome_unknown', 'anything'), new Error('Daemon connection closed'), new Error('Daemon response method or envelope mismatch'), 'thrown']) {
    expect(creationFailure(failure)).toEqual({kind: 'unknown', message: CREATION_UNKNOWN});
  }
  expect(renderToStaticMarkup(createElement(CreationLockNotice, {failure: creationFailure(new Error('Daemon connection closed'))}))).toContain(`${CREATION_UNKNOWN}要重试，关掉这个窗口再建。`);
});

it('s36d1: locks the form on a group created and not saved, with the daemon\'s binding guide and no retry advice', () => {
  const guide = '群「x」已建好，但没存上：project disk failure。请在网页「加入现有飞书群」→「查找已经加入的群」里选它绑定，不要再建。绑回来是只读，要完全访问就到群设置里改';
  // Anything but a refusal locks the form (JoinGroupDialog's catch), so a second click cannot make a second group.
  const unsaved = creationFailure(new RpcError('created_unsaved', guide));
  expect(unsaved).toEqual({kind: 'unsaved', message: guide});
  const notice = renderToStaticMarkup(createElement(CreationLockNotice, {failure: unsaved}));
  expect(notice).toContain(guide);
  expect(notice).toContain('群已建好，但没存上');
  expect(notice).not.toContain('重试');
});
