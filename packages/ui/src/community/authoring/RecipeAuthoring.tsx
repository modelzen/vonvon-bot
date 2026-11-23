import {useEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {
  agentIdSchema,
  groupIdSchema,
  type Agent,
  type AgentId,
  type AuthoringHandoff,
  type DesktopAuthoringOperation,
  type DesktopAuthoringReply,
  type DesktopAuthoringRequest,
  type DesktopSnapshot,
  type GroupId,
  type RecipeAuthoringShell,
  type ViewId,
} from '@vonvon/protocol';
import {useAccount} from '../../account-context';
import {useActiveDevice, useClient, useShellCapabilities} from '../../client-context';
import {GlowButton} from '../../GlowButton';
import {Button} from '../../reference/components/ui';
import {Dialog} from '../../reference/components/ui/Dialog';
import {OPEN_SETTING_EVENT} from '../../search';
import {botChatUrl, openExternalUrl} from '../../url-actions';
import {CopyButton} from '../RecipeContent';
import './authoring.css';

type Session = Extract<DesktopAuthoringReply, {kind: 'session'}>;
type Challenge = Extract<DesktopAuthoringReply, {kind: 'challenge'}>;
type Link = Extract<DesktopAuthoringReply, {kind: 'link'}>;
export type AuthoringSource = {botId: AgentId; groupId: GroupId};
type Draft = {draftId: string; revision: number};
type Target = {source: AuthoringSource; registration: string; botName: string; groupName: string} | {draft: Draft};
type Props = {
  source?: AuthoringSource;
  draft?: Draft;
  parent?: {recipeId: string; versionId: string};
  onBack: () => void;
  onSaved: (draftId: string, revision: number) => void;
};
const progress: Record<DesktopAuthoringOperation['state'], string> = {
  pendingMain: '正在核验账号与来源',
  sending: '正在发送飞书卡片',
  waiting: '等待本人在飞书操作',
  candidate: '等待本人在飞书确认候选',
  pendingCloud: '飞书已确认，正在保存私人草稿',
  completed: '私人草稿已保存',
  cancelPending: '正在取消，等待云端确认',
  cancelled: '已取消',
  expired: '请求已到期',
  needsReview: '来源或授权已变化，请重新核对',
};
const message = (reason: unknown) => (reason instanceof Error ? reason.message : '暂时无法连接来源 Bot。');
const detach = (shell: RecipeAuthoringShell, handle: string) => void shell.request({type: 'detach', handle}).catch(() => {});
function useSnapshot() {
  const client = useClient(),
    device = useActiveDevice();
  const [read, setRead] = useState<{client: typeof client; deviceId: ViewId; snapshot: DesktopSnapshot}>();
  useEffect(() => {
    let live = true;
    const stop = client.watchSnapshots((snapshot) => {
      if (live) setRead({client, deviceId: device.id, snapshot});
    });
    return () => {
      live = false;
      stop();
    };
  }, [client, device.id]);
  return read?.client === client && read.deviceId === device.id ? read.snapshot : undefined;
}

type StoredHandoff = {retryId: string; botId?: AgentId; groupId?: GroupId; registration?: string};
function storedHandoff(key: string): StoredHandoff | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const record = JSON.parse(raw);
    if (
      typeof record.retryId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(record.retryId)
    )
      return;
    if (record.botId === undefined && record.groupId === undefined) return {retryId: record.retryId};
    if (
      agentIdSchema.safeParse(record.botId).success &&
      groupIdSchema.safeParse(record.groupId).success &&
      typeof record.registration === 'string'
    )
      return record;
  } catch {
    return;
  }
}

function SourceDialog({
  title,
  onBack,
  footer,
  children,
  focus,
}: {
  title: string;
  onBack: () => void;
  footer?: ReactNode;
  children: ReactNode;
  focus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open size="lg" initialFocusRef={focus} title={title} onClose={onBack} footer={footer}>
      <div className="recipe-source-dialog">{children}</div>
    </Dialog>
  );
}
export function RecipeAuthoringPage(props: Props) {
  const account = useAccount(),
    device = useActiveDevice(),
    shell = useShellCapabilities()?.recipeAuthoring;
  const snapshot = useSnapshot();
  const title = props.draft ? '在飞书私聊中修改' : props.parent ? '准备新版本' : '准备配方';
  if (account.status?.kind !== 'signedIn')
    return (
      <SourceDialog
        title={title}
        onBack={props.onBack}
        footer={
          <GlowButton variant="dark" disabled={!account.supported} onClick={() => void account.login()}>
            登录
          </GlowButton>
        }
      >
        <p>登录后可以把所选内容保存为私人草稿。</p>
      </SourceDialog>
    );
  if (!shell)
    return (
      <SourceDialog title={title} onBack={props.onBack}>
        <p>此设备暂不支持聊天草稿，请更新桌面应用。</p>
      </SourceDialog>
    );
  const accountId = account.status.accountId;
  const scope = JSON.stringify([
    accountId,
    device.id,
    props.draft?.draftId,
    props.draft?.revision,
    props.parent?.recipeId,
    props.parent?.versionId,
    props.source?.botId,
    props.source?.groupId,
  ]);
  return (
    <SourcePicker
      key={scope}
      {...props}
      scope={'recipe-private-handoff:' + scope}
      title={title}
      shell={shell}
      accountId={accountId}
      viewId={device.id}
      snapshot={snapshot}
    />
  );
}

function SourcePicker(
  props: Props & {
    scope: string;
    title: string;
    shell: RecipeAuthoringShell;
    accountId: string;
    viewId: ViewId;
    snapshot?: DesktopSnapshot;
  }
) {
  const {scope, source, draft, snapshot, onBack, title} = props;
  const botInput = useRef<HTMLSelectElement>(null);
  const [stored, setStored] = useState(() => storedHandoff(scope));
  const [botId, setBot] = useState<AgentId | undefined>(source?.botId ?? stored?.botId);
  const [groupId, setGroup] = useState<GroupId | undefined>(source?.groupId ?? stored?.groupId);
  const [confirmed, setConfirmed] = useState<Target | undefined>(draft ? {draft} : undefined);

  const bots = snapshot?.agents.filter((b) => b.running) ?? [];
  const bindings =
    snapshot?.memberships.filter(
      (m) => !m.stale && bots.some((b) => b.id === m.agentId) && snapshot.groups.some((g) => g.id === m.groupId)
    ) ?? [];
  const availableBots = bots.filter((b) => bindings.some((m) => m.agentId === b.id));
  const bot = availableBots.find((b) => b.id === (botId ?? (availableBots.length === 1 ? availableBots[0]!.id : undefined)));
  const groups = bindings.filter((m) => m.agentId === bot?.id);
  const membership = groups.find((m) => m.groupId === (groupId ?? (groups.length === 1 ? groups[0]!.groupId : undefined)));
  const group = snapshot?.groups.find((g) => g.id === membership?.groupId);
  const registration = JSON.stringify([bot?.tenant, bot?.registrationId, bot?.registeredAt, membership?.bindingIncarnation]);
  const chosen: Target | undefined =
    bot && group
      ? {source: {botId: bot.id, groupId: group.id}, registration, botName: bot.name, groupName: group.name}
      : undefined;
  const matching =
    chosen &&
    'source' in chosen &&
    stored?.botId === chosen.source.botId &&
    stored?.groupId === chosen.source.groupId &&
    stored?.registration === registration;
  const target = confirmed ?? (matching ? chosen : undefined);
  const ready = snapshot && snapshot.host.kind === 'connected' && !snapshot.stale;
  if (
    target &&
    ('draft' in target ||
      (ready &&
        target.registration === registration &&
        chosen &&
        'source' in chosen &&
        target.source.botId === chosen.source.botId &&
        target.source.groupId === chosen.source.groupId))
  )
    return (
      <PrivateFlow
        {...props}
        target={target}
        resume={Boolean(matching) || Boolean(draft && stored)}
        agent={snapshot?.agents.find((b) => 'source' in target && b.id === target.source.botId)}
        onRestart={() => {
          localStorage.removeItem(scope);
          setStored(undefined);
          setConfirmed(undefined);
          if (draft) onBack();
        }}
      />
    );
  const invalid = Boolean((source && !chosen) || confirmed || (stored && !matching));
  const unavailableBot = source && snapshot?.agents.find((b) => b.id === source.botId && !b.running);
  const destination = bots.length && !unavailableBot ? 'groups' : 'agents';
  function resetSelection() {
    localStorage.removeItem(scope);
    setStored(undefined);
    setConfirmed(undefined);
    setBot(source?.botId);
    setGroup(source?.groupId);
  }
  const sourceReplaced = ready && !!stored && !matching;
  const problem = !snapshot
    ? '正在读取 Bot 与群聊…'
    : !ready
      ? '来源设备暂不可用，请恢复连接后再试。'
      : invalid
        ? '原 Bot 或群绑定已变化，请回到群组核对来源。'
        : !availableBots.length
          ? bots.length
            ? '当前设备没有可准备配方的群聊。先在群组中连接一个 Bot 和已有群聊。'
            : '当前设备没有运行中的 Bot。请先添加或启动 Bot。'
          : undefined;
  return (
    <SourceDialog
      title={title}
      onBack={onBack}
      focus={botInput}
      footer={
        <>
          <Button onClick={onBack}>取消</Button>
          {sourceReplaced ? (
            <GlowButton variant="dark" onClick={resetSelection}>
              重新选择来源
            </GlowButton>
          ) : problem && ready ? (
            <GlowButton
              variant="dark"
              onClick={() => {
                onBack();
                window.dispatchEvent(
                  new CustomEvent(OPEN_SETTING_EVENT, {detail: {page: 'collaboration', view: destination}})
                );
              }}
            >
              {destination === 'agents' ? '前往 Bot' : '前往群组'}
            </GlowButton>
          ) : (
            <GlowButton
              variant="dark"
              disabled={!chosen || !!problem}
              onClick={() => {
                if (chosen) setConfirmed(chosen);
              }}
            >
              确认
            </GlowButton>
          )}
        </>
      }
    >
      <p>{props.parent ? '选择要整理为新版本的群内 Bot 配置。' : '选择要整理的群内 Bot 配置。'}</p>
      {problem ? (
        <p role="status">{problem}</p>
      ) : source ? (
        <dl className="recipe-source-fixed">
          <dt>Bot</dt>
          <dd>{bot?.name}</dd>
          <dt>群聊</dt>
          <dd>{group?.name}</dd>
        </dl>
      ) : (
        <div className="recipe-source-fields">
          <label>
            Bot
            <select
              ref={botInput}
              value={bot?.id ?? ''}
              onChange={(event) => {
                setBot(agentIdSchema.parse(event.target.value));
                setGroup(undefined);
              }}
            >
              <option value="" disabled>
                选择 Bot
              </option>
              {availableBots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            群聊
            <select
              value={group?.id ?? ''}
              disabled={!bot}
              onChange={(event) => setGroup(groupIdSchema.parse(event.target.value))}
            >
              <option value="" disabled>
                选择已有群聊
              </option>
              {groups.map((m) => (
                <option key={m.groupId} value={m.groupId}>
                  {snapshot?.groups.find((g) => g.id === m.groupId)?.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {!problem && (
        <p className="recipe-source-help">
          确认后，{bot ? '「' + bot.name + '」' : '所选 Bot'}会在飞书私聊里发来消息。草稿生成后，回这里检查并发布。
        </p>
      )}
    </SourceDialog>
  );
}

function PrivateFlow({
  target,
  resume,
  shell,
  scope,
  title,
  accountId,
  viewId,
  agent,
  snapshot,
  parent,
  onRestart,
  onBack,
  onSaved,
}: Props & {
  target: Target;
  resume: boolean;
  shell: RecipeAuthoringShell;
  scope: string;
  title: string;
  accountId: string;
  viewId: ViewId;
  agent?: Agent;
  snapshot?: DesktopSnapshot;
  onRestart: () => void;
}) {
  const capabilities = useShellCapabilities();
  const [session, setSession] = useState<Session>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [link, setLink] = useState<Link>();
  const [handoff, setHandoff] = useState<AuthoringHandoff>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false),
    [attempt, reconnect] = useState(0);
  const generation = useRef(0);
  const [now, setNow] = useState(Date.now());
  const owner = useRef<Session | undefined>(undefined),
    locked = useRef(false);
  const retry = useRef<string | undefined>(undefined);
  const botId = 'source' in target ? target.source.botId : undefined,
    groupId = 'source' in target ? target.source.groupId : undefined;
  const draftId = 'draft' in target ? target.draft.draftId : undefined,
    revision = 'draft' in target ? target.draft.revision : undefined;
  const operation = handoff?.operationId
    ? session?.operations.find((o) => o.operationId === handoff.operationId)
    : undefined;
  const accepted = operation?.receipt?.status === 'accepted' ? operation.receipt : undefined;
  const done =
    accepted ||
    operation?.state === 'cancelled' ||
    operation?.state === 'expired' ||
    (handoff && ['cancelled', 'expired', 'needsReview'].includes(handoff.state));
  async function request(s: Session, input: DesktopAuthoringRequest) {
    const result = await shell.request(input);
    if (owner.current !== s) return;
    return result;
  }
  function adopt(value: DesktopAuthoringReply | undefined, id: string) {
    if (!value) return;
    if (
      value.kind !== 'handoff' ||
      value.handoff.retryId !== id ||
      value.handoff.draftId !== draftId ||
      (groupId && value.handoff.groupId !== groupId)
    )
      throw new Error('请求来源已变化，请重新核对。');
    if (!draftId && value.handoff.state === 'cancelled') localStorage.removeItem(scope);
    setHandoff(value.handoff);
    return value.handoff;
  }
  async function progressFor(s: Session, id: string) {
    const epoch = generation.current;
    const reply = await request(s, {type: 'handoffStatus', handle: s.handle, retryId: id});
    if (epoch !== generation.current) return;
    const current = adopt(reply, id);
    if (reply?.kind === 'handoff' && reply.handoff.operationId) {
      const updated = await request(s, {type: 'status', handle: s.handle});
      if (epoch === generation.current && updated?.kind === 'session' && updated.handle === s.handle) setSession(updated);
    }
    return current;
  }
  async function begin(s: Session) {
    const id = retry.current ?? storedHandoff(scope)?.retryId ?? crypto.randomUUID();
    const entry: StoredHandoff =
      'source' in target ? {retryId: id, ...target.source, registration: target.registration} : {retryId: id};
    localStorage.setItem(scope, JSON.stringify(entry));
    retry.current = id;
    const input: DesktopAuthoringRequest =
      'source' in target
        ? {
            type: 'beginHandoff',
            handle: s.handle,
            groupId: target.source.groupId,
            retryId: id,
            ...(parent && {source: parent}),
          }
        : {
            type: 'beginDraftHandoff',
            handle: s.handle,
            draftId: target.draft.draftId,
            baseRevision: target.draft.revision,
            retryId: id,
          };
    adopt(await request(s, input), id);
  }
  async function newLink(s: Session) {
    setLink(undefined);
    setNotice(undefined);
    const reply = await request(s, {type: 'beginLink', handle: s.handle});
    if (reply?.kind === 'challenge') {
      setChallenge(reply);
      setNow(Date.now());
    }
  }
  useEffect(() => {
    let active = true,
      handle: string | undefined;
    locked.current = false;
    generation.current++;
    setSession(undefined);
    setChallenge(undefined);
    setHandoff(undefined);
    setLink(undefined);
    setNotice(undefined);
    setError(undefined);
    setBusy(true);
    void (async () => {
      const next = await shell.request(
        draftId && revision
          ? {type: 'openDraftSource', accountId, viewId, draftId, baseRevision: revision}
          : {type: 'open', accountId, viewId, botId: botId!, groupId: groupId!}
      );
      if (next.kind !== 'session') throw new Error('来源暂不可用。');
      handle = next.handle;
      if (!active) {
        detach(shell, handle);
        return;
      }
      owner.current = next;
      setSession(next);
      if (!next.linked) {
        await newLink(next);
        return;
      }
      const record = storedHandoff(scope);
      if (record && (resume || attempt)) {
        retry.current = record.retryId;
        if (attempt) await begin(next);
        const restored = await progressFor(next, record.retryId);
        if (active && !draftId && restored?.state === 'cancelled') onRestart();
      } else await begin(next);
    })()
      .catch((reason) => {
        if (active) setError(message(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      owner.current = undefined;
      if (handle) detach(shell, handle);
    };
  }, [accountId, viewId, draftId, revision, botId, groupId, shell, attempt]);
  async function act(action: (s: Session) => Promise<void>) {
    const s = owner.current;
    if (!s || busy || locked.current) return;
    locked.current = true;
    generation.current++;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action(s);
    } catch (reason) {
      if (owner.current === s) setError(message(reason));
    } finally {
      if (owner.current === s) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const s = owner.current,
      id = retry.current;
    if (!s || !handoff || !id || done) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>,
      delay = 2000;
    const poll = async () => {
      if (!active) return;
      if (!locked.current && document.visibilityState !== 'hidden') {
        const epoch = generation.current;
        try {
          await progressFor(s, id);
          if (active && epoch === generation.current) setError(undefined);
        } catch (reason) {
          if (active && epoch === generation.current) setError(message(reason));
        }
      }
      if (active) {
        delay = Math.min(delay * 2, 12000);
        timer = setTimeout(() => void poll(), delay);
      }
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [handoff?.retryId, session?.handle, Boolean(done)]);
  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);
  const expired = challenge && now >= challenge.expiresAt;
  const botName = session?.target.botName ?? ('botName' in target ? target.botName : undefined);
  const liveBot = agent ?? snapshot?.agents.find((b) => b.id === session?.target.botId);
  const chatUrl = liveBot?.tenant ? botChatUrl(liveBot.id, liveBot.tenant) : undefined;
  const openChat = chatUrl && (
    <Button
      onClick={() => void openExternalUrl(chatUrl, 'bot-chat', capabilities).catch((reason) => setError(message(reason)))}
    >
      打开 Bot 私聊
    </Button>
  );
  const status = operation?.contextPaused
    ? '聊天编辑已暂停，请重新核验。'
    : operation
      ? progress[operation.state]
      : handoff
        ? {
            selecting: '请在 Bot 私聊里选择内容。',
            awaitingAttestations: '正在核对所选内容的来源。',
            prepared: '正在同步私聊操作。',
            deliveryUnknown: '尚未确认送达。请先查看 Bot 私聊。',
            cancelled: '已取消本次准备。',
            expired: '本次准备已到期。',
            needsReview: '来源或授权已变化。',
          }[handoff.state]
        : undefined;
  return (
    <SourceDialog
      title={title}
      onBack={onBack}
      footer={
        <>
          {accepted ? (
            <GlowButton
              variant="dark"
              onClick={() => {
                localStorage.removeItem(scope);
                onSaved(accepted.draftId, accepted.revision);
              }}
            >
              查看草稿
            </GlowButton>
          ) : done ? (
            <Button onClick={onRestart}>重新准备</Button>
          ) : challenge ? (
            <>
              {openChat}
              {link?.recipient ? (
                <GlowButton
                  variant="dark"
                  disabled={busy || expired || !link.evidence}
                  onClick={() =>
                    void act(async (s) => {
                      const value = await request(s, {
                        type: 'confirmLink',
                        handle: s.handle,
                        challengeId: challenge.challengeId,
                        evidence: link.evidence!,
                      });
                      if (value?.kind === 'link' && value.linked) {
                        setChallenge(undefined);
                        setLink(value);
                        setSession({...s, linked: true});
                        await begin(s);
                      }
                    })
                  }
                >
                  确认是我的私聊
                </GlowButton>
              ) : (
                <GlowButton
                  variant="dark"
                  disabled={busy || expired}
                  onClick={() =>
                    void act(async (s) => {
                      const value = await request(s, {
                        type: 'inspectLink',
                        handle: s.handle,
                        challengeId: challenge.challengeId,
                      });
                      if (value?.kind === 'link') {
                        setLink(value);
                        if (!value.recipient) setNotice('尚未收到关联命令，请检查是否发给了这个 Bot。');
                      }
                    })
                  }
                >
                  我已发送，核对收件人
                </GlowButton>
              )}
            </>
          ) : retry.current && session ? (
            <>
              <Button
                disabled={busy || operation?.state === 'cancelPending' || Boolean(handoff?.operationId && !operation)}
                onClick={() =>
                  void act(async (s) => {
                    if (operation) {
                      const reply = await request(s, {type: 'cancel', handle: s.handle, operationId: operation.operationId});
                      if (reply?.kind === 'operation')
                        setSession(
                          (old) =>
                            old && {
                              ...old,
                              operations: [
                                ...old.operations.filter((o) => o.operationId !== reply.operation.operationId),
                                reply.operation,
                              ],
                            }
                        );
                    } else
                      adopt(
                        await request(s, {type: 'cancelHandoff', handle: s.handle, retryId: retry.current!}),
                        retry.current!
                      );
                  })
                }
              >
                取消准备
              </Button>
              {openChat}
            </>
          ) : (
            !challenge && <Button onClick={onBack}>返回</Button>
          )}
        </>
      }
    >
      {status && (
        <p role="status">
          <strong>{status}</strong>
        </p>
      )}
      {draftId && session?.sourceGroup && (
        <p>
          {session.target.botName} · {session.sourceGroup.groupName}
        </p>
      )}
      {handoff && !draftId && 'source' in target && (
        <p>
          {botName} · {target.groupName}
        </p>
      )}
      {!status && !challenge && !error && <p role="status">正在核验来源与本人私聊…</p>}
      {challenge && (
        <>
          <p>用管理员身份在「{botName}」的本人私聊发送这条命令。</p>
          <label className="authoring-command">
            私聊关联命令
            <input aria-label="私聊关联命令" readOnly value={'/recipe link ' + challenge.code} />
          </label>
          <div className="community-actions">
            <CopyButton value={'/recipe link ' + challenge.code} label="复制关联命令" />
            <Button disabled={busy} onClick={() => void act(newLink)}>
              {link?.recipient ? '这不是我，重新关联' : '重新获取短码'}
            </Button>
          </div>
          {expired && <p role="status">关联短码已到期，请重新获取。</p>}
          {link?.recipient && (
            <>
              <p>核对这是你的飞书身份，再确认关联。</p>
              <dl className="recipe-source-fixed">
                <dt>用户</dt>
                <dd>{link.recipient.openId}</dd>
                <dt>租户</dt>
                <dd>{link.recipient.tenantKey}</dd>
                <dt>私聊</dt>
                <dd>{link.recipient.chatId}</dd>
              </dl>
            </>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {operation?.syncMessage && <p>{operation.syncMessage}</p>}
      {operation?.contextPaused && (
        <Button
          disabled={busy}
          onClick={() =>
            void act(async (s) => {
              await request(s, {type: 'resume', handle: s.handle, operationId: operation.operationId});
              await progressFor(s, retry.current!);
            })
          }
        >
          重新核验并继续
        </Button>
      )}
      {(error || handoff?.state === 'deliveryUnknown') && !done && (
        <Button
          disabled={busy}
          onClick={() => reconnect((n) => n + 1)}
        >
          重试本次准备
        </Button>
      )}
    </SourceDialog>
  );
}
