import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {z} from 'zod';
import type {AdminReply, AdminRequest, SecretService, SecretUse} from '@vonvon/protocol';
import {createClient, RpcError} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {FillKeyDialog, KeyDiagnosticsRows, KeyRow, RemoveKeyDialog, SecretsPanel, UsesRow, submitsOnKey} from '../src/management/SecretsPanel';
import {
  errorText, keyDiagnosis, keyFlows, removalCopy, rereads, resultCopy, saveKey, secretsReader, testKey, testTone, type FillFlow, type KeyFlows, type SecretsRead,
  type SecretsView, type Tested,
} from '../src/management/secretsModel';
import {findEntries, searchEntries} from '../src/search';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const USES: SecretUse[] = [
  {agentId: 'cli_p', agentName: '小P'},
  {agentId: 'cli_p', agentName: '小P', groupId: 'oc_product', groupName: '产品讨论', inherited: true},
  {agentId: 'cli_s', agentName: '小审', groupId: 'oc_front', groupName: '前端开发'},
  {agentId: 'cli_s', agentName: '小审', groupId: 'oc_weekly', groupName: '周报整理', notSmart: true},
];
const service = (fields: Partial<SecretService> = {}): SecretService => ({
  provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', models: [{id: 'jev-latest', displayName: 'Jev'}],
  status: 'set', last4: '7f3a', inUse: USES, ...fields,
});
const view = (s: SecretService = service(), fields: Partial<SecretsView> = {}): SecretsView => ({kind: 'secrets', services: [s], unreadBots: 0, ...fields});
const html = (node: React.ReactNode) => renderToStaticMarkup(<ClientProvider client={client}>{node}</ClientProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const noop = () => {};
const row = (s: SecretService, v: SecretsView = view(s), state = {}) => html(<KeyRow service={s} view={v} row={state}
  onFill={noop} onReplace={noop} onRemove={noop} onTest={noop} onOpenLogs={noop}/>);
const tested = (outcome: Tested['outcome'], message: string, status?: number): Tested => ({at: Date.UTC(2026, 9, 19, 4, 33), outcome, message, ...(status ? {status} : {})});

/** A daemon whose answers come back when the test says, in any order. */
function daemon() {
  const calls: Array<{request: AdminRequest; resolve: (reply: AdminReply) => void; reject: (error: Error) => void}> = [];
  const admin = vi.fn((request: AdminRequest) => new Promise<AdminReply>((resolve, reject) => { calls.push({request, resolve, reject}); }));
  return {admin, calls};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
/** errorText puts what is not the daemon's words in the console */
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('the list reader (s23g2 做法: request numbers)', () => {
  it('lands only the last read asked, whatever order the answers come back in', async () => {
    const d = daemon();
    const seen: SecretsRead[] = [];
    const reader = secretsReader(d.admin, read => seen.push(read));
    const first = reader.read();
    const second = reader.read();
    d.calls[1]!.resolve(view(service({status: 'missing', last4: undefined})));
    await second;
    d.calls[0]!.resolve(view());
    await first;
    expect(seen).toEqual([{kind: 'ready', view: view(service({status: 'missing', last4: undefined}))}]);
  });

  it('counts a save as one: a read asked after it wins, and a save whose list was dropped reads once more', async () => {
    const d = daemon();
    const seen: SecretsRead[] = [];
    const reader = secretsReader(d.admin, read => seen.push(read));
    const saving = reader.change({type: 'setSecret', keyId: 'typesafe-api-key', value: 'tsk-test-0000000000000000abcd'});
    const reading = reader.read();
    d.calls[1]!.resolve(view(service({status: 'missing', last4: undefined})));
    await reading;
    d.calls[0]!.resolve(view(service({last4: 'abcd'})));
    await saving;
    expect(d.calls.map(call => call.request.type)).toEqual(['setSecret', 'secrets', 'secrets']);
    d.calls[2]!.resolve(view(service({last4: 'abcd'})));
    await tick();
    expect(seen.map(read => read.kind === 'ready' && read.view.services[0]!.status)).toEqual(['missing', 'set']);
    // a save that lands needs no other read
    const again = reader.change({type: 'removeSecret', keyId: 'typesafe-api-key'});
    d.calls[3]!.resolve({...view(service({status: 'missing', last4: undefined})), removed: true});
    await again;
    expect(d.calls).toHaveLength(4);
  });

  it('a refused or failed change reads the list again; an old daemon is said so; a failed read keeps the last list', async () => {
    quiet();
    const d = daemon();
    const seen: SecretsRead[] = [];
    const reader = secretsReader(d.admin, read => seen.push(read));
    const refused = reader.change({type: 'setSecret', keyId: 'typesafe-api-key', value: 'x'});
    d.calls[0]!.resolve({kind: 'refused', code: 'keystore', message: '磁盘满了（ENOSPC）'});
    expect(await refused).toEqual({kind: 'refused', code: 'keystore', message: '磁盘满了（ENOSPC）'});
    expect(d.calls[1]!.request).toEqual({type: 'secrets'});
    d.calls[1]!.resolve(view());
    await tick();
    const failing = reader.read();
    d.calls[2]!.reject(new Error('Daemon connection closed'));
    await failing;
    expect(seen.at(-1)).toEqual({kind: 'ready', view: view(), problem: '没连上 daemon'});
    const old = reader.read();
    d.calls[3]!.reject(new RpcError('invalid_request', 'Invalid request'));
    await old;
    expect(seen.at(-1)).toEqual({kind: 'old'});
    const fresh = secretsReader(d.admin, read => seen.push(read));
    const none = fresh.read();
    d.calls[4]!.reject(new RpcError('operation_failed', '密钥库被别的进程占着'));
    await none;
    expect(seen.at(-1)).toEqual({kind: 'failed', problem: '密钥库被别的进程占着'});
    // after stop (the page is gone) nothing lands
    fresh.stop();
    const late = fresh.read();
    d.calls[5]!.resolve(view());
    await late;
    expect(seen.at(-1)).toEqual({kind: 'failed', problem: '密钥库被别的进程占着'});
  });

  it('shows the daemon\'s words, and a fixed line for the connection or a reply it cannot read (多角度审查 R-F3)', () => {
    const warn = quiet();
    expect(errorText(new RpcError('operation_failed', '磁盘满了（ENOSPC）'))).toBe('磁盘满了（ENOSPC）');
    expect(errorText(new RpcError('invalid_request', '请求参数无效。'))).toBe('daemon 比网页旧，重启 daemon 后再开这一页');
    expect(warn).not.toHaveBeenCalled();
    const closed = new Error('Daemon connection closed');
    expect(errorText(closed)).toBe('没连上 daemon');
    expect(warn).toHaveBeenLastCalledWith('密钥页：', closed);
    const unreadable = z.object({kind: z.enum(['secrets'])}).safeParse({kind: 'later'}).error;
    expect(errorText(unreadable)).toBe('daemon 回的内容网页读不懂');
    expect(errorText('thrown')).toBe('没连上 daemon');
    warn.mockRestore();
  });

  it('coming back to the window reads again, not while hidden and once for a focus and a visibilitychange together', () => {
    expect(rereads(false, 5000, 3000)).toBe(true);
    expect(rereads(false, 5000, 4500)).toBe(false);
    expect(rereads(true, 5000, 3000)).toBe(false);
  });
});

describe('save and 试一次', () => {
  it('says why a save did not go through in the daemon\'s words, an old daemon as such', async () => {
    const change = vi.fn(async () => ({kind: 'refused', code: 'keystore', message: '密钥库被别的进程占着，30 秒没等到（KEYSTORE_BUSY）'}) as AdminReply);
    expect(await saveKey(change, 'typesafe-api-key', 'k')).toEqual({kind: 'failed', message: '密钥库被别的进程占着，30 秒没等到（KEYSTORE_BUSY）'});
    change.mockRejectedValueOnce(new RpcError('invalid_request', 'Invalid request'));
    expect(await saveKey(change, 'typesafe-api-key', 'k')).toEqual({kind: 'failed', message: 'daemon 比网页旧，重启 daemon 后再开这一页'});
    change.mockResolvedValueOnce(view(service({last4: 'abcd'})));
    expect(await saveKey(change, 'typesafe-api-key', 'k')).toEqual({kind: 'saved', last4: 'abcd'});
    change.mockResolvedValueOnce(view(service({last4: undefined})));
    expect(await saveKey(change, 'typesafe-api-key', 'k')).toEqual({kind: 'saved'});
  });

  it('keeps the daemon\'s outcome and words for each 试一次', async () => {
    const admin = vi.fn(async () => ({kind: 'secretTested', keyId: 'typesafe-api-key', outcome: 'auth', message: 'key 不对：TypeSafe 不认这个 key', status: 401}) as AdminReply);
    expect(await testKey(admin, 'typesafe-api-key', () => 5)).toEqual({at: 5, outcome: 'auth', message: 'key 不对：TypeSafe 不认这个 key', status: 401});
    expect(admin).toHaveBeenCalledWith({type: 'testSecret', keyId: 'typesafe-api-key'});
    admin.mockResolvedValueOnce({kind: 'refused', code: 'missing_key', message: '还没填 TypeSafe 的 key'});
    expect(await testKey(admin, 'typesafe-api-key', () => 5)).toEqual({at: 5, outcome: 'refused', message: '还没填 TypeSafe 的 key'});
    quiet();
    admin.mockRejectedValueOnce(new Error('Daemon connection closed'));
    expect(await testKey(admin, 'typesafe-api-key', () => 5)).toEqual({at: 5, outcome: 'refused', message: '没连上 daemon'});
  });

  it('Enter submits, not while an input method composes', () => {
    expect(submitsOnKey('Enter', false)).toBe(true);
    expect(submitsOnKey('Enter', true)).toBe(false);
    expect(submitsOnKey('a', false)).toBe(false);
  });
});

describe('the key row', () => {
  it('set: the last four in the pill, then 试一次, 换 key and a ghost 删除', () => {
    const markup = row(service());
    expect(text(markup)).toContain('TypeSafe 的 key决策模型 Jev 用它判断回不回。');
    expect(markup).toContain('已填 ••••7f3a');
    expect([...markup.matchAll(/<button[^>]*class="([^"]+)"[^>]*>(?:<svg.*?<\/svg>)?<span>([^<]+)<\/span>/g)].map(m => [m[2], m[1].match(/ui-button--(\w+)/)![1]]))
      .toEqual([['试一次', 'secondary'], ['换 key', 'secondary'], ['删除', 'ghost']]);
    // the pill sits before the buttons, as on the 状态与诊断 page
    expect(markup.indexOf('已填 ••••7f3a')).toBeLessThan(markup.indexOf('试一次'));
    expect(row(service({last4: undefined}))).toContain('>已填<');
  });

  it('while 试一次 runs every button is off and 试一次 spins; the result and its time stay in the row', () => {
    const busy = row(service(), view(), {busy: 'testing'});
    expect(busy.match(/disabled=""/g)).toHaveLength(3);
    expect(busy).toContain('ui-button__spinner');
    const done = row(service(), view(), {tested: tested('auth', 'key 不对：TypeSafe 不认这个 key', 401)});
    expect(text(done)).toMatch(/\d{1,2}:\d{2} 试了一次：key 不对：TypeSafe 不认这个 key/);
    expect(done).toContain('ui-status-badge--danger');
    expect(row(service(), view(), {tested: tested('network', '连不上 TypeSafe')})).toContain('ui-status-badge--warning');
    expect(row(service(), view(), {tested: tested('ok', '能用')})).toContain('ui-status-badge--success');
    expect(text(row(service({status: 'missing', last4: undefined}), view(), {tested: tested('saveFailed', '磁盘满了（ENOSPC）')}))).toMatch(/没存上：磁盘满了（ENOSPC）/);
    expect(text(row(service(), view(), {busy: 'saving'}))).toContain('正在存…');
  });

  it('missing, a stored key that cannot be used, and a keystore it cannot read', () => {
    const missing = text(row(service({status: 'missing', last4: undefined})));
    expect(missing).toContain('还没填');
    expect(missing).toContain('填之前，选了它的 Bot 和飞书群要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区）。');
    expect(missing).toContain('填 key');
    expect(text(row(service({status: 'missing', last4: undefined, inUse: []})))).not.toContain('填之前');
    expect(text(row(service({status: 'missing', last4: undefined, inUse: []}), view(service({inUse: []}), {botsUnreadable: true})))).toContain('填之前');
    const invalid = text(row(service({status: 'invalid', last4: undefined})));
    expect(invalid).toContain('存着的 key 不能用');
    expect(invalid).toContain('存着的 key 有空格或看不见的字符，判断时当没填。重新填一次整串 key。重新填之前，选了它的');
    expect(invalid).toContain('重新填删除');
    const unreadable = row(service({status: 'unreadable', last4: undefined, problem: 'secrets.enc 解不开：master.key 和它对不上', code: 'KEYSTORE_DECRYPT'}));
    expect(text(unreadable)).toContain('secrets.enc 解不开：master.key 和它对不上（KEYSTORE_DECRYPT）。读得了之前看不出填没填，也填不进去');
    expect(text(unreadable)).toContain('原话在 daemon 日志的 secrets.unreadable。');
    // no 填 key: the save would hit the same error, as the command line says
    expect(text(unreadable)).not.toContain('填 key');
    expect(text(unreadable)).toContain('去看日志');
  });

  it('谁在用 lists the Bot defaults and the groups, those not in 智能 marked, and the counts', () => {
    const uses = text(html(<UsesRow service={service()} view={view()}/>));
    expect(uses).toContain('小P · Bot 默认用 TypeSafe 的 Jev，它的智能群没自己选的都跟着');
    expect(uses).toContain('产品讨论 · 小P，跟着 Bot 默认用 TypeSafe 的 Jev');
    expect(uses).toContain('前端开发 · 小审，自己选了 TypeSafe 的 Jev');
    expect(uses).toContain('周报整理 · 小审，自己选了 TypeSafe 的 Jev；现在不是智能群，什么都不判断');
    expect(uses).toContain('2 个 Bot · 3 个飞书群');
    expect(text(html(<UsesRow service={service({inUse: []})} view={view(service({inUse: []}))}/>))).toContain('现在没有 Bot 或飞书群选它。在智能群的群详情页把「判断模型」选成 TypeSafe 的 Jev，才用这个 key。');
    const unread = text(html(<UsesRow service={service({inUse: []})} view={view(service({inUse: []}), {botsUnreadable: true, unreadBots: 2})}/>));
    expect(unread).toContain('Bot 清单（bots.json）读不了，谁选了它没算进来；vonvon daemon logs 里的 secrets.bots-unreadable 有原因。');
    expect(unread).toContain('有 2 个 Bot 的设置读不了，没算进来');
    expect(unread).toContain('Bot 清单读不了');
  });
});

describe('the fill dialog', () => {
  const flow = (fields: Partial<FillFlow> = {}): FillFlow => ({id: 1, keyId: 'typesafe-api-key', replacing: false, step: 'input', ...fields});
  const dialog = (f: FillFlow, s = service({status: 'missing', last4: undefined})) => html(<FillKeyDialog flow={f} service={s} onClose={noop} onSubmit={noop} onAgain={noop} onRetest={noop}/>);

  it('asks with an uncontrolled, hidden field the password managers are told to skip, wired to its label and words', () => {
    const markup = dialog(flow());
    expect(text(markup)).toContain('填 TypeSafe 的 key');
    expect(text(markup)).toContain('存在本机，只有 daemon 读它，页面上只显示末四位。填完马上试一次能不能用。');
    const input = markup.match(/<input[^>]*>/)![0];
    expect(input).toContain('type="password"');
    expect(input.toLowerCase()).toContain('autocomplete="off"');
    expect(input).toContain('data-1p-ignore=""');
    expect(input).toContain('data-lpignore="true"');
    expect(input).not.toContain('value=');
    const id = input.match(/id="([^"]+)"/)![1];
    expect(markup).toContain(`for="${id}"`);
    expect(input).toContain(`aria-describedby="${id}-description"`);
    expect(markup).toContain(`id="${id}-description"`);
    // the wrapper gets no aria of its own
    expect(markup).not.toMatch(/<div[^>]*class="secrets-key-field"[^>]*aria-/);
    expect(markup).not.toContain('<form');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*><span>保存并试一次<\/span>/);
    expect(markup).toContain('aria-pressed="false"');
    expect(text(dialog(flow({replacing: true, was: '7f3a'}), service()))).toContain('换 TypeSafe 的 key整串重填，现在的 ••••7f3a 会被换掉。');
  });

  it('shows each request while it runs, closable, with the header and the pressed button kept in place (多角度审查 B2)', () => {
    expect(text(dialog(flow({step: 'saving'})))).toContain('正在存…关闭');
    // the list has the new last four by now: the header names the one it opened with
    const testing = dialog(flow({step: 'testing', replacing: true, was: '7f3a', last4: 'abcd'}), service({last4: 'abcd'}));
    expect(text(testing)).toContain('换 TypeSafe 的 key整串重填，现在的 ••••7f3a 会被换掉。存在本机，只有 daemon 读它，页面上只显示末四位。已存下（末四位 abcd），正在试一次…');
    expect(testing).toContain('role="status"');
    const pressed = (markup: string) => [...markup.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?<span>([^<]+)<\/span><\/button>/g)].map(m => [m[1], /disabled=""/.test(m[0]), m[0].includes('ui-button__spinner')]);
    expect(pressed(testing)).toEqual([['关闭', false, false], ['保存并试一次', true, true]]);
    // a retest keeps the last result until the new one lands: 再试一次 spins where it was
    expect(pressed(dialog(flow({step: 'testing', last4: 'abcd', result: tested('timeout', 'TypeSafe 5 秒没回')})))).toEqual([['关闭', false, false], ['再试一次', true, true]]);
    expect(text(dialog(flow({step: 'result', replacing: true, was: '7f3a', last4: 'abcd', result: tested('auth', 'key 不对')})))).not.toContain('会被换掉');
  });

  it('words each result of 试一次 with what to do next', () => {
    const result = (t: Tested) => text(dialog(flow({step: 'result', last4: 'abcd', result: t})));
    expect(result(tested('auth', 'key 不对：TypeSafe 不认这个 key', 401))).toContain('key 不对：TypeSafe 不认这个 keykey 已经存下（末四位 abcd），但判断会出错；换一个再填。先这样换一个');
    expect(result(tested('busy', '连上了，但 TypeSafe 限流了，稍后再试', 429))).toContain('key 已经存下（末四位 abcd）。稍后再点"试一次"确认。完成');
    expect(result(tested('network', 'TypeSafe 出错了（503）'))).toContain('只是这次没试成。网络好了点"试一次"再看。完成再试一次');
    expect(result(tested('timeout', 'TypeSafe 5 秒没回'))).toContain('TypeSafe 5 秒没回key 已经存下（末四位 abcd），只是这次没试成。稍后点"试一次"再看。');
    expect(result(tested('failed', 'TypeSafe 不收这个请求（403）', 403))).toContain('多半是账号或权限的问题，去 TypeSafe 的控制台看看。完成');
    expect(result(tested('failed', 'TypeSafe 回的内容读不懂', 200))).toContain('TypeSafe 回的内容读不懂key 已经存下（末四位 abcd），稍后再试一次。');
    expect(result(tested('saveFailed', '密钥库被别的进程占着，30 秒没等到（KEYSTORE_BUSY）'))).toContain('没做成没存上：密钥库被别的进程占着，30 秒没等到（KEYSTORE_BUSY）。key 没有存，再试一次或者等一会。取消再试一次');
    expect(result(tested('refused', 'daemon 比网页旧，重启 daemon 后再开这一页'))).toContain('没试成');
    expect(resultCopy(tested('auth', 'x'), 'TypeSafe').tone).toBe('danger');
    expect(resultCopy(tested('busy', 'x'), 'TypeSafe').tone).toBe('warning');
    expect(resultCopy(tested('timeout', 'x'), 'TypeSafe').footer).toBe('retry');
    // only this try failed: yellow; the key or the save: red
    expect(['ok', 'busy', 'network', 'timeout', 'auth', 'failed', 'refused', 'saveFailed'].map(outcome => testTone(outcome as Tested['outcome'])))
      .toEqual(['success', 'warning', 'warning', 'warning', 'danger', 'danger', 'danger', 'danger']);
  });
});

describe('the fill dialog and the rows (s23g2 做法: each fill has its own id)', () => {
  const KEY = 'typesafe-api-key';
  const answer = (outcome: Tested['outcome'], message: string, status?: number) =>
    ({kind: 'secretTested', keyId: KEY, outcome, message, ...(status ? {status} : {})}) as AdminReply;
  const setup = () => {
    const d = daemon();
    const seen: KeyFlows[] = [];
    const flows = keyFlows(d.admin, d.admin, state => seen.push(state), () => 7);
    /** opens a fill, sends the key and answers the save; 试一次 is then asked, and `done` waits for its answer */
    const filled = async (last4: string, replacing = false) => {
      flows.open(KEY, replacing);
      const done = flows.save(`tsk-test-000000000000${last4}`);
      d.calls.at(-1)!.resolve(view(service({last4})));
      await tick();
      return {done};
    };
    return {d, flows, seen, filled};
  };

  it('a fill closed while 试一次 runs is not reopened, and a newer one is left alone: the result goes to the row', async () => {
    const {d, flows, seen, filled} = setup();
    const first = (await filled('abcd')).done;
    expect(flows.current().fill).toMatchObject({id: 1, step: 'testing', last4: 'abcd'});
    expect(flows.current().rows[KEY]).toEqual({busy: 'testing'});
    expect(d.calls.map(call => call.request.type)).toEqual(['setSecret', 'testSecret']);
    flows.close();
    expect(flows.current()).toMatchObject({fill: undefined, refocus: KEY});
    flows.refocused(KEY);
    flows.open(KEY, true);
    d.calls[1]!.resolve(answer('auth', 'key 不对：TypeSafe 不认这个 key', 401));
    await first;
    expect(flows.current().fill).toEqual({id: 2, keyId: KEY, replacing: true, step: 'input'});
    expect(flows.current().rows[KEY]).toEqual({tested: {at: 7, outcome: 'auth', message: 'key 不对：TypeSafe 不认这个 key', status: 401}});
    expect(flows.current().refocus).toBeUndefined();
    // 能用 for a fill that is gone does not close the open one
    const second = flows.save('tsk-test-0000000000000000wxyz');
    d.calls[2]!.resolve(view(service({last4: 'wxyz'})));
    await tick();
    flows.close();
    flows.open(KEY, true);
    d.calls[3]!.resolve(answer('ok', '能用'));
    await second;
    expect(flows.current().fill).toMatchObject({id: 3, step: 'input'});
    expect(flows.current().rows[KEY]?.tested?.outcome).toBe('ok');
    expect(seen.at(-1)).toBe(flows.current());
  });

  it('能用 closes the dialog and sends focus to the row; another result stays in the dialog and in the row', async () => {
    const {d, flows, filled} = setup();
    const first = (await filled('abcd')).done;
    d.calls[1]!.resolve(answer('ok', '能用'));
    await first;
    expect(flows.current()).toMatchObject({fill: undefined, refocus: KEY, rows: {[KEY]: {tested: {outcome: 'ok', message: '能用'}}}});
    const second = (await filled('wxyz', true)).done;
    d.calls[3]!.resolve(answer('timeout', 'TypeSafe 5 秒没回'));
    await second;
    expect(flows.current().fill).toMatchObject({id: 2, step: 'result', last4: 'wxyz', result: {outcome: 'timeout', message: 'TypeSafe 5 秒没回'}});
    expect(flows.current().rows[KEY]?.tested?.outcome).toBe('timeout');
    // 再试一次 in the dialog asks again for the same fill
    const again = flows.retest();
    expect(flows.current().fill?.step).toBe('testing');
    d.calls[4]!.resolve(answer('ok', '能用'));
    await again;
    expect(flows.current().fill).toBeUndefined();
  });

  it('a save that did not go through is not tried; it stays in the dialog and the row, and 再试一次 goes back to the field', async () => {
    const {d, flows} = setup();
    await flows.save('nothing open');
    expect(d.calls).toHaveLength(0);
    flows.open(KEY, false);
    const saving = flows.save('tsk-test-0000000000000000abcd');
    expect(flows.current().rows[KEY]).toEqual({busy: 'saving'});
    expect(flows.current().fill?.step).toBe('saving');
    // sent once: a second Enter while it saves asks nothing
    void flows.save('tsk-test-0000000000000000abcd');
    expect(d.calls).toHaveLength(1);
    d.calls[0]!.resolve({kind: 'refused', code: 'keystore', message: '磁盘满了（ENOSPC）'});
    await saving;
    expect(d.calls).toHaveLength(1);
    expect(flows.current().fill).toMatchObject({step: 'result', result: {outcome: 'saveFailed', message: '磁盘满了（ENOSPC）'}});
    expect(flows.current().rows[KEY]).toEqual({tested: {at: 7, outcome: 'saveFailed', message: '磁盘满了（ENOSPC）'}});
    flows.again();
    expect(flows.current().fill).toEqual({id: 1, keyId: KEY, replacing: false, step: 'input'});
  });

  it('试一次 in the row opens nothing and moves no focus; 重新读取 forgets results, not a running request; a removal starts the row over', async () => {
    const {d, flows} = setup();
    const running = flows.test(KEY);
    expect(flows.current().rows[KEY]).toEqual({busy: 'testing'});
    flows.forget();
    expect(flows.current().rows[KEY]).toEqual({busy: 'testing'});
    d.calls[0]!.resolve(answer('busy', '连上了，但 TypeSafe 限流了，稍后再试', 429));
    await running;
    expect(flows.current()).toEqual({rows: {[KEY]: {tested: {at: 7, outcome: 'busy', message: '连上了，但 TypeSafe 限流了，稍后再试', status: 429}}}});
    flows.forget();
    expect(flows.current().rows[KEY]).toEqual({});
    flows.removed(KEY);
    expect(flows.current().refocus).toBe(KEY);
    // 换 key keeps the last four it opened with, for its header
    flows.open(KEY, true, '7f3a');
    expect(flows.current().fill).toEqual({id: 1, keyId: KEY, replacing: true, was: '7f3a', step: 'input'});
  });

  it('a key stored, replaced or removed elsewhere drops its row\'s result when the list is read again (多角度审查 R-F2)', async () => {
    const {d, flows} = setup();
    flows.listed([service()]);
    const first = flows.test(KEY);
    d.calls[0]!.resolve(answer('ok', '能用'));
    await first;
    // the same key read again: the result stays
    flows.listed([service()]);
    expect(flows.current().rows[KEY]?.tested?.outcome).toBe('ok');
    flows.listed([service({status: 'missing', last4: undefined})]);
    expect(flows.current().rows[KEY]).toEqual({});
    // replaced elsewhere: same status, another last four
    flows.listed([service()]);
    const second = flows.test(KEY);
    d.calls[1]!.resolve(answer('auth', 'key 不对'));
    await second;
    flows.listed([service({last4: 'wxyz'})]);
    expect(flows.current().rows[KEY]).toEqual({});
    // a request that still runs keeps its row, and what it brings lands
    const third = flows.test(KEY);
    d.calls[2]!.resolve(answer('ok', '能用'));
    await third;
    const fourth = flows.test(KEY);
    flows.listed([service({last4: 'abcd'})]);
    expect(flows.current().rows[KEY]).toMatchObject({busy: 'testing', tested: {outcome: 'ok'}});
    d.calls[3]!.resolve(answer('auth', 'key 不对'));
    await fourth;
    flows.listed([service({last4: 'abcd'})]);
    expect(flows.current().rows[KEY]).toMatchObject({tested: {outcome: 'auth'}});
  });
});

describe('the removal', () => {
  const dialog = (s: SecretService, v: SecretsView = view(s), error?: string) =>
    text(html(<RemoveKeyDialog removal={{keyId: s.keyId, pending: false, ...(error ? {error} : {})}} service={s} view={v} onCancel={noop} onConfirm={noop}/>));

  it('lists who chose it, those in 智能 first, those not in 智能 apart', () => {
    const markup = dialog(service());
    expect(markup).toContain('删 TypeSafe 的 key？末四位 7f3a。只删本机存的这一份，TypeSafe 那边的 key 还在。');
    expect(markup).toContain('删了以后，下面这些 Bot 和飞书群要判断的消息按出错处理：没 @ Bot 的不回，@ 的回在主区。重新填就恢复。');
    expect(markup.indexOf('前端开发')).toBeLessThan(markup.indexOf('下面这些现在不是智能群，删了不影响；改成智能群后会按出错处理。'));
    expect(markup.indexOf('下面这些现在不是智能群')).toBeLessThan(markup.indexOf('周报整理'));
    // under that note each line does not say it again
    expect(markup).toContain('周报整理 · 小审，自己选了 TypeSafe 的 Jev');
    expect(markup).not.toContain('什么都不判断');
    expect(markup).toContain('取消删除');
    const html2 = html(<RemoveKeyDialog removal={{keyId: 'typesafe-api-key', pending: false}} service={service()} view={view()} onCancel={noop} onConfirm={noop}/>);
    expect(html2.match(/class="secrets-dialog-list"/g)).toHaveLength(2);
  });

  it('says it when no one chose it, when the Bot list or some bots could not be read, for a stored key that cannot be used, and a failure', () => {
    expect(dialog(service({inUse: []}))).toContain('现在没有 Bot 或飞书群选它，删了不影响任何群。');
    // what could not be read is said once, with where the log says why
    const unread = dialog(service({inUse: []}), view(service({inUse: []}), {botsUnreadable: true}));
    expect(unread).toContain('Bot 清单读不了，不知道谁选了它；vonvon daemon logs 里的 secrets.bots-unreadable 有原因。选了它的飞书群删了以后要判断的消息按出错处理');
    expect(unread.match(/读不了/g)).toHaveLength(1);
    const some = dialog(service({inUse: []}), view(service({inUse: []}), {unreadBots: 1}));
    expect(some).toContain('有 1 个 Bot 的设置读不了，不知道它们选没选它；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。选了它的');
    expect(some.match(/读不了/g)).toHaveLength(1);
    // with some listed, the note stays under the lists
    expect(dialog(service(), view(service(), {unreadBots: 1}))).toContain('有 1 个 Bot 的设置读不了，没算进来；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。');
    const invalid = dialog(service({status: 'invalid', last4: undefined}));
    expect(invalid).toContain('存着的这串不能用，现在已经按没填处理。只删本机存的这一份。');
    expect(invalid).toContain('存着的这串不能用，下面这些现在已经按没填处理，删了也一样；重新填就恢复。');
    expect(dialog(service({last4: undefined}))).toContain('删 TypeSafe 的 key？只删本机存的这一份');
    expect(dialog(service(), view(), '磁盘满了（ENOSPC）')).toContain('没做成没删：磁盘满了（ENOSPC）。key 还在。');
    expect(removalCopy(service({inUse: USES.slice(3)}), view()).lead).toBeUndefined();
  });
});

describe('the 状态与诊断 row (product.md 3.1 第 8 条)', () => {
  const rows = (read: SecretsRead) => text(html(<KeyDiagnosticsRows read={read} onOpenSecrets={noop} onShowLog={noop}/>));
  it('names who chose it, and what to do when its key is missing, unusable or unreadable', () => {
    expect(rows({kind: 'ready', view: view()})).toBe('决策模型的 key选了 TypeSafe 的 Jev 的：小P（Bot 默认）、产品讨论（小P，跟着 Bot 默认）、前端开发（小审）、周报整理（小审，现在不是智能群）。TypeSafe 已填 ••••7f3a');
    const missing = rows({kind: 'ready', view: view(service({status: 'missing', last4: undefined}))});
    expect(missing).toContain('选了 TypeSafe 的 Jev，本机还没填它的 key。填之前它们要判断的消息按出错处理');
    expect(missing).toContain('还没填 TypeSafe 的 key去填');
    expect(rows({kind: 'ready', view: view(service({status: 'invalid', last4: undefined}))})).toContain('但存着的 TypeSafe 的 key 不是一串可见字符，判断时当没填。重新填之前它们');
    const unreadable = rows({kind: 'ready', view: view(service({status: 'unreadable', last4: undefined, problem: '磁盘满了', code: 'ENOSPC'}))});
    expect(unreadable).toContain('密钥库读不了，看不出填没填 TypeSafe 的 key：磁盘满了（ENOSPC）。读得了之前它们');
    expect(unreadable).toContain('读不了密钥库看日志');
    expect(rows({kind: 'ready', view: view(service({status: 'missing', last4: undefined, inUse: []}))})).toContain('现在没有 Bot 或飞书群选 TypeSafe 的 Jev，用不着它的 key。');
    expect(keyDiagnosis(service({status: 'missing', last4: undefined, inUse: []}), view()).tone).toBe('neutral');
    expect(rows({kind: 'ready', view: view(service({inUse: []}), {botsUnreadable: true})})).toContain('Bot 清单（bots.json）读不了');
    expect(rows({kind: 'loading'})).toBe('决策模型的 key检查中');
    expect(rows({kind: 'old'})).toBe('决策模型的 keydaemon 比网页旧，重启 daemon 后再开这一页。看不到');
    expect(rows({kind: 'failed', problem: 'Daemon connection closed'})).toBe('决策模型的 keyDaemon connection closed读取失败');
  });

  it('a reread that failed says the row is the last list read, in yellow unless it is red (多角度审查 R-F1)', () => {
    const markup = (read: SecretsRead) => html(<KeyDiagnosticsRows read={read} onOpenSecrets={noop} onShowLog={noop}/>);
    const stale = markup({kind: 'ready', view: view(), problem: '没连上 daemon'});
    expect(text(stale)).toContain('决策模型的 key没读到最新的（没连上 daemon），这是上一次读到的。选了 TypeSafe 的 Jev 的：');
    expect(stale).toContain('ui-status-badge--warning');
    expect(stale).not.toContain('ui-status-badge--success');
    expect(markup({kind: 'ready', view: view()})).not.toContain('没读到最新的');
    expect(markup({kind: 'ready', view: view(service({status: 'unreadable', last4: undefined})), problem: 'x'})).toContain('ui-status-badge--danger');
  });

  it('names up to four who chose it, else three and counts them all (多角度审查 B3)', () => {
    const crowd: SecretUse[] = [USES[0]!, ...Array.from({length: 30}, (_, i): SecretUse => ({agentId: `cli_${i % 3}`, agentName: `Bot${i % 3}`, groupId: `oc_${i}`, groupName: `群${i}`}))];
    const missing = keyDiagnosis(service({status: 'missing', last4: undefined, inUse: crowd}), view()).description;
    expect(missing).toMatch(/^小P（Bot 默认）、群0（Bot0）、群1（Bot1）等 4 个 Bot、30 个飞书群选了 TypeSafe 的 Jev，本机还没填它的 key。/);
    expect(missing).not.toContain('群2');
    expect(keyDiagnosis(service({inUse: crowd}), view()).description).toBe('选了 TypeSafe 的 Jev 的：小P（Bot 默认）、群0（Bot0）、群1（Bot1）等 4 个 Bot、30 个飞书群。');
    // four are all named
    expect(keyDiagnosis(service(), view()).description).toContain('周报整理（小审，现在不是智能群）');
  });
});

it('the page reads on entering it, and the search lists it (s23g2 做法)', () => {
  expect(text(html(<SecretsPanel onOpenLogs={noop} onOpenApplication={noop}/>))).toContain('密钥要 key 的服务，整台机器一份，所有 Bot 共用。重新读取决策模型正在读取…');
  const entries = searchEntries({
    revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
    agents: [], groups: [], memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: '/tmp/x'},
  });
  expect(findEntries(entries, '').map(entry => entry.title)).toContain('密钥');
  expect(findEntries(entries, 'TypeSafe')[0]?.destination.page).toBe('secrets');
  expect(findEntries(entries, '决策模型的 key')[0]?.destination).toMatchObject({page: 'diagnostics', section: '这台电脑'});
});
