import type {AdminReply, AdminRequest, SecretService, SecretTestOutcome, SecretUse} from '@vonvon/protocol';

/** The 密钥 page's data and words (s23g2): the daemon's `secrets` requests (s23g), read as the command line reads them. */
export type SecretsView = Extract<AdminReply, {kind: 'secrets'}>;
export type SecretsRead =
  | {kind: 'loading'}
  /** `problem`: the last read failed, and `view` is the one before it */
  | {kind: 'ready'; view: SecretsView; problem?: string}
  /** a daemon from before s23g: it refuses the requests as invalid */
  | {kind: 'old'}
  | {kind: 'failed'; problem: string};
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
type Admin = (request: AdminRequest) => Promise<AdminReply>;
type Change = Extract<AdminRequest, {type: 'setSecret' | 'removeSecret'}>;

export const OLD_DAEMON = 'daemon 比网页旧，重启 daemon 后再开这一页';
export const MEANWHILE = '要判断的消息按出错处理（没点名的不回，真人 @ 的照旧回）';

/** A daemon from before s23g knows none of these requests (v1-plan s23g 做法（实现时定下的）). */
const isOld = (error: unknown): boolean => error instanceof Error && (error as {code?: unknown}).code === 'invalid_request';
/** An error the daemon sent: the client's RpcError, with the daemon's code and words. */
const fromDaemon = (error: unknown): error is Error => error instanceof Error && error.name === 'RpcError' && typeof (error as {code?: unknown}).code === 'string';
/**
 * The daemon's words for what it refused; anything else (the connection gone, a reply this page cannot read) is a
 * fixed line, and the original goes only to the console (多角度审查 R-F3).
 */
export function errorText(error: unknown): string {
  if (isOld(error)) return OLD_DAEMON;
  if (fromDaemon(error) && error.message) return error.message;
  console.warn('密钥页：', error);
  return error instanceof Error && error.name === 'ZodError' ? 'daemon 回的内容网页读不懂' : '没连上 daemon';
}

/**
 * Reads the list. Each read, save and removal takes the next number, and only the last one asked lands: an answer
 * that comes back after a later ask is dropped (s23g2 做法). A save or a removal whose list was dropped, or that
 * brought none, reads once more, so the page ends on what is stored.
 */
export function secretsReader(admin: Admin, publish: (read: SecretsRead) => void) {
  let latest = 0;
  let current: SecretsRead = {kind: 'loading'};
  let stopped = false;
  const land = (asked: number, next: (previous: SecretsRead) => SecretsRead): boolean => {
    if (asked !== latest || stopped) return false;
    current = next(current);
    publish(current);
    return true;
  };
  async function read(): Promise<void> {
    const asked = ++latest;
    let problem: string;
    try {
      const reply = await admin({type: 'secrets'});
      if (reply.kind === 'secrets') { land(asked, () => ({kind: 'ready', view: reply})); return; }
      problem = 'daemon 回的不是密钥的列表';
    } catch (error) {
      if (isOld(error)) { land(asked, () => ({kind: 'old'})); return; }
      problem = errorText(error);
    }
    land(asked, previous => previous.kind === 'ready' ? {...previous, problem} : {kind: 'failed', problem});
  }
  async function change(request: Change): Promise<AdminReply> {
    const asked = ++latest;
    let landed = false;
    try {
      const reply = await admin(request);
      if (reply.kind === 'secrets') landed = land(asked, () => ({kind: 'ready', view: reply}));
      return reply;
    } finally {
      if (!landed && !stopped) void read();
    }
  }
  return {read, change, current: () => current, stop: () => { stopped = true; }};
}
export type SecretsReader = ReturnType<typeof secretsReader>;

/** Coming back to the window reads the list again: not while hidden, and once for the focus and visibilitychange that come together. */
export const rereads = (hidden: boolean, now: number, last: number): boolean => !hidden && now - last >= 1000;

/** One 试一次, or a save that did not go through: what the key's row and the dialog show. */
export type Tested = {at: number; outcome: SecretTestOutcome | 'refused' | 'saveFailed'; message: string; status?: number};

export async function saveKey(change: (request: Change) => Promise<AdminReply>, keyId: string, value: string): Promise<{kind: 'saved'; last4?: string} | {kind: 'failed'; message: string}> {
  try {
    const reply = await change({type: 'setSecret', keyId, value});
    if (reply.kind === 'refused') return {kind: 'failed', message: reply.message};
    if (reply.kind !== 'secrets') return {kind: 'failed', message: 'daemon 回的不是密钥的列表'};
    const last4 = reply.services.find(service => service.keyId === keyId)?.last4;
    return {kind: 'saved', ...(last4 ? {last4} : {})};
  } catch (error) {
    return {kind: 'failed', message: errorText(error)};
  }
}

export async function testKey(admin: Admin, keyId: string, now: () => number = Date.now): Promise<Tested> {
  try {
    const reply = await admin({type: 'testSecret', keyId});
    if (reply.kind === 'secretTested') return {at: now(), outcome: reply.outcome, message: reply.message, ...(reply.status !== undefined ? {status: reply.status} : {})};
    return {at: now(), outcome: 'refused', message: reply.kind === 'refused' ? reply.message : 'daemon 回的不是试一次的结果'};
  } catch (error) {
    return {at: now(), outcome: 'refused', message: errorText(error)};
  }
}

/** A key's row: busy while its save or 试一次 runs, and the last result under the description. */
export type RowState = {busy?: 'saving' | 'testing'; tested?: Tested};
/**
 * The fill dialog: the key, then its save and its 试一次 as two requests, then what 试一次 found unless it was 能用.
 * `was`: the last four when it opened, which its header names until the result (the list has the new one by then).
 */
export type FillFlow = {id: number; keyId: string; replacing: boolean; was?: string; step: 'input' | 'saving' | 'testing' | 'result'; last4?: string; result?: Tested};
/** What the 密钥 page keeps besides the list; `refocus`: the key whose row takes focus once a dialog is gone. */
export type KeyFlows = {rows: Record<string, RowState>; fill?: FillFlow; refocus?: string};

/**
 * The fill dialog and the keys' rows (s23g2 做法). Each fill takes its own id; what its requests bring back reaches
 * the dialog only while that fill is the open one, and always reaches the key's row, so a dialog closed mid-way, or
 * a newer one, is never reopened or overwritten. 能用 closes the dialog; any other result stays in it.
 */
export function keyFlows(admin: Admin, change: (request: Change) => Promise<AdminReply>, publish: (state: KeyFlows) => void, now: () => number = Date.now) {
  let state: KeyFlows = {rows: {}};
  let ids = 0;
  /** each key as the list last had it: status and last four */
  const listedAs = new Map<string, string>();
  const set = (next: KeyFlows) => { state = next; publish(state); };
  const row = (keyId: string, patch: RowState) => set({...state, rows: {...state.rows, [keyId]: {...state.rows[keyId], ...patch}}});
  const step = (id: number | undefined, next: (flow: FillFlow) => FillFlow) => {
    if (id !== undefined && state.fill?.id === id) set({...state, fill: next(state.fill)});
  };
  const closed = (keyId: string) => set({...state, fill: undefined, refocus: keyId});
  async function test(keyId: string, id?: number) {
    row(keyId, {busy: 'testing'});
    step(id, flow => ({...flow, step: 'testing'}));
    const tested = await testKey(admin, keyId, now);
    row(keyId, {busy: undefined, tested});
    if (tested.outcome === 'ok' && id !== undefined && state.fill?.id === id) closed(keyId);
    else step(id, flow => ({...flow, step: 'result', result: tested}));
  }
  return {
    current: () => state,
    open(keyId: string, replacing: boolean, was?: string) { set({...state, fill: {id: ++ids, keyId, replacing, ...(was ? {was} : {}), step: 'input'}}); },
    close() { if (state.fill) closed(state.fill.keyId); },
    /** 再试一次 or 换一个: back to the field */
    again() { step(state.fill?.id, flow => ({...flow, step: 'input', result: undefined})); },
    retest: () => state.fill ? test(state.fill.keyId, state.fill.id) : Promise.resolve(),
    test: (keyId: string) => test(keyId),
    async save(value: string) {
      const flow = state.fill;
      if (!flow || flow.step !== 'input') return;
      const {id, keyId} = flow;
      row(keyId, {busy: 'saving'});
      step(id, current => ({...current, step: 'saving', result: undefined}));
      const saved = await saveKey(change, keyId, value);
      if (saved.kind === 'failed') {
        const tested: Tested = {at: now(), outcome: 'saveFailed', message: saved.message};
        row(keyId, {busy: undefined, tested});
        step(id, current => ({...current, step: 'result', result: tested}));
        return;
      }
      row(keyId, {tested: undefined});
      step(id, current => ({...current, last4: saved.last4}));
      await test(keyId, id);
    },
    /** A removal went through: the row starts over, and focus goes back to it. */
    removed(keyId: string) { set({...state, rows: {...state.rows, [keyId]: {...state.rows[keyId], tested: undefined}}, refocus: keyId}); },
    refocusTo(keyId: string) { set({...state, refocus: keyId}); },
    /** Focus went back (or elsewhere): nothing to render, so nothing is published. */
    refocused(keyId: string) { if (state.refocus === keyId) state = {...state, refocus: undefined}; },
    /**
     * The list as read: a key stored, replaced or removed elsewhere since its row's result drops that result, which
     * was about the key before (多角度审查 R-F2). A row whose request still runs keeps it; what lands next replaces it.
     */
    listed(services: readonly SecretService[]) {
      let rows = state.rows;
      for (const service of services) {
        const stored = `${service.status}:${service.last4 ?? ''}`;
        const before = listedAs.get(service.keyId);
        listedAs.set(service.keyId, stored);
        const current = rows[service.keyId];
        if (before !== undefined && before !== stored && current?.tested && !current.busy) rows = {...rows, [service.keyId]: {}};
      }
      if (rows !== state.rows) set({...state, rows});
    },
    /** 重新读取: the results go, a request that still runs keeps its row busy. */
    forget() { set({...state, rows: Object.fromEntries(Object.entries(state.rows).map(([keyId, current]) => [keyId, {busy: current.busy}]))}); },
  };
}
export type KeyFlowsController = ReturnType<typeof keyFlows>;

/** 能用 green; a busy, unreachable or slow service yellow (only this try failed); a key refused, not taken or not saved red. */
export const testTone = (outcome: Tested['outcome']): Tone =>
  outcome === 'ok' ? 'success' : outcome === 'busy' || outcome === 'network' || outcome === 'timeout' ? 'warning' : 'danger';

export const testedText = (tested: Tested): string =>
  tested.outcome === 'saveFailed' ? `保存失败：${tested.message}` : tested.outcome === 'refused' ? `验证失败：${tested.message}` : `验证结果：${tested.message}`;

/** The result step of the fill dialog; 能用 closes it instead (owner 没看稿子，按推荐：v1-plan 第 5 节). */
export function resultCopy(tested: Tested, service: string, last4?: string): {tone: Tone; title: string; body: string; footer: 'replace' | 'done' | 'retry' | 'again'} {
  const saved = `密钥已保存${last4 ? `（末四位 ${last4}）` : ''}`;
  switch (tested.outcome) {
    case 'ok': return {tone: 'success', title: tested.message, body: `${saved}。`, footer: 'done'};
    case 'auth': return {tone: 'danger', title: tested.message, body: `${saved}，但无法用于智能判断。请更换密钥。`, footer: 'replace'};
    case 'busy': return {tone: 'warning', title: tested.message, body: `${saved}。请稍后重新验证。`, footer: 'done'};
    case 'network': return {tone: 'warning', title: tested.message, body: `${saved}。连接恢复后可重新验证。`, footer: 'retry'};
    case 'timeout': return {tone: 'warning', title: tested.message, body: `${saved}。本次验证超时，请重试。`, footer: 'retry'};
    case 'failed': return {tone: 'danger', title: tested.message, footer: 'done',
      body: tested.status !== undefined && tested.status >= 400 ? `${saved}。请检查 ${service} 账号及权限。` : `${saved}。请稍后重新验证。`};
    case 'refused': return {tone: 'danger', title: '验证失败', body: `${tested.message}。${saved}。`, footer: 'retry'};
    case 'saveFailed': return {tone: 'danger', title: '保存失败', body: `${tested.message}。密钥未保存，请重试。`, footer: 'again'};
  }
}

/** "TypeSafe 的 Jev": the service and the models a judge picker lists for it. */
export const choice = (service: Pick<SecretService, 'displayName' | 'models'>): string =>
  `${service.displayName} 的 ${service.models.map(model => model.displayName).join('、') || '决策模型'}`;

export function keyStatus(service: SecretService): {text: string; tone: Tone} {
  switch (service.status) {
    case 'set': return {text: `已添加${service.last4 ? ` ••••${service.last4}` : ''}`, tone: 'success'};
    case 'missing': return {text: '未添加', tone: 'warning'};
    case 'invalid': return {text: '密钥无效', tone: 'danger'};
    case 'unreadable': return {text: '读取失败', tone: 'danger'};
  }
}

/** A line of 谁在用: the Bot or the group, then whose it is and how it chose. */
export const useName = (use: SecretUse): string => use.groupId === undefined ? use.agentName : use.groupName || '未命名飞书群';
export function useNote(use: SecretUse, service: Pick<SecretService, 'displayName' | 'models'>): string {
  if (use.groupId === undefined) return `Bot 默认用 ${choice(service)}，它的智能群没自己选的都跟着`;
  return `${use.agentName}，${use.inherited ? `跟着 Bot 默认用 ${choice(service)}` : `自己选了 ${choice(service)}`}${use.notSmart ? '；现在不是智能群，什么都不判断' : ''}`;
}
/** The command line's form (`vonvon secrets list`), for the one row on the 状态与诊断 page. */
export const useText = (use: SecretUse): string => use.groupId === undefined ? `${use.agentName}（Bot 默认）`
  : `${use.groupName || '未命名飞书群'}（${[use.agentName, use.inherited && '跟着 Bot 默认', use.notSmart && '现在不是智能群'].filter(Boolean).join('，')}）`;
export function useCount(uses: readonly SecretUse[], between = ' · '): string {
  const bots = new Set(uses.map(use => use.agentId)).size;
  const groups = uses.filter(use => use.groupId !== undefined).length;
  return groups ? `${bots} 个 Bot${between}${groups} 个飞书群` : `${bots} 个 Bot`;
}

const BOTS_LOG = '请在日志中查看 Bot 清单读取失败的原因。';
const BOT_LOG = '请在日志中查看 Bot 设置读取失败的原因。';

/** Whose choices `inUse` is missing, and where the log says why: the command line's words. */
export const unreadNotes = (view: Pick<SecretsView, 'botsUnreadable' | 'unreadBots'>): string[] => [
  ...view.botsUnreadable ? [`Bot 清单（bots.json）读不了，谁选了它没算进来；${BOTS_LOG}`] : [],
  ...view.unreadBots ? [`有 ${view.unreadBots} 个 Bot 的设置读不了，没算进来；${BOT_LOG}`] : [],
];

/**
 * The removal's confirmation: who chose it, in two lists, or why no one is listed (product.md 3.1 第 9 条). When no
 * one is listed because of what could not be read, the lead says it once, with where the log says why, in place of
 * that note. `place`: where the key is kept, 本机 or 「X」上 (`placeOf`).
 */
export function removalCopy(service: SecretService, view: Pick<SecretsView, 'botsUnreadable' | 'unreadBots'>, place = '本机') {
  const active = service.inUse.filter(use => !use.notSmart);
  const notSmart = service.inUse.filter(use => use.notSmart);
  const unknown = service.inUse.length ? undefined
    : view.botsUnreadable ? {text: 'Bot 清单读不了，不知道谁选了它', log: BOTS_LOG}
      : view.unreadBots ? {text: `有 ${view.unreadBots} 个 Bot 的设置读不了，不知道它们选没选它`, log: BOT_LOG} : undefined;
  return {
    description: service.status === 'invalid' ? `存着的这串不能用，现在已经按没填处理。只删${place}存的这一份。`
      : `${service.last4 ? `末四位 ${service.last4}。` : ''}只删${place}存的这一份，${service.displayName} 那边的 key 还在。`,
    lead: unknown ? `${unknown.text}；${unknown.log}选了它的飞书群删了以后${MEANWHILE}，重新填就恢复。`
      : !service.inUse.length ? '现在没有 Bot 或飞书群选它，删了不影响任何群。'
        : !active.length ? undefined
          : service.status === 'invalid' ? '存着的这串不能用，下面这些现在已经按没填处理，删了也一样；重新填就恢复。'
            : '删了以后，下面这些 Bot 和飞书群要判断的消息按出错处理：没点名的不回，真人 @ 的照旧回。重新填就恢复。',
    active, notSmart,
    notSmartNote: notSmart.length ? '下面这些现在不是智能群，删了不影响；改成智能群后会按出错处理。' : undefined,
    notes: unreadNotes(view).filter(note => !unknown || !note.endsWith(unknown.log)),
  };
}

/** The 决策模型的 key row names up to four of those who chose it, else three and counts them all; the 密钥 page lists them (多角度审查 B3). */
const NAMED = 3;
/** The 决策模型的 key row on the 状态与诊断 page (product.md 3.1 第 8 条): always there, a problem only when someone chose it.
 * `place` as for `removalCopy`. */
export function keyDiagnosis(service: SecretService, view: Pick<SecretsView, 'botsUnreadable' | 'unreadBots'>, place = '本机'): {
  status: string; tone: Tone; description: string; action?: {label: string; to: 'secrets' | 'logs'};
} {
  const named = service.inUse.length > NAMED + 1 ? service.inUse.slice(0, NAMED) : service.inUse;
  const who = named.map(useText).join('、') + (named.length < service.inUse.length ? `等 ${useCount(service.inUse, '、')}` : '');
  const chose = `${who}选了 ${choice(service)}`;
  const nobody = `现在没有 Bot 或飞书群选 ${choice(service)}`;
  const notes = unreadNotes(view).join('');
  const meanwhile = `它们${MEANWHILE}。`;
  const used = service.inUse.length > 0;
  switch (service.status) {
    case 'set': return {status: `${service.displayName} 已填${service.last4 ? ` ••••${service.last4}` : ''}`, tone: 'success',
      description: `${used ? `选了 ${choice(service)} 的：${who}。` : `${nobody}。`}${notes}`};
    case 'missing': return used
      ? {status: `还没填 ${service.displayName} 的 key`, tone: 'warning', description: `${chose}，${place}还没填它的 key。填之前${meanwhile}${notes}`, action: {label: '去填', to: 'secrets'}}
      : {status: `${service.displayName} 没填`, tone: 'neutral', description: `${nobody}，用不着它的 key。${notes}`, action: {label: '去填', to: 'secrets'}};
    case 'invalid': return {status: '存着的 key 不能用', tone: used ? 'danger' : 'warning', action: {label: '去重新填', to: 'secrets'},
      description: `${used ? `${chose}，但` : ''}存着的 ${service.displayName} 的 key 不是一串可见字符，判断时当没填。${used ? `重新填之前${meanwhile}` : `${nobody}。`}${notes}`};
    case 'unreadable': return {status: '读不了密钥库', tone: 'danger', action: {label: '看日志', to: 'logs'},
      description: `${used ? `${chose}，但` : ''}密钥库读不了，看不出填没填 ${service.displayName} 的 key：${service.problem ?? '密钥库读不了'}（${service.code ?? 'UNKNOWN'}）。${used ? `读得了之前${meanwhile}` : ''}${notes}`};
  }
}
