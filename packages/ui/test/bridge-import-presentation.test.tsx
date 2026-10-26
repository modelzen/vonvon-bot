import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BridgeImportReply, BridgeImportView, BridgePreflight, MachineRequestHandler} from '@vonvon/protocol';
import {BridgeImportProgress, BridgeMigrationNotes, BridgePreflightSummary, bridgeImportEntry, bridgeImportInProgress, canStartBridgeImport, requestBridgeImport} from '../src/setup/BridgeImportPanel';

const preflight: BridgePreflight = {
  canImport: true, service: 'running', bundledCodex: 'present', problems: [], notes: [],
  bots: [{appId: 'cli_test', name: '项目助手', groups: 3, directories: [{index: 0, state: 'present'}], secret: 'decryptable', hooks: {claude: 'installed', codex: 'absent'}, running: 'running', problems: []}],
};
const reply: BridgeImportReply = {type: 'bridgeImport', detection: {kind: 'found', message: '发现数据'}, preflight, view: null};
const view: BridgeImportView = {txId: 'test', step: 'staging', bots: [{appId: 'cli_test', name: '项目助手'}], notes: [], cleanupPending: false, canRollback: true};

it('makes only read requests before explicit start, and attaches consent only to start', async () => {
  const request = vi.fn<MachineRequestHandler>(async () => reply);
  await requestBridgeImport(request, 'detect');
  await requestBridgeImport(request, 'preflight');
  await requestBridgeImport(request, 'start');
  await requestBridgeImport(request, 'status');
  await requestBridgeImport(request, 'rollback');
  expect(request.mock.calls.map(call => call[0])).toEqual([
    {type: 'bridgeImport', action: 'detect'}, {type: 'bridgeImport', action: 'preflight'},
    {type: 'bridgeImport', action: 'start', acceptedChanges: true}, {type: 'bridgeImport', action: 'status'},
    {type: 'bridgeImport', action: 'rollback'},
  ]);
});

it('cannot start from missing or failed preflight, without consent, or during another action', () => {
  expect(canStartBridgeImport(undefined, true, false)).toBe(false);
  expect(canStartBridgeImport({...preflight, canImport: false}, true, false)).toBe(false);
  expect(canStartBridgeImport(preflight, false, false)).toBe(false);
  expect(canStartBridgeImport(preflight, true, true)).toBe(false);
  expect(canStartBridgeImport(preflight, true, false)).toBe(true);
  expect(canStartBridgeImport({...preflight, bots: []}, true, false)).toBe(false);
});

it('uses the detection failure reason without claiming Bridge was found, and retries detection only', async () => {
  const invalidReply: BridgeImportReply = {...reply, detection: {kind: 'invalid', message: '旧数据目录无法读取。'}, preflight: null};
  const entry = bridgeImportEntry(invalidReply);
  expect(entry).toMatchObject({title: '无法确认 Bridge 数据', detail: '旧数据目录无法读取。', action: 'detect', label: '重新检测', detected: false});
  expect(entry?.detail).not.toContain('检测到 Feishu Codex Bridge');
  const request = vi.fn<MachineRequestHandler>(async () => invalidReply);
  await requestBridgeImport(request, entry!.action);
  expect(request).toHaveBeenCalledExactlyOnceWith({type: 'bridgeImport', action: 'detect'});
  const unreachable = bridgeImportEntry(undefined, '后台尚未连接');
  expect(unreachable).toMatchObject({detail: '后台尚未连接', action: 'detect', detected: false});
  expect(bridgeImportEntry({...reply, detection: {kind: 'not-found', message: '没有旧数据'}}, '重新检测失败')).toMatchObject({detail: '重新检测失败', action: 'detect', detected: false});
});

it('distinguishes no data, existing data, old format and completed import', () => {
  expect(bridgeImportEntry(undefined)).toBeNull();
  expect(bridgeImportEntry(undefined, undefined, true)).toMatchObject({action: 'detect', label: '检测旧数据', detected: false});
  expect(bridgeImportEntry({...reply, detection: {kind: 'not-found', message: '没有旧数据'}})).toBeNull();
  expect(bridgeImportEntry({...reply, detection: {kind: 'not-found', message: '没有旧数据'}}, undefined, true)).toMatchObject({action: 'detect', label: '重新检测', detected: false});
  expect(bridgeImportEntry({...reply, detection: {kind: 'unsupported-platform', message: '不支持'}})).toBeNull();
  expect(bridgeImportEntry(reply)).toMatchObject({action: 'preflight', detected: true, label: '查看导入'});
  expect(bridgeImportEntry({...reply, detection: {kind: 'upgrade-required', message: '请先启动旧 Bridge 升级目录。'}})).toMatchObject({title: 'Bridge 目录需要升级', detail: '请先启动旧 Bridge 升级目录。', action: 'detect', detected: true});
  expect(bridgeImportEntry({...reply, detection: {kind: 'imported', message: '迁移完成'}})).toMatchObject({action: 'status', label: '查看导入结果'});
  expect(bridgeImportEntry({...reply, detection: {kind: 'invalid', message: '目录异常'}, view})).toMatchObject({action: 'status', label: '查看进度'});
  expect(bridgeImportEntry({...reply, detection: {kind: 'not-found', message: '没有旧数据'}, view: {...view, step: 'rolled-back'}})).toMatchObject({action: 'status', label: '查看导入记录'});
  expect(bridgeImportEntry({...reply, detection: {kind: 'not-found', message: '没有旧数据'}, view: {...view, step: 'refused', error: {code: 'test', message: '目标冲突'}}})).toMatchObject({action: 'preflight', detail: '目标冲突'});
});

it('does not turn an empty failed preflight into a confirmed zero-bot inventory', () => {
  const html = renderToStaticMarkup(<BridgePreflightSummary preflight={{...preflight, canImport: false, bots: [], problems: [{code: 'invalid', message: '无法读取旧目录。'}]}}/>);
  expect(html).toContain('尚未确认可导入的 Bot');
  expect(html).toContain('无法读取旧目录。');
  expect(html).not.toContain('0 个 Bot');
  expect(html).not.toContain('0 个群绑定');
  expect(html).not.toContain('可以导入');
});

it('does not turn an unrelated machine response into an import success', async () => {
  await expect(requestBridgeImport(async () => ({type: 'done', message: 'unrelated'}), 'start')).rejects.toThrow('导入状态没有返回');
});

it('shows incomplete group counts as unknown instead of silently claiming zero', () => {
  const html = renderToStaticMarkup(<BridgePreflightSummary preflight={{...preflight, canImport: false, bots: [{...preflight.bots[0]!, groups: null, secret: 'cannot-decrypt'}], problems: [{code: 'secret', message: '请先在旧 Bridge 刷新凭据。'}]}}/>);
  expect(html).toContain('群绑定待确认');
  expect(html).not.toContain('0 个群绑定');
  expect(html).toContain('无法解密，请在旧 Bridge 重新扫码');
  expect(html).toContain('需要处理');
  expect(html).not.toContain('可以导入');
});

it('keeps the data preservation requirements and agreed losses visible before import', () => {
  const html = renderToStaticMarkup(<BridgeMigrationNotes/>);
  for (const detail of ['群绑定', '管理员名单', 'Codex 线程', 'Claude 会话', '评论提示词', '已发文件记录', 'CODEX_HOME', '更严格的一档', '咖啡一下', 'Codex Fast', 'Windows']) expect(html).toContain(detail);
  expect(html).toContain('<summary>迁移后有哪些变化</summary>');
  expect(html).toContain('<summary>不再迁移的内容</summary>');
});

it('reports the actual phase and does not claim a failed rollback restored the old service', () => {
  expect(bridgeImportInProgress(view)).toBe(true);
  expect(bridgeImportInProgress({...view, step: 'rolling-back'})).toBe(true);
  expect(bridgeImportInProgress({...view, step: 'rollback-failed'})).toBe(false);
  const html = renderToStaticMarkup(<BridgeImportProgress view={{...view, step: 'rollback-failed', cleanupPending: true, error: {code: 'restart', message: '旧服务尚未恢复'}}}/>);
  expect(html).toContain('回滚尚未完成');
  expect(html).toContain('请重试回滚');
  expect(html).toContain('旧服务尚未恢复');
  expect(html).not.toContain('已回滚');
  expect(html).not.toContain('导入完成');
  const done = renderToStaticMarkup(<BridgeImportProgress view={{...view, step: 'done', canRollback: false}}/>);
  expect(done).toContain('请保留旧 Bridge 目录');
});
