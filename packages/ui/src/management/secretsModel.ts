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
export const MEANWHILE = '要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区）';

/** A daemon from before s23g knows none of these requests (v1-plan s23g 做法（实现时定下的）). */
const isOld = (error: unknown): boolean => error instanceof Error && (error as {code?: unknown}).code === 'invalid_request';
export const errorText = (error: unknown, fallback: string): string =>
  isOld(error) ? OLD_DAEMON : error instanceof Error && error.message ? error.message : fallback;

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
    try {
      const reply = await admin({type: 'secrets'});
      if (reply.kind !== 'secrets') throw new Error('daemon 回的不是密钥的列表');
      land(asked, () => ({kind: 'ready', view: reply}));
    } catch (error) {
      land(asked, previous => isOld(error) ? {kind: 'old'}
        : previous.kind === 'ready' ? {...previous, problem: errorText(error, '没读到')}
          : {kind: 'failed', problem: errorText(error, '没读到')});
    }
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
    return {kind: 'failed', message: errorText(error, '没连上 daemon')};
  }
}

export async function testKey(admin: Admin, keyId: string, now: () => number = Date.now): Promise<Tested> {
  try {
    const reply = await admin({type: 'testSecret', keyId});
    if (reply.kind === 'secretTested') return {at: now(), outcome: reply.outcome, message: reply.message, ...(reply.status !== undefined ? {status: reply.status} : {})};
    return {at: now(), outcome: 'refused', message: reply.kind === 'refused' ? reply.message : 'daemon 回的不是试一次的结果'};
  } catch (error) {
    return {at: now(), outcome: 'refused', message: errorText(error, '没连上 daemon')};
  }
}

/** 能用 green; a busy, unreachable or slow service yellow (only this try failed); a key refused, not taken or not saved red. */
export const testTone = (outcome: Tested['outcome']): Tone =>
  outcome === 'ok' ? 'success' : outcome === 'busy' || outcome === 'network' || outcome === 'timeout' ? 'warning' : 'danger';

export const testedText = (tested: Tested): string =>
  tested.outcome === 'saveFailed' ? `没存上：${tested.message}` : tested.outcome === 'refused' ? `没试成：${tested.message}` : `试了一次：${tested.message}`;

/** The result step of the fill dialog; 能用 closes it instead (owner 没看稿子，按推荐：v1-plan 第 5 节). */
export function resultCopy(tested: Tested, service: string, last4?: string): {tone: Tone; title: string; body: string; footer: 'replace' | 'done' | 'retry' | 'again'} {
  const saved = `key 已经存下${last4 ? `（末四位 ${last4}）` : ''}`;
  switch (tested.outcome) {
    case 'ok': return {tone: 'success', title: tested.message, body: `${saved}。`, footer: 'done'};
    case 'auth': return {tone: 'danger', title: tested.message, body: `${saved}，但判断会出错；换一个再填。`, footer: 'replace'};
    case 'busy': return {tone: 'warning', title: tested.message, body: `${saved}。稍后再点"试一次"确认。`, footer: 'done'};
    case 'network': return {tone: 'warning', title: tested.message, body: `${saved}，只是这次没试成。网络好了点"试一次"再看。`, footer: 'retry'};
    case 'timeout': return {tone: 'warning', title: tested.message, body: `${saved}，只是这次没试成。稍后点"试一次"再看。`, footer: 'retry'};
    case 'failed': return {tone: 'danger', title: tested.message, footer: 'done',
      body: tested.status !== undefined && tested.status >= 400 ? `${saved}。多半是账号或权限的问题，去 ${service} 的控制台看看。` : `${saved}，稍后再试一次。`};
    case 'refused': return {tone: 'danger', title: '没试成', body: `${tested.message}。${saved}。`, footer: 'retry'};
    case 'saveFailed': return {tone: 'danger', title: '没做成', body: `没存上：${tested.message}。key 没有存，再试一次或者等一会。`, footer: 'again'};
  }
}

/** "TypeSafe 的 Jev": the service and the models a judge picker lists for it. */
export const choice = (service: Pick<SecretService, 'displayName' | 'models'>): string =>
  `${service.displayName} 的 ${service.models.map(model => model.displayName).join('、') || '决策模型'}`;

export function keyStatus(service: SecretService): {text: string; tone: Tone} {
  switch (service.status) {
    case 'set': return {text: `已填${service.last4 ? ` ••••${service.last4}` : ''}`, tone: 'success'};
    case 'missing': return {text: '还没填', tone: 'warning'};
    case 'invalid': return {text: '存着的 key 不能用', tone: 'danger'};
    case 'unreadable': return {text: '读不了', tone: 'danger'};
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
export function useCount(uses: readonly SecretUse[]): string {
  const bots = new Set(uses.map(use => use.agentId)).size;
  const groups = uses.filter(use => use.groupId !== undefined).length;
  return groups ? `${bots} 个 Bot · ${groups} 个飞书群` : `${bots} 个 Bot`;
}

/** Whose choices `inUse` is missing, and where the log says why: the command line's words. */
export const unreadNotes = (view: Pick<SecretsView, 'botsUnreadable' | 'unreadBots'>): string[] => [
  ...view.botsUnreadable ? ['Bot 清单（bots.json）读不了，谁选了它没算进来；vonvon daemon logs 里的 secrets.bots-unreadable 有原因。'] : [],
  ...view.unreadBots ? [`有 ${view.unreadBots} 个 Bot 的设置读不了，没算进来；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。`] : [],
];

/** The removal's confirmation: who chose it, in two lists, or why no one is listed (product.md 3.1 第 9 条). */
export function removalCopy(service: SecretService, view: Pick<SecretsView, 'botsUnreadable' | 'unreadBots'>) {
  const active = service.inUse.filter(use => !use.notSmart);
  const notSmart = service.inUse.filter(use => use.notSmart);
  const unknown = service.inUse.length ? undefined
    : view.botsUnreadable ? 'Bot 清单读不了，不知道谁选了它。'
      : view.unreadBots ? `有 ${view.unreadBots} 个 Bot 的设置读不了，不知道它们选没选它。` : undefined;
  return {
    description: service.status === 'invalid' ? '存着的这串不能用，现在已经按没填处理。只删本机存的这一份。'
      : `${service.last4 ? `末四位 ${service.last4}。` : ''}只删本机存的这一份，${service.displayName} 那边的 key 还在。`,
    lead: unknown ? `${unknown}选了它的飞书群删了以后${MEANWHILE}，重新填就恢复。`
      : !service.inUse.length ? '现在没有 Bot 或飞书群选它，删了不影响任何群。'
        : !active.length ? undefined
          : service.status === 'invalid' ? '存着的这串不能用，下面这些现在已经按没填处理，删了也一样；重新填就恢复。'
            : '删了以后，下面这些 Bot 和飞书群要判断的消息按出错处理：没 @ Bot 的不回，@ 的回在主区。重新填就恢复。',
    active, notSmart,
    notSmartNote: notSmart.length ? '下面这些现在不是智能群，删了不影响；改成智能群后会按出错处理。' : undefined,
    notes: unreadNotes(view),
  };
}

/** The 决策模型的 key row on the 状态与诊断 page (product.md 3.1 第 8 条): always there, a problem only when someone chose it. */
export function keyDiagnosis(service: SecretService, view: Pick<SecretsView, 'botsUnreadable' | 'unreadBots'>): {
  status: string; tone: Tone; description: string; action?: {label: string; to: 'secrets' | 'logs'};
} {
  const who = service.inUse.map(useText).join('、');
  const chose = `${who}选了 ${choice(service)}`;
  const nobody = `现在没有 Bot 或飞书群选 ${choice(service)}`;
  const notes = unreadNotes(view).join('');
  const meanwhile = `它们${MEANWHILE}。`;
  const used = service.inUse.length > 0;
  switch (service.status) {
    case 'set': return {status: `${service.displayName} 已填${service.last4 ? ` ••••${service.last4}` : ''}`, tone: 'success',
      description: `${used ? `选了 ${choice(service)} 的：${who}。` : `${nobody}。`}${notes}`};
    case 'missing': return used
      ? {status: `还没填 ${service.displayName} 的 key`, tone: 'warning', description: `${chose}，本机还没填它的 key。填之前${meanwhile}${notes}`, action: {label: '去填', to: 'secrets'}}
      : {status: `${service.displayName} 没填`, tone: 'neutral', description: `${nobody}，用不着它的 key。${notes}`, action: {label: '去填', to: 'secrets'}};
    case 'invalid': return {status: '存着的 key 不能用', tone: used ? 'danger' : 'warning', action: {label: '去重新填', to: 'secrets'},
      description: `${used ? `${chose}，但` : ''}存着的 ${service.displayName} 的 key 不是一串可见字符，判断时当没填。${used ? `重新填之前${meanwhile}` : `${nobody}。`}${notes}`};
    case 'unreadable': return {status: '读不了密钥库', tone: 'danger', action: {label: '看日志', to: 'logs'},
      description: `${used ? `${chose}，但` : ''}密钥库读不了，看不出填没填 ${service.displayName} 的 key：${service.problem ?? '密钥库读不了'}（${service.code ?? 'UNKNOWN'}）。${used ? `读得了之前${meanwhile}` : ''}${notes}`};
  }
}
