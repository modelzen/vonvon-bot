import {useEffect, useRef, useState} from 'react';
import type {
  AgentId,
  DesktopSnapshot,
  RecipeAuthoringShell,
  DesktopAuthoringRequest,
  DesktopAuthoringReply,
  DesktopAuthoringOperation,
} from '@vonvon/protocol';
import {useAccount} from '../../account-context';
import {useActiveDevice, useClient, useShellCapabilities} from '../../client-context';
import {Button, InlineNotice} from '../../reference/components/ui';
import {GlowButton} from '../../GlowButton';
import {CopyButton, RecipeMarkdown, RecipeMetadata} from '../RecipeContent';
import {botChatUrl, groupUrl, openExternalUrl} from '../../url-actions';
type Session = Extract<DesktopAuthoringReply, {kind: 'session'}>;
type Challenge = Extract<DesktopAuthoringReply, {kind: 'challenge'}>;
type Link = Extract<DesktopAuthoringReply, {kind: 'link'}>;
type Candidate = Extract<DesktopAuthoringReply, {kind: 'candidate'}>;
type Props = {draft: {draftId: string; revision: number}; onSaved: (id: string, revision: number) => void};
export function LegacyDraftChat(props: Props) {
  const account = useAccount(),
    device = useActiveDevice(),
    client = useClient(),
    shell = useShellCapabilities()?.recipeAuthoring;
  const [read, setRead] = useState<{client: typeof client; viewId: string; snapshot: DesktopSnapshot}>();
  const snapshot = read?.client === client && read.viewId === device.id ? read.snapshot : undefined;
  const [id, select] = useState<AgentId>(),
    [confirmed, confirm] = useState(false);
  useEffect(() => {
    let live = true;
    select(undefined);
    confirm(false);
    const stop = client.watchSnapshots((snapshot) => {
      if (live) setRead({client, viewId: device.id, snapshot});
    });
    return () => {
      live = false;
      stop();
    };
  }, [client, device.id]);
  const bot = snapshot?.agents.find((b) => b.id === id && b.running);
  if (!shell || account.status?.kind !== 'signedIn' || snapshot?.host.kind !== 'connected' || snapshot.stale)
    return <p>当前来源暂不可用。</p>;
  return (
    <section className="recipe-authoring">
      <div className="authoring-source-list">
        {snapshot.agents.map((b) => (
          <button
            type="button"
            key={b.id}
            aria-pressed={b.id === id}
            disabled={!b.running}
            onClick={() => {
              select(b.id);
              confirm(false);
            }}
          >
            {b.name}
          </button>
        ))}
      </div>
      {!confirmed ? (
        <Button disabled={!bot} onClick={() => confirm(true)}>
          确认编辑 Bot
        </Button>
      ) : (
        bot && (
          <LegacyFlow
            key={JSON.stringify([
              account.status.accountId,
              device.id,
              bot.id,
              bot.tenant,
              bot.registrationId,
              bot.registeredAt,
            ])}
            {...props}
            shell={shell}
            accountId={account.status.accountId}
            botId={bot.id}
            botName={bot.name}
            tenant={bot.tenant}
          />
        )
      )}
    </section>
  );
}
function authoringPending(operation: DesktopAuthoringOperation) {
  return !['completed', 'cancelled', 'expired'].includes(operation.state);
}
const authoringStateText: Record<DesktopAuthoringOperation['state'], string> = {
  pendingMain: '正在核验账号与来源',
  sending: '正在发送飞书卡片',
  waiting: '等待本人在飞书操作',
  candidate: '等待本人在飞书确认候选',
  pendingCloud: '飞书已确认，等待保存到账号',
  completed: '私人草稿已保存',
  cancelPending: '正在取消，等待云端确认',
  cancelled: '已取消',
  expired: '请求已到期',
  needsReview: '来源或权限已变化，需要重新核对',
};

function LegacyFlow({
  shell,
  accountId,
  botId,
  botName,
  tenant,
  draft,
  onSaved,
}: Props & {shell: RecipeAuthoringShell; accountId: string; botId: AgentId; botName: string; tenant?: 'feishu' | 'lark'}) {
  const device = useActiveDevice();
  const capabilities = useShellCapabilities();
  const [session, setSession] = useState<Session>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [link, setLink] = useState<Link>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const live = useRef(false);
  const lock = useRef(false);
  const sessionRef = useRef<Session | undefined>(undefined);
  const lifetime = useRef(0);
  const watched = useRef(new Set<string>());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const notified = useRef(new Set<string>());
  function remember(next: Session) {
    sessionRef.current = next;
    setSession(next);
  }
  function operation(next: DesktopAuthoringOperation) {
    const current = sessionRef.current;
    if (current)
      remember({
        ...current,
        operations: current.operations.some((item) => item.operationId === next.operationId)
          ? current.operations.map((item) => (item.operationId === next.operationId ? next : item))
          : [...current.operations, next],
      });
  }
  useEffect(() => {
    if (paused) return;
    live.current = true;
    ++lifetime.current;
    lock.current = false;
    setBusy(false);
    let active = true;
    let handle: string | undefined;
    setError(undefined);
    void shell
      .request({type: 'open', accountId, viewId: device.id, botId})
      .then((reply) => {
        if (reply.kind !== 'session') throw new Error('无法打开草稿操作。');
        handle = reply.handle;
        if (!active) {
          void shell.request({type: 'close', handle}).catch(() => {});
          return;
        }
        for (const item of reply.operations) if (authoringPending(item)) watched.current.add(item.operationId);
        remember(reply);
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
      live.current = false;
      sessionRef.current = undefined;
      if (handle) void shell.request({type: 'detach', handle}).catch(() => {});
    };
  }, [shell, accountId, device.id, botId, retry, paused]);
  async function request(input: DesktopAuthoringRequest) {
    const owner = sessionRef.current;
    const epoch = lifetime.current;
    if (!owner || !('handle' in input) || input.handle !== owner.handle) return;
    const reply = await shell.request(input);
    if (!live.current || epoch !== lifetime.current || sessionRef.current?.handle !== owner.handle) return;
    if (reply.kind === 'session') remember(reply);
    else if (reply.kind === 'operation') {
      if (authoringPending(reply.operation)) watched.current.add(reply.operation.operationId);
      operation(reply.operation);
    }
    return reply;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    const epoch = lifetime.current;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (error) {
      if (live.current && epoch === lifetime.current) setError(message(error));
    } finally {
      if (live.current && epoch === lifetime.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const operations =
    session?.operations.filter(
      (item) =>
        item.draftId === draft.draftId || (item.receipt?.status === 'accepted' && item.receipt.draftId === draft.draftId)
    ) ?? [];
  const pending = operations.some(authoringPending);
  const followChat = pending || Boolean(session?.linked);
  useEffect(() => {
    if (!session || !followChat) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 2000;
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), 30000);
        return;
      }
      try {
        const reply = await shell.request({type: 'status', handle: session.handle});
        if (active && reply.kind === 'session') {
          remember(reply);
          setError(undefined);
        }
      } catch (error) {
        if (active) setError(message(error));
      }
      if (active) {
        delay = Math.min(delay * 2, 30000);
        timer = setTimeout(() => void poll(), delay);
      }
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [shell, session?.handle, followChat]);
  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);
  useEffect(() => {
    for (const item of operations) {
      if (item.state !== 'completed' || item.receipt?.status !== 'accepted') continue;
      if (
        !watched.current.has(item.operationId) &&
        (item.receipt.draftId !== draft.draftId || item.receipt.revision <= draft.revision)
      )
        continue;
      const receiptKey = `${item.receipt.draftId}:${item.receipt.revision}`;
      if (!notified.current.has(receiptKey)) {
        notified.current.add(receiptKey);
        onSavedRef.current(item.receipt.draftId, item.receipt.revision);
      }
    }
  }, [session]);
  const expired = challenge && now >= challenge.expiresAt;
  const handle = session?.handle;
  async function reconnect() {
    if (handle) await shell.request({type: 'close', handle}).catch(() => {});
    if (live.current) {
      setSession(undefined);
      setChallenge(undefined);
      setLink(undefined);
      setCandidate(undefined);
      setRetry((v) => v + 1);
    }
  }
  async function beginLink() {
    if (!handle) return;
    const reply = await request({type: 'beginLink', handle});
    if (reply?.kind === 'challenge') {
      setChallenge(reply);
      setLink(undefined);
      setNow(Date.now());
    }
  }
  async function inspectLink() {
    if (!handle || !challenge) return;
    const reply = await request({type: 'inspectLink', handle, challengeId: challenge.challengeId});
    if (reply?.kind === 'link') {
      setLink(reply);
      if (!reply.recipient) setNotice('尚未收到有效的本人私聊请求。请检查 Bot、短码和当前管理员身份。');
    }
  }
  if (paused)
    return (
      <InlineNotice title="聊天编辑已暂停" actions={<Button onClick={() => setPaused(false)}>重新核验并继续</Button>}>
        私人草稿仍保存在账号中。
      </InlineNotice>
    );
  const currentOperation = operations.find(authoringPending) ?? [...operations].sort((a, b) => b.createdAt - a.createdAt)[0];
  return (
    <div className="authoring-flow">
      {tenant && (
        <div>
          <Button
            onClick={() =>
              void openExternalUrl(botChatUrl(botId, tenant), 'bot-chat', capabilities).catch((error) =>
                setError(message(error))
              )
            }
          >
            打开 Bot 私聊
          </Button>
        </div>
      )}
      {error && (
        <InlineNotice
          title="草稿操作未完成"
          tone="warning"
          actions={
            <Button disabled={busy} onClick={() => void run(reconnect)}>
              重新核验
            </Button>
          }
        >
          {error}
        </InlineNotice>
      )}
      {notice && (
        <p role="status" className="community-muted">
          {notice}
        </p>
      )}
      {!session && !error && <p role="status">正在核验账号、设备与 Bot 管理员身份…</p>}
      {session && !session.linked && (
        <section className="authoring-step">
          <h3>关联本人飞书私聊</h3>
          <p>使用当前 Bot 的管理员身份，在这个 Bot 的私聊发送关联命令，再回到 App 核对。不会按姓名或邮箱选择收件人。</p>
          {!challenge ? (
            <GlowButton variant="dark" disabled={busy} onClick={() => void run(beginLink)}>
              关联我的飞书私聊
            </GlowButton>
          ) : (
            <>
              <label className="authoring-command">
                发送给 {botName}
                <input aria-label="私聊关联命令" readOnly value={`/recipe link ${challenge.code}`} />
              </label>
              <CopyButton key={challenge.challengeId} value={`/recipe link ${challenge.code}`} label="复制关联命令" />
              <p className="community-muted" role="status">
                {expired
                  ? '关联短码已到期，请重新获取。'
                  : `短码将在 ${Math.max(1, Math.ceil((challenge.expiresAt - now) / 60000))} 分钟内到期。仅在所选 Bot 的本人私聊中使用。`}
              </p>
              <div className="community-actions">
                <Button disabled={busy || expired} onClick={() => void run(inspectLink)}>
                  我已发送，核对收件人
                </Button>
                <Button disabled={busy} onClick={() => void run(beginLink)}>
                  重新获取短码
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!handle) return;
                      await request({type: 'close', handle});
                      if (!live.current) return;
                      setSession(undefined);
                      setChallenge(undefined);
                      setLink(undefined);
                      setRetry((value) => value + 1);
                      setNotice('已停止本次关联。旧短码不能再用于当前流程。');
                    })
                  }
                >
                  取消关联
                </Button>
              </div>
              {link?.recipient && (
                <div className="authoring-identity">
                  <h4>核对这是你的飞书身份</h4>
                  <p>以下信息来自所选 Bot 实际收到的私聊。只有你确认后才建立关联。</p>
                  <dl>
                    <dt>用户 Open ID</dt>
                    <dd>{link.recipient.openId}</dd>
                    <dt>租户</dt>
                    <dd>{link.recipient.tenantKey || '未提供'}</dd>
                    <dt>私聊 ID</dt>
                    <dd>{link.recipient.chatId}</dd>
                  </dl>
                  <div className="community-actions">
                    <GlowButton
                      variant="dark"
                      disabled={busy || expired || !link.evidence}
                      onClick={() =>
                        void run(async () => {
                          if (!handle || !challenge || !link.evidence) return;
                          const reply = await request({
                            type: 'confirmLink',
                            handle,
                            challengeId: challenge.challengeId,
                            evidence: link.evidence,
                          });
                          if (reply?.kind === 'link' && reply.linked) {
                            remember({...session, linked: true});
                            setChallenge(undefined);
                            setLink(reply);
                          }
                        })
                      }
                    >
                      确认是我的私聊
                    </GlowButton>
                    <Button disabled={busy} onClick={() => void run(beginLink)}>
                      这不是我，重新关联
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {session?.linked && (
        <GlowButton
          variant="dark"
          disabled={busy || pending}
          onClick={() =>
            void run(async () => {
              if (handle) await request({type: 'edit', handle, draftId: draft.draftId, baseRevision: draft.revision});
            })
          }
        >
          发送继续编辑卡片
        </GlowButton>
      )}
      {currentOperation && (
        <section className="authoring-step">
          <h3>此草稿的聊天编辑</h3>
          <p role="status">
            {currentOperation.contextPaused ? '聊天编辑已暂停，原请求仍保留' : authoringStateText[currentOperation.state]}
          </p>
          {currentOperation.syncMessage && <p>{currentOperation.syncMessage}</p>}
          {currentOperation.deliveryUnknown && <p>原卡片可能已送达，请先检查本人私聊。</p>}
          {authoringPending(currentOperation) && handle && (
            <div className="community-actions">
              {link?.recipient && (
                <Button
                  onClick={() =>
                    void openExternalUrl(groupUrl(link.recipient!.chatId), 'group', capabilities).catch((e) =>
                      setError(message(e))
                    )
                  }
                >
                  打开本人私聊
                </Button>
              )}
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request({type: 'resume', handle, operationId: currentOperation.operationId});
                  })
                }
              >
                重新核验并继续
              </Button>
              {['sending', 'waiting', 'candidate'].includes(currentOperation.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request({type: 'resend', handle, operationId: currentOperation.operationId});
                      setCandidate(undefined);
                    })
                  }
                >
                  明确重新发卡
                </Button>
              )}
              {['candidate', 'pendingCloud'].includes(currentOperation.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const reply = await request({
                        type: 'inspectCandidate',
                        handle,
                        operationId: currentOperation.operationId,
                      });
                      if (reply?.kind === 'candidate') setCandidate(reply);
                    })
                  }
                >
                  在 App 核对候选
                </Button>
              )}
              <Button
                disabled={busy || currentOperation.state === 'cancelPending'}
                onClick={() =>
                  void run(async () => {
                    await request({type: 'cancel', handle, operationId: currentOperation.operationId});
                  })
                }
              >
                取消此请求
              </Button>
            </div>
          )}
        </section>
      )}
      {candidate &&
        operations.some(
          (item) =>
            item.operationId === candidate.operation.operationId &&
            item.payloadDigest === candidate.payloadDigest &&
            ['candidate', 'pendingCloud'].includes(item.state)
        ) && (
          <section className="authoring-step">
            <h3>待确认的确切候选</h3>
            <p>核对后请在本人飞书私聊确认。App 不会替你跳过该确认。</p>
            {'changes' in candidate.content ? (
              <>
                <p className="community-muted">
                  草稿 {candidate.content.draftId} · 基于修订 {candidate.content.baseRevision}
                </p>
                {candidate.content.changes.map((change, index) => (
                  <div key={index}>
                    <h4>
                      {change.op === 'setPublicText'
                        ? {name: '名称', summary: '公开简介', overview: '公开概览', version: '版本'}[change.field]
                        : change.op === 'setDraftRole'
                          ? '角色与规则'
                          : '补充说明'}
                    </h4>
                    {change.op === 'setSetup' ? (
                      change.value ? (
                        <>
                          {change.value.steps.map((step, index) => (
                            <div key={index}>
                              <h4>{step.title}</h4>
                              <p>{step.required ? '必需' : '可选'}</p>
                              <RecipeMarkdown text={step.instructions} />
                              {step.check && <p>{step.check}</p>}
                            </div>
                          ))}
                        </>
                      ) : (
                        <p>移除旧补充说明</p>
                      )
                    ) : (
                      <pre className="authoring-preview">{change.value || '清空此字段'}</pre>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <>
                <h4>公开介绍</h4>
                <p>{candidate.content.public.name || '未填写名称'}</p>
                <p>{candidate.content.public.summary || '未填写简介'}</p>
                <RecipeMetadata meta={candidate.content.public} />
                <RecipeMarkdown text={candidate.content.public.overview} />
                <h4>角色与规则</h4>
                <pre className="authoring-preview">{candidate.content.config.role}</pre>
                {candidate.content.config.setup?.steps.map((step, index) => (
                  <div key={index}>
                    <h4>{step.title}</h4>
                    <p>{step.required ? '必需' : '可选'}</p>
                    <RecipeMarkdown text={step.instructions} />
                    {step.check && <p>{step.check}</p>}
                  </div>
                ))}
              </>
            )}
          </section>
        )}
      {handle && (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await request({type: 'close', handle});
              if (live.current) {
                setSession(undefined);
                setChallenge(undefined);
                setLink(undefined);
                setCandidate(undefined);
                setPaused(true);
              }
            })
          }
        >
          暂停聊天编辑
        </Button>
      )}
      <p className="community-muted">
        离开此页后仍可在本人私聊继续。切换设备、退出账号或 App、30 分钟未操作都会暂停聊天编辑。
      </p>
    </div>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请检查来源设备、账号与 Bot 管理员权限后重试。';
}
