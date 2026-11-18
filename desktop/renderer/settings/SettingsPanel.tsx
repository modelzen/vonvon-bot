import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, InlineNotice, Toggle } from "../reference/components/ui";
import {
  SettingsGroup,
  SettingsRow,
} from "../reference/components/system-settings";
import {
  groupIdSchema,
  type AgentId,
  type Membership,
} from "../../shared/bridge";
import {
  openIdSchema,
  type AgentSettingsView,
  type HostSettingsView,
  type ModelCatalog,
  type ModelSelection,
  type ProjectSettingsView,
  type SessionSettingsView,
  type SettingsReply,
  type SettingsScope,
  type SettingsView,
  type TitlePolicy,
} from "../../shared/settings";
import "./settings.css";
import {useDraft, useDraftGuard} from './DraftGuard';
import {settingAnchor} from '../search';
import type {MembershipCategory, SearchReveal} from '../search';

type AgentScope = { kind: "agent"; botId: AgentId };
type ProjectScope = { kind: "project"; botId: AgentId; projectName: string };
type PanelProps =
  | {scope: 'agent'; target: AgentScope; reveal?: SearchReveal}
  | {scope: 'project'; target: ProjectScope; category: MembershipCategory}
  | {scope: 'host'; target: {kind: 'host'}; category: 'coffee' | 'execution'; reveal?: SearchReveal};
const isAgentView = (view: SettingsView): view is AgentSettingsView =>
  view.scope.kind === "agent" && "cliRuntime" in view;
const isProjectView = (view: SettingsView): view is ProjectSettingsView =>
  view.scope.kind === "project" && "members" in view;
const isSessionView = (view: SettingsView): view is SessionSettingsView =>
  view.scope.kind === "session" && "identity" in view && !("members" in view);
const isHostView = (view: SettingsView): view is HostSettingsView =>
  view.scope.kind === "host" && "runtime" in view;
type Section<T> = {
  stored: T;
  effective: T;
  revision: string;
  access:
    | { kind: "writable" }
    | { kind: "readonly"; reason: string; message: string };
  apply: { detail: string }[];
};
const effortOptions = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const effectText = (section: Section<unknown>) =>
  section.apply.map((item) => item.detail).join(" ");
const errorText = (reply: SettingsReply): string | undefined => {
  if (reply.kind === "refused") return reply.message;
  if (reply.kind === "saved") {
    if (reply.result.kind === "rejected")
      return reply.result.fields
        .map((item) => `${item.field}：${item.message}`)
        .join("；");
    if (reply.result.kind === "unavailable")
      return reply.result.reason.kind === "readonly"
        ? reply.result.reason.message
        : "当前不可编辑。";
    if (reply.result.kind === "conflict")
      return "这项设置已在别处更改。草稿已保留，请重新读取后确认。";
  }
  if (reply.kind === "acted") {
    if (reply.result.kind === "rejected")
      return reply.result.fields
        .map((item) => `${item.field}：${item.message}`)
        .join("；");
    if (reply.result.kind === "unavailable")
      return reply.result.reason.kind === "readonly"
        ? reply.result.reason.message
        : "当前不可编辑。";
    if (reply.result.kind === "conflict")
      return "这项设置已在别处更改。请重新读取后确认。";
    if (reply.result.kind === "diverged") return reply.result.message;
  }
};
function Editor<T extends object>({
  title,
  section,
  render,
  save,
}: {
  title: string;
  section: Section<T>;
  render: (
    draft: T,
    change: (value: T) => void,
    disabled: boolean,
    commit: (patch: Partial<T>) => Promise<void>,
  ) => ReactNode;
  save: (patch: Partial<T>, revision: string) => Promise<SettingsReply>;
}) {
  const [confirmed, setConfirmed] = useState(section);
  const [draft, setDraft] = useState<Partial<T>>({});
  const [immediate, setImmediate] = useState<
    | { kind: 'idle' }
    | { kind: 'pending'; patch: Partial<T> }
    | { kind: 'failed'; patch: Partial<T>; message: string }
  >({kind: 'idle'});
  const [pendingManual, setPendingManual] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictCurrent, setConflictCurrent] = useState<Section<T>>();
  const priorRevision = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (section.revision === confirmed.revision || section.revision === priorRevision.current) return;
    if (pendingManual || immediate.kind === 'pending') return;
    if (Object.keys(draft).length || immediate.kind === 'failed') {
      setConflictCurrent(section);
      setConflict(true);
    }
    else { setConfirmed(section); setConflict(false); }
  }, [section, confirmed.revision, draft, immediate.kind, pendingManual]);
  const dirty = Object.keys(draft).length > 0;
  const guarded = dirty || immediate.kind !== 'idle' || pendingManual;
  const disabled = pendingManual || immediate.kind !== 'idle' || section.access.kind === "readonly" || conflict;
  const value = { ...confirmed.stored, ...draft, ...(immediate.kind === 'idle' ? {} : immediate.patch) };
  function edit(next: T) {
    const changed: Partial<T> = {};
    for (const key of Object.keys(next) as (keyof T)[]) {
      if (JSON.stringify(next[key]) !== JSON.stringify(value[key])) changed[key] = next[key];
    }
    setDraft(current => {
      const updated = { ...current, ...changed };
      for (const key of Object.keys(updated) as (keyof T)[]) {
        if (JSON.stringify(updated[key]) === JSON.stringify(confirmed.stored[key])) delete updated[key];
      }
      return updated;
    });
    setError(undefined);
    setNotice(undefined);
  }
  function accept(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'saved') return false;
    const canonical = reply.result.section.value;
    priorRevision.current = confirmed.revision;
    setConfirmed({ ...confirmed, stored: canonical.stored as T, effective: canonical.effective as T, revision: canonical.revision, apply: canonical.apply });
    setNotice(reply.result.effects.map(item => item.detail).join(' ') || '已保存。');
    return true;
  }
  function noteConflict(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'conflict') return;
    const current = reply.result.current.value;
    setConflictCurrent({ ...confirmed, stored: current.stored as T, effective: current.effective as T, revision: current.revision, apply: current.apply });
    setConflict(true);
  }
  async function commit(patch: Partial<T>): Promise<void> {
    if (disabled || !Object.keys(patch).length) return;
    setImmediate({kind: 'pending', patch});
    setError(undefined); setNotice(undefined);
    try {
      const reply = await save(patch, confirmed.revision);
      if (accept(reply)) setImmediate({kind: 'idle'});
      else {
        noteConflict(reply);
        setImmediate({kind: 'failed', patch, message: errorText(reply) ?? '未收到保存确认，请重试。'});
      }
    } catch (error) {
      setImmediate({kind: 'failed', patch, message: error instanceof Error ? error.message : '保存失败。'});
    }
  }
  async function retry(): Promise<string | undefined> {
    if (immediate.kind !== 'failed' || conflict || section.access.kind === 'readonly') return undefined;
    const patch = immediate.patch;
    setImmediate({kind: 'pending', patch});
    try {
      const reply = await save(patch, confirmed.revision);
      if (accept(reply) && reply.kind === 'saved' && reply.result.kind === 'saved') {
        setImmediate({kind: 'idle'});
        return reply.result.section.value.revision;
      }
      noteConflict(reply);
      setImmediate({kind: 'failed', patch, message: errorText(reply) ?? '未收到保存确认，请重试。'});
      return undefined;
    } catch (error) {
      setImmediate({kind: 'failed', patch, message: error instanceof Error ? error.message : '保存失败。'});
      return undefined;
    }
  }
  async function submit(): Promise<boolean> {
    let revision = confirmed.revision;
    if (immediate.kind === 'failed') {
      const savedRevision = await retry();
      if (!savedRevision) return false;
      if (!dirty) return true;
      revision = savedRevision;
    } else if (disabled || !dirty) return false;
    const patch = draft;
    setPendingManual(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await save(patch, revision);
      noteConflict(result);
      const failure = errorText(result);
      if (failure) { setError(failure); return false; }
      if (accept(result)) {
        setDraft({});
        return true;
      }
      setError('未收到保存确认，请重新读取后重试。');
      return false;
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败。");
      return false;
    } finally {
      setPendingManual(false);
    }
  }
  function discard() {
    setDraft({});
    setImmediate({kind: 'idle'});
    const latest = conflictCurrent ?? section;
    priorRevision.current = confirmed.revision;
    setConfirmed(latest);
    setConflictCurrent(undefined);
    setConflict(false);
    setError(undefined);
  }
  useDraft(guarded, {title, save: submit, discard});
  return (
    <SettingsGroup
      id={settingAnchor(title)}
      label={title}
      footer={
        section.access.kind === "readonly"
          ? section.access.message
          : effectText(section)
      }
    >
      {render(value, edit, disabled, commit)}
      {dirty && <div className="settings-edit-actions">
        <Button
          size="sm"
          disabled={!dirty || disabled}
          onClick={discard}
        >
          放弃修改
        </Button>
        <Button
          size="sm"
          disabled={!dirty || disabled}
          onClick={() => void submit()}
        >
          保存
        </Button>
      </div>}
      {immediate.kind === 'pending' && <InlineNotice title="正在保存">这项设置正在保存。</InlineNotice>}
      {immediate.kind === 'failed' && <InlineNotice title="保存未完成" tone="danger">
        {immediate.message}
        <div className="settings-edit-actions">
          <Button size="sm" disabled={conflict} onClick={() => void retry()}>重试</Button>
          <Button size="sm" onClick={() => setImmediate({kind: 'idle'})}>放弃这项修改</Button>
        </div>
      </InlineNotice>}
      {conflict && <InlineNotice title="设置已在别处更改" tone="danger">
        当前草稿已保留。重新读取后可基于最新设置修改。
        <Button size="sm" onClick={discard}>重新读取并放弃草稿</Button>
      </InlineNotice>}
      {error && (
        <InlineNotice title="保存未完成" tone="danger">
          {error}
        </InlineNotice>
      )}
      {notice && <InlineNotice title="本次修改已保存">{notice}{dirty ? ' 其他修改尚未保存。' : ''}</InlineNotice>}
    </SettingsGroup>
  );
}
function Text({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  return (
    <input
      aria-label={label}
      className="settings-field"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
function NumberField({
  label,
  value,
  onChange,
  disabled,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
  min: number;
  max: number;
}) {
  return (
    <input
      aria-label={label}
      className="settings-number"
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => onChange(event.target.valueAsNumber)}
    />
  );
}
function Select<T extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const choice = choices.find(
          (item) => item.value === event.target.value,
        );
        if (choice) onChange(choice.value);
      }}
    >
      {choices.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}
function Switch({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <Toggle
      className="settings-row-switch"
      aria-label={label}
      label={label}
      checked={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
function Catalog({
  botId,
  backend,
  purpose,
  children,
}: {
  botId: AgentId;
  backend: string;
  purpose: "project" | "session" | "comments" | "titles";
  children: (catalog: ModelCatalog | undefined) => ReactNode;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setCatalog(undefined);
    setError(undefined);
    void window.bridge
      .settings({ type: "models", query: { botId, backend, purpose } })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "models") setCatalog(reply.catalog);
        else
          setError(
            reply.kind === "refused" ? reply.message : "模型目录暂不可用。",
          );
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : "模型目录暂不可用。",
          );
      });
    return () => {
      active = false;
    };
  }, [botId, backend, purpose]);
  return (
    <>
      {error && (
        <InlineNotice title="模型目录暂不可用" tone="warning">
          {error}
        </InlineNotice>
      )}
      {children(catalog)}
    </>
  );
}
function ModelChoice({
  value,
  onChange,
  catalog,
  disabled,
  custom,
}: {
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  catalog: ModelCatalog | undefined;
  disabled: boolean;
  custom?: boolean;
}) {
  const model = value.kind === "explicit" ? value.model : "";
  const listed = catalog?.models.filter((item) => !item.hidden) ?? [];
  const selected = listed.find((item) => item.id === model);
  const efforts =
    selected?.supportedEfforts ??
    (value.kind === "explicit" ? [value.effort] : []);
  return (
    <>
      <SettingsRow
        title="模型"
        description={
          catalog?.state === "unavailable"
            ? (catalog.error ?? "模型目录暂不可用；其他设置仍可保存。")
            : catalog?.state === "fallback"
              ? "当前为后端提供的回退目录，请确认选中的模型可用。"
              : undefined
        }
        trailing={
          custom ? (
            <Text
              label="自定义模型 ID"
              value={model}
              disabled={disabled}
              onChange={(next) =>
                onChange(
                  next
                    ? {
                        kind: "explicit",
                        model: next,
                        effort:
                          value.kind === "explicit" ? value.effort : "medium",
                      }
                    : { kind: "default" },
                )
              }
            />
          ) : (
            <select
              aria-label="模型"
              value={model}
              disabled={
                disabled ||
                (catalog?.state === "unavailable" && value.kind === "default")
              }
              onChange={(event) => {
                const next = listed.find(
                  (item) => item.id === event.target.value,
                );
                onChange(
                  next
                    ? {
                        kind: "explicit",
                        model: next.id,
                        effort: next.defaultEffort,
                      }
                    : { kind: "default" },
                );
              }}
            >
              <option value="">使用默认模型</option>
              {model && !selected && (
                <option value={model}>{model}（已保存，当前目录不可用）</option>
              )}
              {listed.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} · {item.id}
                </option>
              ))}
            </select>
          )
        }
      />
      {value.kind === "explicit" && (
        <SettingsRow
          title="推理强度"
          trailing={
            <select
              aria-label="推理强度"
              value={value.effort}
              disabled={disabled}
              onChange={(event) => {
                const next = effortOptions.find(
                  (item) => item === event.target.value,
                );
                if (next) onChange({ ...value, effort: next });
              }}
            >
              {efforts.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          }
        />
      )}
    </>
  );
}
function ActionNotice({ message }: { message: string | undefined }) {
  return message ? (
    <InlineNotice title="操作结果">{message}</InlineNotice>
  ) : null;
}
function AgentPanel({
  view,
  refresh,
  mode,
  reveal,
  coffeeControls,
  onCoffeeEnabled,
  coffeeEnabled,
  coffeeBusy,
}: {
  view: AgentSettingsView;
  refresh: () => Promise<void>;
  mode: 'settings' | 'cli';
  coffeeControls?: ReactNode;
  coffeeEnabled?: boolean;
  coffeeBusy?: boolean;
  onCoffeeEnabled?: (enabled: boolean) => Promise<void>;
  reveal?: SearchReveal;
}) {
  const [actionMessage, setActionMessage] = useState<string>();
  const [adminId, setAdminId] = useState("");
  const [chatId, setChatId] = useState("");
  const [instructions, setInstructions] = useState(
    view.commentInstructions.content.text,
  );
  const [instructionBase, setInstructionBase] = useState(
    view.commentInstructions.content.text,
  );
  useEffect(() => {
    const saved = view.commentInstructions.content.text;
    if (saved === instructionBase) return;
    setInstructions((current) =>
      current === instructionBase ? saved : current,
    );
    setInstructionBase(saved);
  }, [
    view.commentInstructions.revision,
    view.commentInstructions.content.text,
    instructionBase,
  ]);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {if (reveal === 'cli-advanced') setAdvanced(true);}, [reveal]);
  const [titleBackend, setTitleBackend] = useState("codex-appserver");
  const [commentBackend, setCommentBackend] = useState(
    view.sections.comments.stored.backend,
  );
  async function save(
    section: keyof AgentSettingsView["sections"],
    patch: object,
    revision: string,
  ) {
    const result = await window.bridge.settings({
      type: "save",
      edit: { scope: view.scope, section, revision, patch },
    });
    if (result.kind === "saved" && result.result.kind === "saved")
      await refresh();
    return result;
  }
  async function act(
    action: Parameters<typeof window.bridge.settings>[0] & { type: "act" },
  ) {
    const result = await window.bridge.settings(action);
    const failure = errorText(result);
    setActionMessage(
      failure ??
        (result.kind === "acted" && result.result.kind === "saved"
          ? [
              ...result.result.effects.map((item) => item.detail),
              ...result.result.warnings,
            ].join(" ") || "已保存。"
          : "操作已完成。"),
    );
    if (result.kind === "acted" && result.result.kind === "saved") {
      if (
        isAgentView(result.result.view) &&
        result.result.view.commentInstructions.revision !==
          view.commentInstructions.revision
      )
        setInstructions(result.result.view.commentInstructions.content.text);
      await refresh();
    }
    return result.kind === 'acted' && result.result.kind === 'saved';
  }
  async function saveInstructions() {
    if (view.sections.cards.access.kind === 'readonly' || !instructions.trim()) return false;
    const saved = await act({type: 'act', action: {
      kind: 'commentInstructions', botId: view.scope.botId,
      revision: view.commentInstructions.revision,
      content: {kind: 'custom', text: instructions},
    }});
    if (saved) setInstructionBase(instructions);
    return saved;
  }
  async function addAdministrator() {
    const parsed = openIdSchema.safeParse(adminId.trim());
    if (!parsed.success) return false;
    const saved = await act({type: 'act', action: {kind: 'adminMember', botId: view.scope.botId, openId: parsed.data, membership: 'present', revision: view.administrators.revision}});
    if (saved) setAdminId('');
    return saved;
  }
  useDraft(Boolean(adminId), {title: '添加管理员', save: addAdministrator, discard: () => setAdminId('')});
  useDraft(Boolean(chatId), {title: '添加群 ID', save: async () => {setActionMessage('请先将群 ID 添加到列表，再保存。'); return false;}, discard: () => setChatId('')});
  useDraft(instructions !== instructionBase, {
    title: '评论回复规则', save: saveInstructions,
    discard: () => setInstructions(view.commentInstructions.content.text),
  });
  const cards = view.sections.cards,
    run = view.sections.run,
    completion = view.sections.completion,
    voice = view.voice,
    cli = view.sections.cliBridge,
    comments = view.sections.comments,
    titles = view.sections.titles,
    paths = view.sections.paths,
    access = view.sections.access;
  return (
    <>
      {mode === "settings" && <>
      <section className="agent-card-section" aria-labelledby="agent-card-heading">
        <h3 id="agent-card-heading">飞书任务卡片</h3>
        <div className="agent-card-cluster agent-card-display">
          <h4>卡片显示</h4>
      <Editor
        title="任务卡片"
        section={cards}
        save={(draft, revision) => save("cards", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <>
            <SettingsRow
              title="显示工具调用"
              trailing={
                <Switch
                  label="显示工具调用"
                  value={draft.showToolCalls}
                  disabled={disabled}
                  onChange={(value) => void commit({ showToolCalls: value })}
                />
              }
            />
            <SettingsRow
              title="显示模型"
              trailing={
                <Select
                  label="显示模型"
                  value={draft.showModel}
                  disabled={disabled}
                  choices={[
                    { value: "off", label: "不显示" },
                    { value: "running", label: "运行时" },
                    { value: "always", label: "始终" },
                  ]}
                  onChange={(value) => void commit({ showModel: value })}
                />
              }
            />
          </>
        )}
      />
        </div>
        <div className="agent-card-cluster">
          <h4>任务行为与提醒</h4>
      <Editor
        title="运行策略"
        section={run}
        save={(draft, revision) => save("run", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <>
            <SettingsRow
              title="最大并发任务"
              trailing={
                <NumberField
                  label="最大并发任务"
                  value={draft.maxConcurrentRuns}
                  min={1}
                  max={50}
                  disabled={disabled}
                  onChange={(value) =>
                    set({ ...draft, maxConcurrentRuns: value })
                  }
                />
              }
            />
            {run.effective.maxConcurrentRuns !==
              run.stored.maxConcurrentRuns && (
              <SettingsRow
                title="当前运行并发"
                description="已保存的上限等待 Host 重启。"
                value={String(run.effective.maxConcurrentRuns)}
              />
            )}
            <SettingsRow
              title="空闲超时（秒，0 为关闭）"
              trailing={
                <NumberField
                  label="空闲超时"
                  value={draft.runIdleTimeoutSeconds}
                  min={0}
                  max={3600}
                  disabled={disabled}
                  onChange={(value) =>
                    set({ ...draft, runIdleTimeoutSeconds: value })
                  }
                />
              }
            />
            <SettingsRow
              title="运行中收到新消息"
              description="选择新消息加入当前任务，或等当前任务结束后处理。"
              trailing={
                <Select
                  label="待处理消息策略"
                  value={draft.pendingPolicy}
                  disabled={disabled}
                  choices={[
                    { value: "steer", label: "引导当前任务" },
                    { value: "queue", label: "排队" },
                  ]}
                  onChange={(value) => void commit({ pendingPolicy: value })}
                />
              }
            />
          </>
        )}
      />
      <Editor
        title="任务结束提醒"
        section={completion}
        save={(draft, revision) => save("completion", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <>
            <SettingsRow
              title="提醒方式"
              description="控制 Agent 任务结束后何时发送提醒。"
              trailing={
                <Select
                  label="提醒方式"
                  value={draft.mode}
                  disabled={disabled}
                  choices={[
                    { value: "manual", label: "手动" },
                    { value: "long", label: "长任务" },
                    { value: "failures", label: "失败时" },
                    { value: "always", label: "每次" },
                  ]}
                  onChange={(value) => void commit({ mode: value })}
                />
              }
            />
            {draft.mode === "long" && <SettingsRow
              title="长任务阈值（分钟）"
              description="任务运行超过这个时长时发送提醒。"
              trailing={
                <NumberField
                  label="长任务阈值"
                  value={draft.longTaskMinutes}
                  min={1}
                  max={1440}
                  disabled={disabled}
                  onChange={(value) =>
                    set({ ...draft, longTaskMinutes: value })
                  }
                />
              }
            />}
          </>
        )}
      />
        </div>
      </section>
      <SettingsGroup
        label="语音转文字"
        id={settingAnchor("语音转文字")}
        footer={
          cards.access.kind === "readonly"
            ? cards.access.message
            : "开启后检查飞书权限；下一条语音消息使用新状态。"
        }
      >
        <SettingsRow
          title="启用语音"
          description={voice.feishu.message}
          trailing={
            <Switch
              label="启用语音"
              value={voice.enabled}
              disabled={cards.access.kind === "readonly"}
              onChange={(enabled) =>
                void act({
                  type: "act",
                  action: {
                    kind: "voice",
                    botId: view.scope.botId,
                    action: { action: enabled ? "enable" : "disable" },
                  },
                })
              }
            />
          }
        />
        <SettingsRow
          title="权限与测试"
          trailing={
            <div className="settings-inline-actions">
              <Button
                size="sm"
                disabled={cards.access.kind === "readonly"}
                onClick={() =>
                  void act({
                    type: "act",
                    action: {
                      kind: "voice",
                      botId: view.scope.botId,
                      action: { action: "refreshPermission" },
                    },
                  })
                }
              >
                重新检测
              </Button>
              <Button
                size="sm"
                disabled={cards.access.kind === "readonly"}
                onClick={() =>
                  void act({
                    type: "act",
                    action: {
                      kind: "voice",
                      botId: view.scope.botId,
                      action: { action: "test" },
                    },
                  })
                }
              >
                测试
              </Button>
            </div>
          }
        />
      </SettingsGroup>
      </>}
      {mode === "cli" && <>
      <SettingsGroup label="接力设置" id={settingAnchor("接力设置")}
        footer={cards.access.kind === 'readonly' ? cards.access.message : undefined}>
        <SettingsRow
          title="启用咖啡一下"
          description={
            !view.ownerOpenId
              ? "需要先确认 Agent 所有者。"
              : view.cliRuntime.running
                ? "服务运行中"
                : "服务未运行"
          }
          trailing={
            <Switch
              label="启用咖啡一下"
              value={coffeeEnabled ?? view.cliRuntime.enabled}
              disabled={coffeeBusy || cards.access.kind === "readonly" || !view.ownerOpenId}
              onChange={(enabled) =>
                void (onCoffeeEnabled ? onCoffeeEnabled(enabled) : act({
                  type: "act",
                  action: {
                    kind: "setCliBridgeEnabled",
                    botId: view.scope.botId,
                    enabled,
                    revision: view.cliRuntime.revision,
                  },
                }))
              }
            />
          }
        />
      </SettingsGroup>
      {coffeeControls}
      <Editor
        title="通知偏好"
        section={cli}
        save={(draft, revision) => save("cliBridge", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <>
            <SettingsRow
              title="通知范围"
              trailing={
                <Select
                  label="通知范围"
                  value={draft.notifyScope}
                  disabled={disabled}
                  choices={[
                    { value: "all", label: "全部会话" },
                    { value: "bound_projects", label: "已绑定项目" },
                    { value: "none", label: "不通知" },
                  ]}
                  onChange={(value) => void commit({ notifyScope: value })}
                />
              }
            />
            <SettingsRow
              title="转发 Claude"
              trailing={
                <Switch
                  label="转发 Claude"
                  value={draft.agents.claude}
                  disabled={disabled}
                  onChange={(value) =>
                    set({
                      ...draft,
                      agents: { ...draft.agents, claude: value },
                    })
                  }
                />
              }
            />
            <SettingsRow
              title="转发 Codex"
              trailing={
                <Switch
                  label="转发 Codex"
                  value={draft.agents.codex}
                  disabled={disabled}
                  onChange={(value) =>
                    set({ ...draft, agents: { ...draft.agents, codex: value } })
                  }
                />
              }
            />
            <SettingsRow
              title="离开时保活"
              description={
                view.cliRuntime.keepAwakeSupported
                  ? undefined
                  : "此系统不支持保活。"
              }
              trailing={
                <Switch
                  label="离开时保活"
                  value={draft.keepAwake.enabled}
                  disabled={disabled || !view.cliRuntime.keepAwakeSupported}
                  onChange={(value) =>
                    set({ ...draft, keepAwake: { enabled: value } })
                  }
                />
              }
            />
            <button
              className="settings-advanced-toggle"
              type="button"
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? "收起高级选项" : "显示高级选项"}
            </button>
            {advanced && (
              <>
                <SettingsRow
                  title="转发权限审批"
                  trailing={
                    <Switch
                      label="转发权限审批"
                      value={draft.approval.enabled}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          approval: { ...draft.approval, enabled: value },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="审批超时（秒）"
                  trailing={
                    <NumberField
                      label="审批超时"
                      value={draft.approval.timeoutSeconds}
                      min={1}
                      max={86400}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          approval: {
                            ...draft.approval,
                            timeoutSeconds: value,
                          },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="发送任务完成卡"
                  trailing={
                    <Switch
                      label="发送任务完成卡"
                      value={draft.taskCompletion.enabled}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          taskCompletion: {
                            ...draft.taskCompletion,
                            enabled: value,
                          },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="允许从完成卡续聊"
                  trailing={
                    <Switch
                      label="允许从完成卡续聊"
                      value={draft.taskCompletion.replyEnabled}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          taskCompletion: {
                            ...draft.taskCompletion,
                            replyEnabled: value,
                          },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="续聊等待（秒）"
                  trailing={
                    <NumberField
                      label="续聊等待"
                      value={draft.taskCompletion.replyTimeoutSeconds}
                      min={1}
                      max={86400}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          taskCompletion: {
                            ...draft.taskCompletion,
                            replyTimeoutSeconds: value,
                          },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="本会话放行缓存"
                  trailing={
                    <Switch
                      label="本会话放行缓存"
                      value={draft.allowCache.enabled}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          allowCache: { ...draft.allowCache, enabled: value },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="在场检测"
                  trailing={
                    <Switch
                      label="在场检测"
                      value={draft.presence.enabled}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          presence: { ...draft.presence, enabled: value },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="在场检测平台"
                  trailing={
                    <Select
                      label="在场检测平台"
                      value={draft.presence.platform}
                      disabled={disabled}
                      choices={[
                        { value: "auto", label: "自动" },
                        { value: "macos", label: "macOS" },
                      ]}
                      onChange={(value) =>
                        set({
                          ...draft,
                          presence: { ...draft.presence, platform: value },
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="离开判定（秒）"
                  trailing={
                    <NumberField
                      label="离开判定"
                      value={draft.presence.idleThresholdSeconds}
                      min={10}
                      max={3600}
                      disabled={disabled}
                      onChange={(value) =>
                        set({
                          ...draft,
                          presence: {
                            ...draft.presence,
                            idleThresholdSeconds: value,
                          },
                        })
                      }
                    />
                  }
                />
              </>
            )}
          </>
        )}
      />
      </>}
      {mode === "settings" && <>
      <details className="agent-settings-disclosure">
        <summary><span>会话标题<small>生成简短名称</small></span></summary>
      <Catalog botId={view.scope.botId} backend={titleBackend} purpose="titles">
        {(catalog) => (
          <Editor
            title="新会话标题"
            section={titles}
            save={(draft, revision) =>
              save(
                "titles",
                {
                  byBackend: {
                    [titleBackend]: draft.byBackend?.[titleBackend] ?? {
                      enabled: false,
                    },
                  },
                },
                revision,
              )
            }
            render={(draft, set, disabled) => {
              const policy: TitlePolicy = draft.byBackend[titleBackend] ?? {
                enabled: false,
              };
              const setPolicy = (next: TitlePolicy) =>
                set({
                  byBackend: { ...draft.byBackend, [titleBackend]: next },
                });
              return (
                <>
                  <SettingsRow
                    title="执行工具"
                    trailing={
                      <Select
                        label="标题执行工具"
                        value={titleBackend}
                        disabled={disabled}
                        choices={[
                          { value: "codex-appserver", label: "Codex" },
                          { value: "claude-agent", label: "Claude" },
                        ]}
                        onChange={setTitleBackend}
                      />
                    }
                  />
                  <SettingsRow
                    title="用模型生成标题"
                    trailing={
                      <Switch
                        label="用模型生成标题"
                        value={policy.enabled}
                        disabled={disabled}
                        onChange={(enabled) =>
                          setPolicy(
                            enabled
                              ? {
                                  enabled: true,
                                  model: policy.enabled ? policy.model : "",
                                  effort: policy.enabled
                                    ? policy.effort
                                    : "medium",
                                }
                              : { enabled: false },
                          )
                        }
                      />
                    }
                  />
                  {policy.enabled && (
                    <>
                      <SettingsRow
                        title="自定义模型 ID"
                        description="标题允许输入未列入当前模型目录的 ID。"
                        trailing={
                          <Text
                            label="标题模型 ID"
                            value={policy.model}
                            disabled={disabled}
                            onChange={(model) =>
                              setPolicy({ ...policy, model })
                            }
                          />
                        }
                      />
                      <SettingsRow
                        title="推理强度"
                        trailing={
                          <Select
                            label="标题推理强度"
                            value={policy.effort}
                            disabled={disabled}
                            choices={(
                              catalog?.titleEfforts ?? effortOptions
                            ).map((value) => ({ value, label: value }))}
                            onChange={(effort) =>
                              setPolicy({ ...policy, effort })
                            }
                          />
                        }
                      />
                    </>
                  )}
                </>
              );
            }}
          />
        )}
      </Catalog>
      </details>
      <details className="agent-settings-disclosure">
        <summary><span>云文档评论<small>模型与回复规则</small></span></summary>
      <Catalog
        botId={view.scope.botId}
        backend={commentBackend}
        purpose="comments"
      >
        {(catalog) => (
          <Editor
            title="云文档评论"
            section={comments}
            save={(draft, revision) => save("comments", draft, revision)}
            render={(draft, set, disabled) => (
              <>
                <SettingsRow
                  title="执行工具"
                  trailing={
                    <Select
                      label="评论执行工具"
                      value={draft.backend}
                      disabled={disabled}
                      choices={[
                        { value: "codex-appserver", label: "Codex" },
                        { value: "claude-agent", label: "Claude" },
                      ]}
                      onChange={(value) => {
                        setCommentBackend(value);
                        set({
                          ...draft,
                          backend: value,
                          selection: { kind: "default" },
                        });
                      }}
                    />
                  }
                />
                <ModelChoice
                  value={draft.selection}
                  onChange={(selection) => set({ ...draft, selection })}
                  catalog={catalog}
                  disabled={disabled}
                />
              </>
            )}
          />
        )}
      </Catalog>
      <SettingsGroup
        label="评论回复规则"
        id={settingAnchor("评论回复规则")}
        footer={
          cards.access.kind === "readonly"
            ? cards.access.message
            : "最多编辑 30000 字。保存后同步已有评论目录；下条新评论使用新规则。"
        }
      >
        <textarea
          aria-label="评论回复规则"
          className="settings-instructions"
          value={instructions}
          maxLength={30000}
          disabled={cards.access.kind === "readonly"}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <div className="settings-edit-actions">
          <Button
            size="sm"
            disabled={instructions === view.commentInstructions.content.text}
            onClick={() =>
              setInstructions(view.commentInstructions.content.text)
            }
          >
            放弃修改
          </Button>
          <Button
            size="sm"
            disabled={
              cards.access.kind === "readonly" ||
              !instructions.trim() ||
              instructions === view.commentInstructions.content.text
            }
            onClick={() => void saveInstructions()}
          >
            保存规则
          </Button>
          <Button
            size="sm"
            disabled={
              cards.access.kind === "readonly" ||
              view.commentInstructions.content.kind === "default"
            }
            onClick={() =>
              void act({
                type: "act",
                action: {
                  kind: "commentInstructions",
                  botId: view.scope.botId,
                  revision: view.commentInstructions.revision,
                  content: { kind: "default" },
                },
              })
            }
          >
            恢复默认
          </Button>
        </div>
      </SettingsGroup>
      </details>
      <details className="agent-settings-disclosure">
        <summary><span>管理员<small>管理可操作 Agent 的人</small></span></summary>
      <SettingsGroup
        label="管理员"
        id={settingAnchor("管理员")}
        footer={
          cards.access.kind === "readonly"
            ? cards.access.message
            : "注册 Agent 的所有者始终拥有管理员权限，不能在这里移除。"
        }
      >
        <SettingsRow title="所有者" value={view.ownerOpenId ?? "尚未确认"} />
        {view.administrators.openIds.map((id) => (
          <SettingsRow
            key={id}
            title={id}
            trailing={
              <Button
                size="sm"
                disabled={
                  id === view.ownerOpenId || cards.access.kind === "readonly"
                }
                onClick={() =>
                  void act({
                    type: "act",
                    action: {
                      kind: "adminMember",
                      botId: view.scope.botId,
                      openId: id,
                      membership: "absent",
                      revision: view.administrators.revision,
                    },
                  })
                }
              >
                移除
              </Button>
            }
          />
        ))}
        <SettingsRow
          title="添加管理员 Open ID"
          trailing={
            <div className="settings-inline-actions">
              <Text
                label="管理员 Open ID"
                value={adminId}
                disabled={cards.access.kind === "readonly"}
                onChange={setAdminId}
              />
              <Button
                size="sm"
                disabled={!openIdSchema.safeParse(adminId.trim()).success}
                onClick={() =>
                  void addAdministrator()
                }
              >
                添加
              </Button>
            </div>
          }
        />
      </SettingsGroup>
      </details>
      <details className="agent-settings-disclosure">
        <summary><span>更多设置<small>项目目录与允许的飞书群</small></span></summary>
      <Editor
        title="新项目默认目录"
        section={paths}
        save={(draft, revision) => save("paths", draft, revision)}
        render={(draft, set, disabled) => (
          <SettingsRow
            title="根目录"
            description="只用于之后创建的空白项目。"
            trailing={
              <Text
                label="新项目根目录"
                value={draft.projectsRootDir ?? ""}
                disabled={disabled}
                placeholder="使用默认目录"
                onChange={(value) => set({ projectsRootDir: value || null })}
              />
            }
          />
        )}
      />
      <Editor
        title="允许的飞书群"
        section={access}
        save={(draft, revision) => save("access", draft, revision)}
        render={(draft, set, disabled) => (
          <>
            <SettingsRow
              title="群范围"
              description={
                draft.allowedChats.length
                  ? "仅响应列出的群"
                  : "空列表表示所有群"
              }
              value={`${draft.allowedChats.length} 个群`}
            />
            {draft.allowedChats.map((id) => (
              <SettingsRow
                key={id}
                title={id}
                trailing={
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      set({
                        allowedChats: draft.allowedChats.filter(
                          (item) => item !== id,
                        ),
                      })
                    }
                  >
                    移除
                  </Button>
                }
              />
            ))}
            <SettingsRow
              title="添加群 ID"
              trailing={
                <div className="settings-inline-actions">
                  <Text
                    label="添加群 ID"
                    value={chatId}
                    disabled={disabled}
                    onChange={setChatId}
                  />
                  <Button
                    size="sm"
                    disabled={
                      disabled ||
                      !groupIdSchema.safeParse(chatId.trim()).success
                    }
                    onClick={() => {
                      const parsed = groupIdSchema.safeParse(chatId.trim());
                      if (parsed.success) {
                        set({
                          allowedChats: [...draft.allowedChats, parsed.data],
                        });
                        setChatId("");
                      }
                    }}
                  >
                    添加
                  </Button>
                </div>
              }
            />
          </>
        )}
      />
      </details>
      </>}
      <ActionNotice message={actionMessage} />
    </>
  );
}
function ProjectPanel({
  view,
  refresh,
  category,
}: {
  view: ProjectSettingsView;
  refresh: () => Promise<void>;
  category: MembershipCategory;
}) {
  const [memberId, setMemberId] = useState("");
  const [notice, setNotice] = useState<string>();
  async function save(
    section: keyof ProjectSettingsView["sections"],
    patch: object,
    revision: string,
  ) {
    const result = await window.bridge.settings({
      type: "save",
      edit: { scope: view.scope, section, revision, patch },
    });
    if (result.kind === "saved" && result.result.kind === "saved")
      await refresh();
    return result;
  }
  async function memberAction(
    openId: string,
    membership: "present" | "absent",
  ) {
    const result = await window.bridge.settings({
      type: "act",
      action: {
        kind: "projectMember",
        botId: view.scope.botId,
        projectName: view.scope.projectName,
        openId,
        membership,
        revision: view.members.revision,
      },
    });
    setNotice(errorText(result) ?? "成员范围已保存。");
    if (result.kind === "acted" && result.result.kind === "saved") {
      if (membership === 'present' && memberId.trim() === openId) setMemberId('');
      await refresh();
      return true;
    }
    return false;
  }
  useDraft(Boolean(memberId), {title: '添加项目成员', save: async () => {
    const parsed = openIdSchema.safeParse(memberId.trim());
    return parsed.success ? memberAction(parsed.data, 'present') : false;
  }, discard: () => setMemberId('')});
  const permission = view.sections.permission,
    response = view.sections.response,
    compact = view.sections.compact,
    model = view.sections.model;
  return (
    <>
      {category === "behavior" && <>
      <Editor
        title="群内响应"
        section={response}
        save={(draft, revision) => save("response", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <SettingsRow
            title="不 @ 也能发起任务"
            description="按话题独立会话时，已有话题和群内支持的命令免 @。整群连续会话时，群内普通消息也会响应。"
            trailing={
              <Switch
                label="不 @ 也能发起任务"
                value={draft.noMention}
                disabled={disabled}
                onChange={(noMention) => void commit({ noMention })}
              />
            }
          />
        )}
      />
      </>}
      {category === "access" && <>
      <Editor
        title="工作目录权限"
        section={permission}
        save={(draft, revision) => save("permission", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <>
            <SettingsRow
              title="管理员权限"
              trailing={
                <Select
                  label="管理员权限"
                  value={draft.mode}
                  disabled={disabled}
                  choices={[
                    { value: "qa", label: "只读问答" },
                    { value: "write", label: "允许写入" },
                    { value: "full", label: "完全访问" },
                  ]}
                  onChange={(mode) => void commit({ mode })}
                />
              }
            />
            <SettingsRow
              title="普通成员权限"
              trailing={
                <Select
                  label="普通成员权限"
                  value={draft.guestMode}
                  disabled={disabled}
                  choices={[
                    { value: "qa", label: "只读问答" },
                    { value: "write", label: "允许写入" },
                    { value: "full", label: "完全访问" },
                  ]}
                  onChange={(guestMode) => void commit({ guestMode })}
                />
              }
            />
            <SettingsRow
              title="允许网络访问"
              trailing={
                <Switch
                  label="允许网络访问"
                  value={draft.network}
                  disabled={disabled}
                  onChange={(network) => void commit({ network })}
                />
              }
            />
          </>
        )}
      />
      </>}
      {category === "behavior" && <>
      <Editor
        title="会话压缩"
        section={compact}
        save={(draft, revision) => save("compact", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <SettingsRow
            title="自动压缩上下文"
            trailing={
              <Switch
                label="自动压缩上下文"
                value={draft.autoCompact}
                disabled={disabled}
                onChange={(autoCompact) => void commit({ autoCompact })}
              />
            }
          />
        )}
      />
      <Catalog
        botId={view.scope.botId}
        backend={view.identity.backend}
        purpose="project"
      >
        {(catalog) => (
          <Editor
            title="新会话默认模型"
            section={model}
            save={(draft, revision) => save("model", draft, revision)}
            render={(draft, set, disabled) => (
              <ModelChoice
                value={draft.selection}
                onChange={(selection) => set({ selection })}
                catalog={catalog}
                disabled={disabled}
              />
            )}
          />
        )}
      </Catalog>
      </>}
      {category === "access" && <>
      <SettingsGroup
        label="响应成员"
        id={settingAnchor("响应成员")}
        footer={
          permission.access.kind === "readonly"
            ? permission.access.message
            : "空列表表示所有群成员；Agent 管理员与所有者始终可以使用。"
        }
      >
        {view.members.openIds.map((id) => (
          <SettingsRow
            key={id}
            title={id}
            trailing={
              <Button
                size="sm"
                disabled={permission.access.kind === "readonly"}
                onClick={() => void memberAction(id, "absent")}
              >
                移除
              </Button>
            }
          />
        ))}
        <SettingsRow
          title="添加成员 Open ID"
          trailing={
            <div className="settings-inline-actions">
              <Text
                label="成员 Open ID"
                value={memberId}
                disabled={permission.access.kind === "readonly"}
                onChange={setMemberId}
              />
              <Button
                size="sm"
                disabled={!openIdSchema.safeParse(memberId.trim()).success}
                onClick={() => void memberAction(memberId.trim(), "present")}
              >
                添加
              </Button>
            </div>
          }
        />
        {view.members.openIds.length > 0 && (
          <SettingsRow
            title="允许所有成员"
            trailing={
              <Button
                size="sm"
                disabled={permission.access.kind === "readonly"}
                onClick={async () => {
                  const reply = await window.bridge.settings({
                    type: "act",
                    action: {
                      kind: "projectAudience",
                      botId: view.scope.botId,
                      projectName: view.scope.projectName,
                      audience: "all",
                      revision: view.members.revision,
                    },
                  });
                  setNotice(errorText(reply) ?? "已允许所有成员。");
                  if (reply.kind === "acted" && reply.result.kind === "saved")
                    await refresh();
                }}
              >
                清空白名单
              </Button>
            }
          />
        )}
      </SettingsGroup>
      </>}
      {category === "behavior" && <SessionPicker view={view} />}
      <ActionNotice message={notice} />
    </>
  );
}
function SessionPicker({ view }: { view: ProjectSettingsView }) {
  const [sessions, setSessions] = useState<
    Extract<SettingsReply, { kind: "sessions" }>["sessions"]
  >([]);
  const [threadId, setThreadId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setError(undefined);
    void window.bridge
      .settings({
        type: "sessions",
        botId: view.scope.botId,
        projectName: view.scope.projectName,
      })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "sessions")
          setSessions(
            reply.sessions.filter(
              (item) => item.chatId === view.identity.chatId,
            ),
          );
        else
          setError(
            reply.kind === "refused" ? reply.message : "话题列表暂不可用。",
          );
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : "话题列表暂不可用。",
          );
      });
    return () => {
      active = false;
    };
  }, [view.scope.botId, view.scope.projectName, view.identity.chatId, view.sections.permission.revision, refresh]);
  const selected = sessions.find((item) => item.threadId === threadId);
  return (
    <SettingsGroup
      label="话题模型"
        id={settingAnchor("话题模型")}
      action={<Button onClick={() => setRefresh((value) => value + 1)}>刷新话题</Button>}
      footer="权限分开时，管理员与普通成员使用独立会话。请选择对应会话；模型从该会话下一轮生效。"
    >
      {error && (
        <InlineNotice title="话题列表暂不可用" tone="warning">
          {error}
        </InlineNotice>
      )}
      <SettingsRow
        title="选择话题"
        trailing={
          <select
            aria-label="选择话题"
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
          >
            <option value="">请选择</option>
            {sessions.map((item) => (
              <option key={item.threadId} value={item.threadId}>
                {item.threadId.endsWith("#admin") ? "管理员" : item.threadId.endsWith("#guest") ? "普通成员" : "共用"} · {item.summary || item.threadId}
              </option>
            ))}
          </select>
        }
      />
      {selected && (
        <SessionPanel
          key={selected.threadId}
          scope={{
            kind: "session",
            botId: view.scope.botId,
            threadId: selected.threadId,
          }}
          expectedChatId={view.identity.chatId}
        />
      )}
    </SettingsGroup>
  );
}
function SessionPanel({
  scope,
  expectedChatId,
}: {
  scope: Extract<SettingsScope, { kind: "session" }>;
  expectedChatId: string;
}) {
  const [view, setView] = useState<SessionSettingsView>();
  const [error, setError] = useState<string>();
  async function refresh() {
    try {
      const reply = await window.bridge.settings({ type: "read", scope });
      if (
        reply.kind === "view" &&
        isSessionView(reply.view) &&
        reply.view.identity.chatId === expectedChatId
      ) {
        setView(reply.view);
        setError(undefined);
      } else
        setError(
          reply.kind === "refused"
            ? reply.message
            : "话题身份已更改，请重新选择。",
        );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "话题设置暂不可用。",
      );
    }
  }
  useEffect(() => {
    let active = true;
    void window.bridge
      .settings({ type: "read", scope })
      .then((reply) => {
        if (!active) return;
        if (
          reply.kind === "view" &&
          isSessionView(reply.view) &&
          reply.view.identity.chatId === expectedChatId
        )
          setView(reply.view);
        else
          setError(
            reply.kind === "refused"
              ? reply.message
              : "话题身份已更改，请重新选择。",
          );
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : "话题设置暂不可用。",
          );
      });
    return () => {
      active = false;
    };
  }, [scope.botId, scope.threadId, expectedChatId]);
  if (error)
    return (
      <InlineNotice title="话题不可编辑" tone="danger">
        {error}
      </InlineNotice>
    );
  if (!view) return <p>正在读取话题设置…</p>;
  const model = view.sections.model;
  return (
    <>
      <SettingsRow
        title="话题身份"
        value={`${view.identity.backend} · ${view.identity.sessionId}`}
      />
      <Catalog
        botId={scope.botId}
        backend={view.identity.backend}
        purpose="session"
      >
        {(catalog) => (
          <Editor
            title="本话题模型"
            section={model}
            save={async (draft, revision) => {
              const reply = await window.bridge.settings({
                type: "save",
                edit: {
                  scope,
                  section: "model",
                  revision,
                  patch: draft,
                },
              });
              if (reply.kind === "saved" && reply.result.kind === "saved")
                await refresh();
              return reply;
            }}
            render={(draft, set, disabled) => (
              <ModelChoice
                value={draft.selection}
                onChange={(selection) => set({ selection })}
                catalog={catalog}
                disabled={disabled}
              />
            )}
          />
        )}
      </Catalog>
    </>
  );
}
function CoffeeHostPanel({view, refresh, reveal}: {view: HostSettingsView; refresh: () => Promise<void>; reveal?: SearchReveal}) {
  const guard = useDraftGuard();
  const coffee = view.runtime.coffee;
  const [recipient, setRecipient] = useState<AgentSettingsView>();
  const [inspectedBotId, setInspectedBotId] = useState<AgentId>();
  const editorBotId = inspectedBotId ?? coffee?.editorBotId ?? coffee?.botId;
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<'route' | 'codex' | 'claude' | null>(null);
  const pending = useRef(false);
  const recipientRequest = useRef(0);
  const refreshRecipient = useCallback(async () => {
    const requestId = ++recipientRequest.current;
    const botId = editorBotId;
    if (!botId) { setRecipient(undefined); return; }
    const reply = await window.bridge.settings({type: 'read', scope: {kind: 'agent', botId}});
    if (requestId !== recipientRequest.current) return;
    if (reply.kind === 'view' && isAgentView(reply.view) && reply.view.scope.botId === botId) {
      setRecipient(reply.view);
      return;
    }
    setNotice(reply.kind === 'refused' ? reply.message : '通知 Agent 的设置暂不可用。');
  }, [editorBotId, coffee?.revision, view]);
  useEffect(() => { void refreshRecipient(); return () => { recipientRequest.current += 1; }; }, [refreshRecipient]);
  async function saveRoute(next: AgentId | '') {
    if (!coffee || pending.current) return false;
    pending.current = true;
    setBusy('route');
    try {
      const reply = await window.bridge.settings({type: 'act', action: {kind: 'setHostCliRoute', botId: next || null, revision: coffee.revision}});
      setNotice(errorText(reply) ?? (reply.kind === 'acted' && reply.result.kind === 'saved'
        ? reply.result.effects.map(effect => effect.detail).join(' ') || '通知目标已保存。'
        : '无法保存通知目标。'));
      if (reply.kind === 'acted' && reply.result.kind === 'saved') { if (next) setInspectedBotId(undefined); await refresh(); return true; }
      return false;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法保存通知目标。');
      return false;
    } finally { pending.current = false; setBusy(null); }
  }
  async function repair(agent: 'claude' | 'codex') {
    if (pending.current) return;
    pending.current = true;
    setBusy(agent);
    try {
      const reply = await window.bridge.settings({type: 'act', action: {kind: 'repairHostCliHooks', agents: [agent]}});
      setNotice(errorText(reply) ?? (reply.kind === 'acted' && reply.result.kind === 'saved'
        ? reply.result.warnings.join(' ') || `${agent === 'codex' ? 'Codex' : 'Claude'} Hook 已检查并修复。`
        : 'Hook 修复未完成。'));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Hook 修复未完成。');
    } finally { pending.current = false; setBusy(null); }
  }
  const statusLabel = {installed: '已安装', not_installed: '未安装', needs_repair: '需要修复', conflict_agent2lark: '与已有 Hook 冲突'};
  if (!coffee) return <InlineNotice title="咖啡一下暂不可用">当前 Bridge 版本尚不支持全局设置，请更新 Bridge 后重新读取。</InlineNotice>;
  const selected = coffee.agents.find(agent => agent.botId === editorBotId);
  const missingTarget = coffee.botId && !coffee.agents.some(agent => agent.botId === coffee.botId);
  const targetIds = [...new Set([...coffee.targets.codex, ...coffee.targets.claude])];
  const split = targetIds.length > 1;
  const controls = <SettingsGroup label="通知设置" id={settingAnchor('咖啡一下')}>
    <SettingsRow title="通知 Agent" description="通过这个 Agent 的飞书私聊接收通知。"
      trailing={<Select label="通知 Agent" value={!coffee.targetsReadable && coffee.route === 'legacy' ? '__unknown__' : split ? '__split__' : selected?.botId ?? coffee.botId ?? ''} choices={[...(!coffee.targetsReadable && coffee.route === 'legacy' ? [{value: '__unknown__' as const, label: '无法读取通知目标'}] : []), ...(missingTarget ? [{value: coffee.botId ?? '' as const, label: '通知 Agent 已不可用'}] : []), ...(split ? [{value: '__split__' as const, label: '按工具分别设置'}] : []), {value: '' as const, label: '停止发送到飞书'}, ...coffee.agents.map(agent => ({value: agent.botId, label: agent.name}))]} onChange={next => {if (next !== '__split__' && next !== '__unknown__') guard.navigate(() => { if (coffee.route === 'none' && next) setInspectedBotId(next); else void saveRoute(next); });}} disabled={busy !== null}/>}/>
    {split && <SettingsRow title="查看通知规则" trailing={<Select label="查看通知规则" disabled={busy !== null} value={selected?.botId ?? ''} choices={coffee.agents.filter(agent => targetIds.includes(agent.botId)).map(agent => ({value: agent.botId, label: agent.name}))} onChange={next => guard.navigate(() => setInspectedBotId(next || undefined))}/>}/>}
    {coffee.route === 'none' && <SettingsRow title="通知状态" value="已关闭" description="可继续修改设置，开启后开始发送通知。"/>}
    {!coffee.targetsReadable && <SettingsRow title="Hook 配置" value="无法读取通知目标" description="请检查配置文件权限后重新读取。"/>}
  </SettingsGroup>;
  return <>
    <p className="settings-description">离开电脑，也能继续协作。在飞书中接收本机 Codex 和 Claude 的审批、问答与任务完成提醒。</p>
    {selected && recipient?.scope.botId === selected.botId
      ? <AgentPanel key={selected.botId} view={recipient} refresh={refreshRecipient} mode="cli" reveal={reveal} coffeeControls={controls} coffeeEnabled={coffee.route !== 'none' && recipient.cliRuntime.enabled} coffeeBusy={busy !== null} onCoffeeEnabled={async enabled => {
        if (pending.current) return;
        if (!enabled) { setInspectedBotId(selected.botId); await saveRoute(''); return; }
        pending.current = true;
        setBusy('route');
        try {
          const reply = await window.bridge.settings({type: 'act', action: {kind: 'setCliBridgeEnabled', botId: selected.botId, enabled, revision: recipient.cliRuntime.revision}});
          const error = errorText(reply);
          if (error || reply.kind !== 'acted' || reply.result.kind !== 'saved') { setNotice(error ?? '咖啡一下设置未保存，请重试。'); return; }
          pending.current = false;
          if (await saveRoute(selected.botId)) await refreshRecipient();
        } catch (error) { setNotice(error instanceof Error ? error.message : '无法更新咖啡一下设置。'); }
        finally { pending.current = false; setBusy(null); }
      }}/>
      : <><SettingsGroup label="咖啡一下"><SettingsRow title="启用咖啡一下" value={coffee.route === 'none' ? '已关闭' : !coffee.targetsReadable ? '无法读取 Hook 配置' : missingTarget ? '通知 Agent 已不可用，请选择其他 Agent' : selected ? '正在读取设置' : '请先添加 Agent'}/></SettingsGroup>{controls}</>}
    <SettingsGroup label="本机 Hook" id={settingAnchor('本机 Hook')} footer="Hook 安装在这台设备上，由所有 Agent 共用。">
      {(['codex', 'claude'] as const).map(agent => <SettingsRow key={agent} title={agent === 'codex' ? 'Codex Hook' : 'Claude Hook'}
        value={statusLabel[coffee.hooks[agent].status]}
        description={split ? `通知 Agent：${coffee.targets[agent].map(id => coffee.agents.find(item => item.botId === id)?.name ?? id).join('、') || '未设置'}` : coffee.hooks[agent].status === 'conflict_agent2lark' ? '修复会替换 agent2lark 的 Hook。' : undefined}
        trailing={<Button size="sm" loading={busy === agent} disabled={busy !== null} onClick={() => void repair(agent)}>检查并修复</Button>}/>)}
    </SettingsGroup>
    {notice && <InlineNotice title="操作结果">{notice}</InlineNotice>}
  </>;
}

function HostPanel({
  view,
  refresh,
}: {
  view: HostSettingsView;
  refresh: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<{
    token: string;
    displayPath: string;
  }>();
  const [notice, setNotice] = useState<string>();
  const execution = view.sections.execution;
  async function pick() {
    const reply = await window.bridge.settings({ type: "chooseExecutable" });
    if (reply.kind === "fileChosen") setChoice(reply.file);
    else if (reply.kind === "refused") setNotice(reply.message);
  }
  async function save(): Promise<boolean> {
    if (!choice || execution.access.kind === 'readonly') return false;
    const reply = await window.bridge.settings({
      type: "saveExecutable",
      token: choice.token,
      revision: execution.revision,
    });
    setNotice(
      errorText(reply) ?? "Codex 路径已保存，将在下次 Host 启动时使用。",
    );
    if (reply.kind === "saved" && reply.result.kind === "saved") {
      setChoice(undefined);
      await refresh();
      return true;
    }
    return false;
  }
  useDraft(choice !== undefined, {title: 'Codex 可执行文件', save, discard: () => setChoice(undefined)});
  async function reset() {
    const reply = await window.bridge.settings({
      type: "save",
      edit: {
        scope: view.scope,
        section: "execution",
        revision: execution.revision,
        patch: { codexBin: null },
      },
    });
    setNotice(errorText(reply) ?? "Codex 路径已恢复自动检测。");
    if (reply.kind === "saved" && reply.result.kind === "saved")
      await refresh();
  }
  return (
    <SettingsGroup
      label="Codex 可执行文件"
        id={settingAnchor("Codex 可执行文件")}
      footer={
        execution.access.kind === "readonly"
          ? execution.access.message
          : effectText(execution)
      }
    >
      <SettingsRow
        title="已保存路径"
        value={execution.stored.codexBin ?? "自动检测"}
      />
      <SettingsRow
        title="当前路径配置"
        value={view.runtime.codexBin ?? "自动检测"}
      />
      <SettingsRow
        title="本次所选"
        value={choice?.displayPath ?? "尚未选择"}
        trailing={
          <Button
            size="sm"
            disabled={execution.access.kind === "readonly"}
            onClick={() => void pick()}
          >
            选择文件
          </Button>
        }
      />
      <div className="settings-edit-actions">
        <Button
          size="sm"
          disabled={!choice || execution.access.kind === "readonly"}
          onClick={() => void save()}
        >
          保存路径
        </Button>
        <Button
          size="sm"
          disabled={
            execution.stored.codexBin === null ||
            execution.access.kind === "readonly"
          }
          onClick={() => void reset()}
        >
          恢复自动检测
        </Button>
      </div>
      <SettingsRow
        title="未绑定工作目录时的运行后备"
        value={view.runtime.fallbackCwd}
      />
      <ActionNotice message={notice} />
    </SettingsGroup>
  );
}
export function SettingsPanel(props: PanelProps) {
  const {target} = props;
  const key = JSON.stringify([
    target.kind,
    "botId" in target ? target.botId : null,
    "projectName" in target ? target.projectName : null,
  ]);
  return <ScopedSettingsPanel key={key} {...props} />;
}
function ScopedSettingsPanel(props: PanelProps) {
  const {target} = props;
  const [scope] = useState(target);
  const [view, setView] = useState<SettingsView>();
  const [notice, setNotice] = useState<{
    kind: "error" | "paused";
    message: string;
  }>();
  const mounted = useRef(false);
  const cancelRead = useRef<() => void>(() => {});
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    cancelRead.current();
    let cancelled = false;
    let timer: number | undefined;
    let timeout: number | undefined;
    const deadline = Date.now() + 30000;
    const delays = [1000, 2000, 4000, 8000, 8000];
    const cancellation = new Promise<undefined>((resolve) => {
      cancelRead.current = () => {
        cancelled = true;
        window.clearTimeout(timer);
        window.clearTimeout(timeout);
        resolve(undefined);
      };
    });
    setNotice(undefined);
    async function read(attempt: number): Promise<void> {
      if (cancelled) return;
      try {
        const reply = await Promise.race([
          cancellation,
          window.bridge.settings({ type: "read", scope }),
          new Promise<never>((_, reject) => {
            timeout = window.setTimeout(
              () => reject(new Error("读取超时，请重新读取。未保存的修改已保留。")),
              Math.min(10000, Math.max(0, deadline - Date.now())),
            );
          }),
        ]);
        window.clearTimeout(timeout);
        if (cancelled || reply === undefined) return;
        if (reply.kind !== "view" || JSON.stringify(reply.view.scope) !== JSON.stringify(scope)) {
          throw new Error(reply.kind === "refused" ? reply.message : "设置身份与当前选择不一致。");
        }
        setView(reply.view);
        setNotice(undefined);
        if (!isAgentView(reply.view) || reply.view.voice.feishu.state !== "testing") return;
        const wait = delays[attempt];
        if (wait === undefined || Date.now() + wait >= deadline) {
          setNotice({ kind: "paused", message: "检查尚未完成，已暂停自动刷新。可重新读取；未保存的修改已保留。" });
          return;
        }
        timer = window.setTimeout(() => void read(attempt + 1), wait);
      } catch (failure) {
        window.clearTimeout(timeout);
        if (!cancelled) setNotice({
          kind: "error",
          message: failure instanceof Error ? failure.message : "设置暂不可用，请重新读取。",
        });
      }
    }
    await read(0);
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      cancelRead.current();
    };
  }, [refresh]);
  const status = notice ? (
    <InlineNotice title={notice.kind === "error" ? "设置暂不可用" : "检查仍在进行"} tone="warning">
      {notice.message}
    </InlineNotice>
  ) : null;
  if (!view) return (
    <SettingsGroup label="设置" action={<Button size="sm" onClick={() => void refresh()}>重新读取</Button>}>
      {status ?? <SettingsRow title="正在读取当前设置…" />}
    </SettingsGroup>
  );
  const content = isAgentView(view) && props.scope === 'agent' ? (
    <AgentPanel view={view} refresh={refresh} mode="settings" reveal={props.reveal} />
  ) : isProjectView(view) && props.scope === 'project' ? (
    <ProjectPanel view={view} refresh={refresh} category={props.category} />
  ) : isHostView(view) ? (
    props.scope === 'host' && props.category === 'coffee'
      ? <CoffeeHostPanel view={view} refresh={refresh} reveal={props.reveal}/>
      : <HostPanel view={view} refresh={refresh} />
  ) : null;
  return (
    <>
      <div className="settings-scope-bar"><span>{view.scope.kind === 'agent' ? '当前 Agent' : view.scope.kind === 'project' ? '当前 Agent 在此群' : view.scope.kind === 'host' ? '这台设备' : '当前话题'}</span><Button size="sm" onClick={() => void refresh()}>重新读取</Button></div>
      {status}
      {content}
    </>
  );
}
export function membershipSettingsTarget(member: Membership): ProjectScope {
  return { kind: "project", botId: member.agentId, projectName: member.name };
}
