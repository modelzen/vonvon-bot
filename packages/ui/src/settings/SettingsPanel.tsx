import {RefreshCw, Zap} from 'lucide-react';
import {useClient, useShellCapabilities} from '../client-context';
import type {VonvonClient} from '@vonvon/client/browser';
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconButton, FormField, InlineNotice, SelectControl, Toggle } from "../reference/components/ui";
import { Dialog } from "../reference/components/ui/Dialog";
import {
  SettingsGroup,
  SettingsRow,
} from "../reference/components/system-settings";
import {
  backendLabel,
  groupIdSchema,
  type AgentId,
  type Membership,
} from "@vonvon/protocol";
import {
  type AgentSettingsView,
  type HostSettingsView,
  type ModelCatalog,
  type ModelSelection,
  type ProjectSettingsView,
  type SessionSettingsView,
  type SettingsReply,
  type SettingsScope,
  type SettingsView,
} from "@vonvon/protocol";
import "./settings.css";
import {useDraft} from './DraftGuard';
import {settingAnchor} from '../search';
import {JudgeModelChoice} from './JudgeModelChoice';
import {SettingChoices} from './SettingChoices';
import {NativePermissionFields, nativePermissionPatch} from './NativePermissionFields';
import {AnnouncedReadonlyMessages, hasReadonlyMessage, type ReadonlyMessage} from './readonly-messages';
import './permission-summary.css';
import {ResponseMemberPicker} from './ResponseMemberPicker';
import {Person} from '../management/Person';
import {BotTitleSettings, BotCommentSettings} from './BotModelSettings';
import {WelcomeCardSettings} from './WelcomeCardSettings';

type AgentScope = { kind: "agent"; botId: AgentId };
type ProjectScope = { kind: "project"; botId: AgentId; projectName: string };
type PanelProps =
  | {scope: 'agent'; target: AgentScope}
  | {scope: 'project'; target: ProjectScope; onOpenSecrets?: () => void}
  | {scope: 'host'; target: {kind: 'host'}};
const isAgentView = (view: SettingsView): view is AgentSettingsView =>
  view.scope.kind === "agent" && "administrators" in view;
const isProjectView = (view: SettingsView): view is ProjectSettingsView =>
  view.scope.kind === "project" && "members" in view;
const isSessionView = (view: SettingsView): view is SessionSettingsView =>
  view.scope.kind === "session" && "identity" in view && !("members" in view);
const isHostView = (view: SettingsView): view is HostSettingsView =>
  view.scope.kind === "host" && "runtime" in view;
export type Section<T> = {
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
export type SettingsFieldIssue = {field: string; message: string};
export const errorText = (reply: SettingsReply, labels?: Record<string, string>): string | undefined => {
  if (reply.kind === "refused") return reply.message;
  if (reply.kind === "saved") {
    if (reply.result.kind === "rejected")
      return reply.result.fields
        .map((item) => `${labels?.[item.field] ?? item.field}：${item.message}`)
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
  }
};
export function Editor<T extends object>({
  title,
  section,
  render,
  save,
  validate,
  submitLabel = '保存',
  allowUnchanged = false,
  afterSave,
  showSave = false,
  savedNotice,
  initialDraft,
  renderLayout,
  prepareSave,
  autoSave = false,
  headerAction,
  hideEffects = false,
  fieldLabels,
}: {
  title: string;
  headerAction?: ReactNode;
  hideEffects?: boolean;
  fieldLabels?: Record<string, string>;
  section: Section<T>;
  render: (
    draft: T,
    change: (value: T) => void,
    disabled: boolean,
    commit: (patch: Partial<T>) => Promise<void>,
    resetKey: string,
    discard: () => void,
    fieldIssues: SettingsFieldIssue[],
  ) => ReactNode;
  save: (patch: Partial<T>, revision: string) => Promise<SettingsReply>;
  validate?: (value: T) => string | undefined;
  submitLabel?: string;
  allowUnchanged?: boolean;
  afterSave?: () => Promise<void>;
  showSave?: boolean;
  savedNotice?: (stored: T) => string | undefined;
  /** Text shown in the form from the start but not saved until the person saves (a prefilled draft). */
  initialDraft?: Partial<T>;
  /** A dialog can own its header and footer while reusing draft and revision handling. */
  renderLayout?: (editor: {content: ReactNode; submit: () => Promise<boolean>; discard: () => void; pending: boolean; canSave: boolean}) => ReactNode;
  /** Build a payload from the complete selected form value, before sparse-draft keys are lost. */
  prepareSave?: (patch: Partial<T>, value: T) => Partial<T>;
  /** Discrete choices commit immediately; failed choices return to the confirmed value. */
  autoSave?: boolean;
}) {
  const announcedReadonly = useContext(AnnouncedReadonlyMessages);
  const [confirmed, setConfirmed] = useState(section);
  const [discardVersion, setDiscardVersion] = useState(0);
  const [draft, setDraft] = useState<Partial<T>>(initialDraft ?? {});
  const [immediate, setImmediate] = useState<
    | { kind: 'idle' }
    | { kind: 'pending'; patch: Partial<T> }
    | { kind: 'failed'; patch: Partial<T>; message: string }
  >({kind: 'idle'});
  const [pendingManual, setPendingManual] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictCurrent, setConflictCurrent] = useState<Section<T>>();
  const priorRevision = useRef<string | undefined>(undefined);
  const autoSavePending = useRef(false);
  const [error, setError] = useState<string>();
  const [fieldIssues, setFieldIssues] = useState<SettingsFieldIssue[]>([]);
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
  const guarded = dirty || immediate.kind === 'pending' || !autoSave && immediate.kind === 'failed' || pendingManual;
  const disabled = pendingManual || (autoSave ? immediate.kind === 'pending' : immediate.kind !== 'idle') || section.access.kind === "readonly" || conflict;
  const value = { ...confirmed.stored, ...draft, ...(immediate.kind === 'idle' || autoSave && immediate.kind === 'failed' ? {} : immediate.patch) };
  function edit(next: T) {
    if (autoSave && (disabled || autoSavePending.current)) return;
    setFieldIssues([]);
    const changed: Partial<T> = {};
    for (const key of Object.keys(next) as (keyof T)[]) {
      if (JSON.stringify(next[key]) !== JSON.stringify(value[key])) changed[key] = next[key];
    }
    if (autoSave) {
      const invalid = validate?.(next);
      if (invalid) {setError(invalid); return;}
      void commit(changed);
      return;
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
    const saved = savedNotice?.(canonical.stored as T) ?? (reply.result.effects.map(item => item.detail).join(' ') || '已保存。');
    setNotice([saved, ...reply.result.warnings ?? []].join(' '));
    return true;
  }
  function noteConflict(reply: SettingsReply) {
    if (reply.kind !== 'saved' || reply.result.kind !== 'conflict') return;
    const current = reply.result.current.value;
    setConflictCurrent({ ...confirmed, stored: current.stored as T, effective: current.effective as T, revision: current.revision, apply: current.apply });
    setConflict(true);
  }
  async function commit(patch: Partial<T>): Promise<void> {
    if (disabled || autoSave && autoSavePending.current || !Object.keys(patch).length) return;
    if (autoSave) autoSavePending.current = true;
    setImmediate({kind: 'pending', patch});
    setError(undefined); setNotice(undefined);
    try {
      const reply = await save(prepareSave ? prepareSave(patch, {...value, ...patch}) : patch, confirmed.revision);
      if (accept(reply)) setImmediate({kind: 'idle'});
      else {
        noteConflict(reply);
        setImmediate({kind: 'failed', patch, message: errorText(reply) ?? '未收到保存确认，请重试。'});
      }
    } catch (error) {
      setImmediate({kind: 'failed', patch, message: error instanceof Error ? error.message : '保存失败。'});
    } finally {
      autoSavePending.current = false;
    }
  }
  async function retry(): Promise<string | undefined> {
    if (immediate.kind !== 'failed' || conflict || section.access.kind === 'readonly' || autoSave && autoSavePending.current) return undefined;
    if (autoSave) autoSavePending.current = true;
    const patch = immediate.patch;
    setImmediate({kind: 'pending', patch});
    try {
      const reply = await save(prepareSave ? prepareSave(patch, {...value, ...patch}) : patch, confirmed.revision);
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
    } finally {
      autoSavePending.current = false;
    }
  }
  async function submit(): Promise<boolean> {
    setFieldIssues([]);
    const invalid = validate?.(value);
    if (invalid) { setError(invalid); return false; }
    let revision = confirmed.revision;
    if (immediate.kind === 'failed') {
      const savedRevision = await retry();
      if (!savedRevision) return false;
      if (!dirty) return true;
      revision = savedRevision;
    } else if (disabled || !dirty && !allowUnchanged) return false;
    const patch = dirty ? draft : value;
    setPendingManual(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await save(prepareSave ? prepareSave(patch, value) : patch, revision);
      noteConflict(result);
      const failure = errorText(result, fieldLabels);
      if (result.kind === 'saved' && result.result.kind === 'rejected') setFieldIssues(result.result.fields);
      if (failure) { setError(failure); return false; }
      if (accept(result)) {
        setDraft({});
        await afterSave?.();
        return true;
      }
      setError('未收到保存确认，请重新读取后重试。');
      return false;
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败。");
      setNotice(undefined);
      return false;
    } finally {
      setPendingManual(false);
    }
  }
  function discard() {
    setFieldIssues([]);
    setDiscardVersion(version => version + 1);
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
  const content = (
    <SettingsGroup
      id={renderLayout ? undefined : settingAnchor(title)}
      label={renderLayout ? undefined : title}
      action={headerAction}
      footer={
        section.access.kind === "readonly"
          ? hasReadonlyMessage(announcedReadonly, section.access) ? undefined : section.access.message
          : hideEffects || effectText(section) === '下一条消息生效' ? undefined : effectText(section)
      }
    >
      {render(value, edit, disabled, commit, `${confirmed.revision}:${discardVersion}`, discard, fieldIssues)}
      {!renderLayout && (dirty || allowUnchanged || showSave) && <div className="settings-edit-actions">
        {dirty && <Button
          size="sm"
          disabled={!dirty || disabled}
          onClick={discard}
        >
          放弃修改
        </Button>}
        <Button
          size="sm"
          variant="primary"
          disabled={(!dirty && !allowUnchanged) || disabled}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>}
      {immediate.kind === 'pending' && (autoSave ? <p className="settings-save-status" role="status">正在切换…</p> : <InlineNotice title="正在保存">这项设置正在保存。</InlineNotice>)}
      {immediate.kind === 'failed' && <InlineNotice title={autoSave ? '切换未完成' : '保存未完成'} tone="danger">
        {immediate.message}
        <span className="settings-edit-actions">
          <Button size="sm" disabled={conflict} onClick={() => void retry()}>重试</Button>
          <Button size="sm" onClick={() => setImmediate({kind: 'idle'})}>{autoSave ? '保留原设置' : '放弃这项修改'}</Button>
        </span>
      </InlineNotice>}
      {conflict && <InlineNotice title="设置已在别处更改" tone="danger">
        {autoSave ? '请重新读取最新设置后再切换。' : '当前草稿已保留。重新读取后可基于最新设置修改。'}
        {autoSave ? <IconButton size="sm" variant="ghost" label="重新读取" title="重新读取最新设置" onClick={discard}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
          : <Button size="sm" onClick={discard}>重新读取并放弃草稿</Button>}
      </InlineNotice>}
      {error && (
        <InlineNotice title="保存未完成" tone="danger">
          {error}
        </InlineNotice>
      )}
      {notice && !autoSave && <InlineNotice title="本次修改已保存">{notice}{dirty ? ' 其他修改尚未保存。' : ''}</InlineNotice>}
    </SettingsGroup>
  );
  return renderLayout ? renderLayout({content, submit, discard, pending: pendingManual || immediate.kind === 'pending', canSave: !disabled && (dirty || allowUnchanged)}) : content;
}
export function Text({
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
  choices: readonly { value: T; label: string; disabled?: boolean }[];
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
        <option key={item.value} value={item.value} disabled={item.disabled}>
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
export type CatalogControls = {loading: boolean; error?: string; refresh: () => void};
export function Catalog({
  botId,
  backend,
  purpose,
  threadId,
  children,
  showStatus = true,
}: {
  botId: AgentId;
  backend: string;
  purpose: "project" | "session" | "comments" | "titles" | "judge";
  threadId?: string;
  children: (catalog: ModelCatalog | undefined, controls: CatalogControls) => ReactNode;
  showStatus?: boolean;
}) {
  const client = useClient();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const queryKey = JSON.stringify([botId, backend, purpose, threadId]);
  const previousQuery = useRef<string | undefined>(undefined);
  const readAttempt = useRef(0);
  useEffect(() => {
    let active = true;
    if (previousQuery.current !== queryKey) setCatalog(undefined);
    previousQuery.current = queryKey;
    setError(undefined);
    setLoading(true);
    const refresh = attempt > readAttempt.current;
    readAttempt.current = attempt;
    void client
      .settings({ type: "models", query: { botId, backend, purpose, ...(refresh ? {refresh: true} : {}), ...(threadId ? {threadId} : {}) } })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "models") setCatalog(reply.catalog);
        else {
          setCatalog(undefined);
          setError(
            reply.kind === "refused" ? reply.message : "模型目录暂不可用。",
          );
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setCatalog(undefined);
          setError(
            failure instanceof Error ? failure.message : "模型目录暂不可用。",
          );
        }
      }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
    };
  }, [client, botId, backend, purpose, threadId, queryKey, attempt]);
  const unavailable = catalog && catalog.state !== "ready";
  const controls: CatalogControls = {
    loading,
    error: error || (unavailable ? catalog.error || '暂时无法读取模型，已保存的选择仍保留。' : undefined),
    refresh: () => {setLoading(true); setAttempt(value => value + 1);},
  };
  return (
    <>
      {showStatus && (error || unavailable) && (
        <div className="gd-model-catalog-status" role="status">
          <span>{error || catalog?.error || '暂时无法读取模型，已保存的选择仍保留。'}</span>
          <IconButton size="sm" variant="ghost" label="重新读取模型" title="重新读取模型" disabled={loading} onClick={controls.refresh}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
        </div>
      )}
      {showStatus && !catalog && !error && <p className="gd-model-compact-note" role="status">正在读取模型…</p>}
      {showStatus && catalog?.state === 'ready' && <div className="gd-model-catalog-status"><span>可用模型</span><IconButton size="sm" variant="ghost" label="重新读取模型" title="重新检测模型" disabled={loading} onClick={controls.refresh}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></div>}
      {children(catalog, controls)}

    </>
  );
}
/** Select value that switches the model id text field on (never a real id). */
const CUSTOM_MODEL = "__custom__";
export function ModelChoice({
  value,
  onChange,
  catalog,
  disabled,
  allowCustom,
  speedControl,
}: {
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  catalog: ModelCatalog | undefined;
  disabled: boolean;
  /** offer「自定义模型 ID…」: a hand-typed id the catalog does not list (3.11) */
  allowCustom?: boolean;
  speedControl?: ReactNode;
}) {
  const model = value.kind === "explicit" ? value.model : "";
  const listed = catalog?.models.filter((item) => !item.hidden) ?? [];
  const selected = listed.find((item) => item.id === model);
  const savedCustom = value.kind === "explicit" && value.custom === true;
  // Picking「自定义」before typing leaves the draft on its old value; this keeps
  // the text field open until another option is picked.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (value.kind === "explicit" && !value.custom) setTyping(false);
  }, [value]);
  const customMode = Boolean(allowCustom) && (savedCustom || typing);
  const savedEfforts = value.kind === "explicit" ? [value.effort] : [];
  const efforts =
    (customMode ? catalog?.titleEfforts : selected?.supportedEfforts) ??
    savedEfforts;
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
        trailing={<div className="settings-model-controls">
          <select
            aria-label="模型"
            value={customMode ? CUSTOM_MODEL : model}
            disabled={
              disabled ||
              (!allowCustom &&
                catalog?.state === "unavailable" &&
                value.kind === "default")
            }
            onChange={(event) => {
              if (event.target.value === CUSTOM_MODEL) {
                // Start from the current id so it can be edited in place.
                setTyping(true);
                if (value.kind === "explicit")
                  onChange({ ...value, custom: true });
                return;
              }
              setTyping(false);
              const picked = event.target.value;
              const next = listed.find((item) => item.id === picked);
              if (next) {
                onChange({
                  kind: "explicit",
                  model: next.id,
                  effort: next.defaultEffort,
                });
              } else if (picked && picked === model) {
                onChange(value);
              } else {
                onChange({ kind: "default" });
              }
            }}
          >
            <option value="">使用默认模型</option>
            {model && !selected && !customMode && (
              <option value={model}>{model}（已保存，当前目录不可用）</option>
            )}
            {listed.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName} · {item.id}
              </option>
            ))}
            {allowCustom && (
              <option value={CUSTOM_MODEL}>自定义模型 ID…</option>
            )}
          </select>
          {speedControl}
        </div>}
      />
      {customMode && (
        <SettingsRow
          title="自定义模型 ID"
          description="用于目录外的模型；ID 不会预先验证，填写有误时任务会失败。"
          trailing={
            <Text
              label="自定义模型 ID"
              value={model}
              placeholder="例如 deepseek-chat"
              disabled={disabled}
              onChange={(next) => {
                if (!next.trim()) {
                  onChange({ kind: "default" });
                  return;
                }
                const effort =
                  value.kind === "explicit" &&
                  (catalog?.titleEfforts ?? []).includes(value.effort)
                    ? value.effort
                    : "medium";
                onChange({
                  kind: "explicit",
                  model: next,
                  effort,
                  custom: true,
                });
              }}
            />
          }
        />
      )}
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
type SpeedTier = "standard" | "fast" | "ultrafast";
type SpeedSection = NonNullable<ProjectSettingsView["sections"]["speed"]>;
const speedNames: Record<SpeedTier, string> = {
  standard: "普通", fast: "Fast", ultrafast: "Ultrafast",
};

/** Only confirmed tiers for the selected model appear in this compact control. */
export function SpeedChoice({tier, catalog, selection, disabled, onChange}: {
  tier: string;
  catalog: ModelCatalog | undefined;
  selection: ModelSelection;
  disabled: boolean;
  onChange: (tier: SpeedTier) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menu.current?.open) return;
      event.preventDefault();
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissEscape);
    return () => {document.removeEventListener('pointerdown', dismissOutside); document.removeEventListener('keydown', dismissEscape);};
  }, []);
  const model = catalog?.state === 'ready' && catalog.models.find(item => selection.kind === 'explicit' ? !selection.custom && item.id === selection.model : item.isDefault);
  const options = (['fast', 'ultrafast'] as const).filter(item => model && model.serviceTiers?.some(allowed => allowed.id === item));
  if (!options.length) return null;
  const active = options.find(item => item === tier);
  return <details ref={menu} className="settings-speed-menu">
    <summary aria-label={`响应速度：${active ? speedNames[active] : '普通'}`} title="响应速度" aria-disabled={disabled} onClick={event => {if (disabled) event.preventDefault();}}>
      <Zap size={15} aria-hidden="true" fill={active ? 'currentColor' : 'none'}/>
      {active && <span className="settings-speed-active">{speedNames[active]}</span>}
    </summary>
    <div className="settings-speed-options" role="group" aria-label="响应速度">
      {(['standard', ...options] as SpeedTier[]).map(option => <button type="button" key={option} disabled={disabled} aria-pressed={(active ?? 'standard') === option}
        onClick={event => {onChange(option); event.currentTarget.closest('details')?.removeAttribute('open');}}>
        <span>{speedNames[option]}</span>{option === (active ?? 'standard') && <span aria-hidden="true">✓</span>}
      </button>)}
      <p>加速会消耗更多额度；下次任务生效。</p>
    </div>
  </details>;
}

export function SpeedEditor({section, catalog, selection, disabled, save}: {
  section: SpeedSection;
  catalog: ModelCatalog | undefined;
  selection: ModelSelection;
  disabled?: boolean;
  save: (patch: {tier?: SpeedTier}, revision: string) => Promise<SettingsReply>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  return <span className="settings-speed-control">
    <SpeedChoice tier={section.effective.tier} catalog={catalog} selection={selection} disabled={disabled || pending || section.access.kind === 'readonly'}
      onChange={tier => {if (tier === section.stored.tier) return; setPending(true); setFailure(undefined); void save({tier}, section.revision)
        .then(reply => {setFailure(errorText(reply));}).catch(error => setFailure(error instanceof Error ? error.message : '切换失败。')).finally(() => setPending(false));}}/>
    {failure && <span className="settings-speed-error" role="alert">{failure}</span>}
  </span>;
}
function ActionNotice({ message }: { message: string | undefined }) {
  return message ? (
    <InlineNotice title="操作结果">{message}</InlineNotice>
  ) : null;
}
function AgentPanel({
  view,
  refresh,
}: {
  view: AgentSettingsView;
  refresh: () => Promise<void>;
}) {
  const client = useClient();
  const [actionMessage, setActionMessage] = useState<string>();
  const [chatId, setChatId] = useState("");
  async function save(
    section: keyof AgentSettingsView["sections"],
    patch: object,
    revision: string,
  ) {
    const result = await client.settings({
      type: "save",
      edit: { scope: view.scope, section, revision, patch },
    });
    if (result.kind === "saved" && result.result.kind === "saved")
      await refresh();
    return result;
  }
  async function act(
    action: Parameters<VonvonClient["settings"]>[0] & { type: "act" },
  ) {
    const result = await client.settings(action);
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
      await refresh();
    }
    return result.kind === 'acted' && result.result.kind === 'saved';
  }
  useDraft(Boolean(chatId), {title: '添加群 ID', save: async () => {setActionMessage('请先将群 ID 添加到列表，再保存。'); return false;}, discard: () => setChatId('')});
  const run = view.sections.run,
    voice = view.voice,
    access = view.sections.access,
    voiceAccess = view.sections.completion.access;
  return (
    <>
      <Editor title="运行上限" headerAction={<IconButton size="sm" variant="ghost" className="bot-settings-refresh" label="重新读取设置" title="重新读取此 Bot 的所有设置" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>} section={run} save={(draft, revision) => save("run", draft, revision)}
        render={(draft,set,disabled) => <>
          <SettingsRow title="同时处理的任务" trailing={<NumberField label="最大并发任务" value={draft.maxConcurrentRuns} min={1} max={50} disabled={disabled} onChange={maxConcurrentRuns => set({...draft,maxConcurrentRuns})}/>}/>
          {run.effective.maxConcurrentRuns !== run.stored.maxConcurrentRuns && <SettingsRow title="当前运行上限" value={String(run.effective.maxConcurrentRuns)} description="重启后使用新上限。"/>}
          <SettingsRow title="空闲超时" description="单位秒，0 表示关闭。" trailing={<NumberField label="空闲超时" value={draft.runIdleTimeoutSeconds} min={0} max={3600} disabled={disabled} onChange={runIdleTimeoutSeconds => set({...draft,runIdleTimeoutSeconds})}/>}/>
        </>}/>
      {view.sections.welcome && <WelcomeCardSettings
        section={view.sections.welcome}
        save={(patch, revision) => save("welcome", patch, revision)}
      />}
      <Editor title="完成提醒" section={view.sections.completion} save={(patch, revision) => save('completion', patch, revision)} render={(draft, set, disabled, commit) => <>
        <SettingsRow title="提醒方式" description="手动时，执行中的消息卡片会显示「完成后提醒我」。" trailing={<SettingChoices segmented label="完成提醒" disabled={disabled} value={draft.mode} choices={[{value:'manual',label:'手动'},{value:'long',label:'长任务'},{value:'failures',label:'失败时'},{value:'always',label:'每次'}]} onChange={mode => void commit({mode})}/>}/>
        {draft.mode === 'long' && <SettingsRow title="超过几分钟提醒" trailing={<NumberField label="长任务分钟数" value={draft.longTaskMinutes} min={1} max={1440} disabled={disabled} onChange={longTaskMinutes => set({...draft,longTaskMinutes})}/>}/>}</>}/>
      <SettingsGroup
        label="语音转文字"
        id={settingAnchor("语音转文字")}
        footer={
          voiceAccess.kind === "readonly"
            ? voiceAccess.message
            : undefined
        }
      >
        <SettingsRow
          title="飞书语音权限"
          description={voice.feishu.message}
          trailing={
            <div className="settings-inline-actions">
              <IconButton label="重新检测" title="重新检测飞书语音权限" variant="ghost"
                size="sm"
                disabled={voiceAccess.kind === "readonly"}
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
              ><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
              <Button
                size="sm"
                disabled={voiceAccess.kind === "readonly"}
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
      <BotTitleSettings key={`titles:${view.scope.botId}`} view={view} save={save}/>
      <BotCommentSettings key={`comments:${view.scope.botId}`} view={view} save={save} refresh={refresh}/>
      <details className="agent-settings-disclosure">
        <summary><span>更多设置<small>允许的飞书群</small></span></summary>
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
      <ActionNotice message={actionMessage} />
    </>
  );
}
type PermissionView = ProjectSettingsView['sections']['permission']['stored'];
export function NativePermissionEditor({section, provider, save}: {section: Section<PermissionView>; provider: string; save: (patch: Partial<PermissionView>, revision: string) => Promise<SettingsReply>}) {
  const fields = section.stored.options.fields;
  if (!fields?.length) return null;
  const initial = section.stored.custom ?? section.stored.options.expanded[section.stored.mode];
  return <details className="membership-settings-details"><summary>高级设置</summary>
    <Editor title="高级设置" section={section} showSave
      savedNotice={stored => stored.custom === null ? `和「${stored.options.tiers.find(tier => tier.tier === stored.mode)?.name ?? stored.mode}」一样，已存成这一档。` : undefined}
      save={(patch, revision) => save({custom: nativePermissionPatch(fields, patch.custom ?? initial)}, revision)}
      render={(draft, set, disabled) => <>
        <p className="permission-note">这里只列 {provider} 自己支持的设置。群里没人确认，要确认的操作一律拒绝，所以没有“问不问”的设置。换 provider 时会清掉。</p>
        <NativePermissionFields fields={fields} value={draft.custom ?? draft.options.expanded[draft.mode]} disabled={disabled} onChange={value => {
          const unchanged = JSON.stringify(nativePermissionPatch(fields, value)) === JSON.stringify(nativePermissionPatch(fields, initial));
          set({...draft, custom: unchanged ? section.stored.custom : value});
        }}/>
      </>}/>
  </details>;
}
// Intent: the group owner compares the provider's three levels before granting access.
// Hierarchy: level names lead; native names and enforcement stay secondary. Existing
// surface/border tokens, system type and 4px spacing keep this within the settings UI.
function hasAdditionalPermissionChoices(value: PermissionView): boolean {
  const fields = value.options.fields ?? [];
  if (!fields.length) return false;
  // A single unconditional choice adds nothing when every native value is already
  // one of the three presets. Other field shapes can form new combinations.
  const field = fields[0];
  if (fields.length !== 1 || !field || field.kind !== 'choice' || field.showWhen || !field.choices?.length) return true;
  const presets = Object.values(value.options.expanded).map(expanded => nativePermissionPatch(fields, expanded)[field.key]);
  return field.choices.some(choice => !presets.includes(choice.value));
}
export function PermissionFields({value, disabled, onChange, provider}: {value: PermissionView; disabled: boolean; onChange: (patch: Partial<Pick<PermissionView, 'mode' | 'custom'>>) => void; provider?: string}) {
  const {options} = value;
  const fields = options.fields ?? [];
  type Choice = PermissionView['mode'] | 'custom';
  const choices: {value: Choice; label: string; disabled?: boolean; description: ReactNode}[] = options.tiers.map(tier => ({value: tier.tier, label: tier.name, disabled: Boolean(tier.unavailable), description: <>
        <small>{tier.summary}</small>{tier.native && <small>{tier.native}</small>}{tier.unavailable && <small>{tier.unavailable}</small>}{tier.warning && <small>{tier.warning}</small>}
      </>}));
  const warning = fullAccessWarning(value);
  if (hasAdditionalPermissionChoices(value) || value.custom || options.invalid) choices.push({value: 'custom', label: '自定义', disabled: !fields.length, description: <small>{fields.length ? `使用${provider ? ` ${provider} ` : ' Provider '}提供的原生设置。` : '当前 Provider 未提供可编辑字段，仅可查看已保存的设置。'}</small>});
  return <div className="permission-fields">
    {options.invalid && <p className="permission-note" role="status">自定义设置读不出来，现在按只读跑。选择预设重新设置。</p>}
    <SettingChoices<Choice> label="权限" stacked value={options.invalid ? '' : value.custom ? 'custom' : value.mode} disabled={disabled}
      choices={choices} onChange={choice => choice === 'custom' ? onChange({custom: {...(value.custom ?? options.expanded[value.mode])}}) : onChange({mode: choice})}/>
    {warning && !value.custom && <InlineNotice title="完全访问" tone="warning">{warning}</InlineNotice>}
    {value.custom && <section className="permission-custom-fields" aria-label="自定义权限设置">
      {fields.length ? <>
        <p className="permission-note">这里只列{provider ? ` ${provider} ` : ' Provider '}自己支持的设置。群里没人确认，要确认的操作一律拒绝。换 Provider 时会清掉自定义设置。</p>
        <NativePermissionFields fields={fields} value={value.custom} disabled={disabled} onChange={custom => onChange({custom})}/>
      </> : <p className="permission-note">自定义：{options.customSummary}</p>}
      {options.legacy && <p className="permission-note">当前自定义设置从旧版的联网开关转来。</p>}
    </section>}
    <p className="permission-note" id={settingAnchor('能挡到什么')}>能挡到什么：{options.strength}</p>
  </div>;
}

/** A group on 完全访问 carries the daemon's warning (devices 第 15 节); a bot's own settings do not. */
export function fullAccessWarning(value: Pick<PermissionView, 'mode' | 'options'>): string | undefined {
  return value.mode === 'full' && !value.options.invalid ? value.options.tiers.find(tier => tier.tier === 'full')?.warning : undefined;
}

/** Keep the current grant readable; compare the provider's levels only while editing. */
export function PermissionSummary({section, provider, save}: {section: Section<PermissionView>; provider: string; save: (patch: Partial<PermissionView>, revision: string) => Promise<SettingsReply>}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [editSession, setEditSession] = useState(0);
  const discardChoice = useRef<(() => void) | undefined>(undefined);
  const announcedReadonly = useContext(AnnouncedReadonlyMessages);
  const value = section.stored;
  const currentTier = value.options.tiers.find(tier => tier.tier === value.mode);
  const invalid = Boolean(value.options.invalid);
  const description = invalid ? '自定义设置读不出来，现在按只读运行。'
    : value.custom ? value.options.customSummary : currentTier?.summary;
  const close = () => {if (!pending) {discardChoice.current?.(); setOpen(false);}};
  async function savePermission(patch: Partial<PermissionView>, revision: string) {
    setPending(true);
    try {return await save(patch, revision);}
    finally {setPending(false);}
  }
  return <>
    <SettingsGroup label="执行权限" id={settingAnchor('权限')} className="permission-summary"
      footer={section.access.kind === 'readonly' && !hasReadonlyMessage(announcedReadonly, section.access) ? section.access.message : undefined}>
      <SettingsRow title={invalid ? '只读（设置异常）' : value.custom ? '自定义权限' : currentTier?.name ?? value.mode}
        description={description}
        trailing={<span data-search-title="修改权限"><Button size="sm" onClick={() => {setEditSession(session => session + 1); setOpen(true);}}>{section.access.kind === 'readonly' ? '查看权限' : '修改权限'}</Button></span>}/>
      {fullAccessWarning(value) && <p className="permission-note" role="note">{fullAccessWarning(value)}</p>}
    </SettingsGroup>
    <Editor key={editSession} title="执行权限" section={section} save={savePermission} afterSave={async () => setOpen(false)}
      prepareSave={(_patch, draft) => draft.custom ? {custom: nativePermissionPatch(draft.options.fields ?? [], draft.custom)} : {mode: draft.mode}}
      validate={draft => draft.custom && !draft.options.fields?.length ? '当前 Provider 未提供可编辑的自定义权限，请选择预设。' : undefined}
      render={(draft, set, disabled) => <PermissionFields value={draft} provider={provider} disabled={disabled}
        onChange={patch => set({...draft, ...patch, ...(patch.mode ? {custom: null} : {}), options: draft.options.invalid ? {...draft.options, invalid: false} : draft.options})}/>}
      renderLayout={editor => {
        discardChoice.current = editor.discard;
        return <Dialog open={open} title="执行权限" description={section.access.kind === 'readonly' ? section.access.message : `设置 ${provider} 在本群中的执行范围，选择所需权限后保存。`} onClose={pending || editor.pending ? undefined : close}
          footer={<><Button disabled={pending || editor.pending} onClick={close}>取消</Button><Button variant="primary" loading={pending || editor.pending} disabled={!editor.canSave} onClick={() => void editor.submit()}>保存权限</Button></>}>
          <div className="permission-dialog">{editor.content}</div>
        </Dialog>;
      }}/>
  </>;
}

export function ProjectPanel({
  view,
  refresh,
  onOpenSecrets,
  partition,
  independent = false,
  hideJudge = false,
}: {
  view: ProjectSettingsView;
  refresh: () => Promise<void>;
  onOpenSecrets?: () => void;
  partition?: 'model' | 'permission' | 'response' | 'members' | 'run';
  independent?: boolean;
  hideJudge?: boolean;
}) {
  const client = useClient();
  const [pickingMembers, setPickingMembers] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  async function save(
    section: keyof ProjectSettingsView["sections"],
    patch: object,
    revision: string,
  ) {
    const result = await client.settings({
      type: "save",
      edit: { scope: view.scope, section, revision, patch },
    });
    if (result.kind === "saved" && result.result.kind === "saved")
      await refresh();
    return result;
  }
  async function memberAction(openId: string, membership: "present" | "absent") {
    if (memberBusy || view.sections.permission.access.kind === 'readonly') return false;
    setMemberBusy(true);
    try {
      const result = await client.settings({type:'act', action:{kind:'projectMember', botId:view.scope.botId, projectName:view.scope.projectName, openId, membership, revision:view.members.revision}});
      setNotice(errorText(result) ?? '成员范围已保存。');
      if (result.kind === 'acted' && result.result.kind === 'saved') {
        await refresh(); return true;
      }
      if (result.kind === 'acted' && result.result.kind === 'conflict') await refresh();
      return false;
    } catch (failure) {setNotice(failure instanceof Error ? failure.message : '成员范围未能保存。'); return false;}
    finally {setMemberBusy(false);}
  }
  const roster = view.members.roster;
  const memberLabel = (id: string) => {
    const member = roster?.entries.find(entry => entry.openId === id);
    return member ? `${member.name}${member.kind === "bot" ? " · Bot" : ""}` : `…${id.slice(-6)}`;
  };
  const announcedReadonly = useContext(AnnouncedReadonlyMessages);
  const permission = view.sections.permission,
    response = view.sections.response,
    model = view.sections.model,
    run = view.sections.run,
    judge = view.sections.judge;
  const visibleSections = [
    ...(!partition || partition === 'model' ? [model] : []),
    ...(!partition || partition === 'permission' || partition === 'members' ? [permission] : []),
    ...(!partition ? [permission] : []),
    ...((!partition || partition === 'response') && view.identity.kind !== "smart" ? [response] : []),
    ...((!partition || partition === 'response') && !hideJudge && groupJudgeVisible(view) && judge ? [judge] : []),
    ...((!partition || partition === 'run') && run && view.identity.backend !== "claude-agent" ? [run] : []),
  ];
  const repeatedReadonly: ReadonlyMessage[] = [];
  for (const section of visibleSections) {
    const access = section.access;
    if (access.kind !== 'readonly' || hasReadonlyMessage(announcedReadonly, access) || hasReadonlyMessage(repeatedReadonly, access)) continue;
    if (visibleSections.filter(candidate => candidate.access.kind === 'readonly' && hasReadonlyMessage([access], candidate.access)).length > 1) repeatedReadonly.push(access);
  }
  const groupReadonly = [...announcedReadonly, ...repeatedReadonly];
  return (
    <AnnouncedReadonlyMessages.Provider value={groupReadonly}>
      {repeatedReadonly.map(access => <p className="settings-readonly-notice" role="status" key={`${access.reason}:${access.message}`}>{access.message}</p>)}
      {(!partition || partition === 'model') && <>
      {!partition && <h2 className="membership-settings-heading">模型</h2>}
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
                allowCustom
              />
            )}
          />
        )}
      </Catalog>
      <SettingsGroup label="执行后端"><SettingsRow title="执行工具" value={view.identity.backend === "codex-appserver" ? "Codex" : view.identity.backend === "claude-agent" ? "Claude" : view.identity.backend} /></SettingsGroup>
      <details className="membership-settings-details"><summary>话题模型</summary><SessionPicker view={view} /></details>
      </>}
      {(!partition || partition === 'permission') && <>
      <PermissionSummary section={permission} provider={backendLabel(view.identity.backend)} save={(patch, revision) => save('permission', patch, revision)}/>
      </>}
      {(!partition || partition === 'members') && <>
      {!partition && <h2 className="membership-settings-heading">回复规则</h2>}
      <SettingsGroup label="回应谁" id={settingAnchor("回应谁")}
        action={<Button size="sm" aria-label="指定成员" disabled={permission.access.kind === 'readonly' || memberBusy} onClick={() => {setNotice(undefined); setPickingMembers(true);}}>指定成员</Button>}
        footer={<>{permission.access.kind === 'readonly' && !hasReadonlyMessage(groupReadonly, permission.access) && <span>{permission.access.message} </span>}不选成员时向全群开放；Bot 管理员与所有者始终可用。</>}>
        {!view.members.openIds.length && <SettingsRow title="所有成员" description="本群所有成员都可以发起任务。"/>}
        {view.members.openIds.map(id => <SettingsRow key={id} title={<Person name={memberLabel(id)}/>} description={`…${id.slice(-6)}`} trailing={<Button size="sm" variant="ghost" aria-label={`移除 ${memberLabel(id)}`} disabled={permission.access.kind === 'readonly' || memberBusy} onClick={() => void memberAction(id,'absent')}>移除</Button>}/>)}
        {view.members.openIds.length > 0 && <SettingsRow title="所有成员" trailing={<Button size="sm" variant="ghost" disabled={permission.access.kind === 'readonly' || memberBusy} onClick={async () => {
          if (permission.access.kind === 'readonly' || memberBusy) return;
          setMemberBusy(true);
          try {
            const reply = await client.settings({type:'act',action:{kind:'projectAudience',botId:view.scope.botId,projectName:view.scope.projectName,audience:'all',revision:view.members.revision}});
            setNotice(errorText(reply) ?? '已允许所有成员。');
            if (reply.kind === 'acted' && (reply.result.kind === 'saved' || reply.result.kind === 'conflict')) await refresh();
          } catch (failure) {setNotice(failure instanceof Error ? failure.message : '成员范围未能保存。');}
          finally {setMemberBusy(false);}
        }}>恢复所有成员</Button>}/>}
      </SettingsGroup>
      {pickingMembers && <ResponseMemberPicker roster={roster} selected={view.members.openIds} busy={memberBusy} readonly={permission.access.kind === 'readonly'} message={notice} onPick={id => void memberAction(id,'present')} onRefresh={() => void refresh()} onClose={() => setPickingMembers(false)}/>}
      </>}
      {(!partition || partition === 'response') && <>
      {/* 智能 has no 免@: a judgement decides (s25c). The group keeps its anchor, so search still lands here. */}
      {view.identity.kind === "smart" ? <SettingsGroup id={settingAnchor("群内响应")} label="群内响应">
        <SettingsRow title="免 @" value="由 Bot 判断"  />
      </SettingsGroup> : <Editor
        title="群内响应"
        section={response}
        save={(draft, revision) => save("response", draft, revision)}
        render={(draft, set, disabled, commit) => (
          <SettingsRow
            title="不 @ 也能发起任务"
            description={view.identity.kind === "single" ? "开启后，群内普通消息也会得到回复。" : "话题内消息与群内命令无需 @。"}
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
      />}
      {!hideJudge && groupJudgeVisible(view) && judge && <Catalog botId={view.scope.botId} backend={view.identity.backend} purpose="judge">
        {(catalog) => <Editor title="判断模型" section={judge}
          save={(draft, revision) => save("judge", draft, revision)}
          render={(draft, set, disabled, _commit, resetKey) => <JudgeModelChoice key={resetKey} value={draft.selection}
            onChange={(selection) => set({selection})} backend={view.identity.backend}
            catalog={catalog} decisionModels={view.decisionModels}
            effective={judge.effective.selection}
            showInheritedKey={judge.stored.selection.kind === "default" && draft.selection.kind === "default"}
            disabled={disabled} followLabel="跟着 Bot 默认" allowCustom onOpenSecrets={onOpenSecrets} />}
        />}
      </Catalog>}
      </>}
      {(!partition || partition === 'run') && <>
      {run && (view.identity.backend === "claude-agent"
        ? <SettingsGroup id={settingAnchor("新消息处理")} label="新消息处理">
          <SettingsRow title="新消息处理" value="排队等待" description="Bot 正在执行任务时，新消息会排队等待。Claude 暂不支持立即插话。" />
        </SettingsGroup>
        : <Editor title="新消息处理" section={run}
          save={(draft, revision) => save("run", draft, revision)}
          render={(draft, _set, disabled, commit) => <SettingsRow title="新消息处理"
            description="Bot 正在执行任务时，如何处理收到的新消息"
            trailing={<SelectControl label="新消息处理" value={independent && draft.pendingPolicy === 'default' ? run.effective.pendingPolicy : draft.pendingPolicy} disabled={disabled}
              options={[...(!independent ? [{value: "default" as const, label: "跟着 Bot 默认"}] : []), {value: "queue" as const, label: "排队等待"}, {value: "steer" as const, label: "立即插话"}]}
              onChange={(pendingPolicy) => void commit({pendingPolicy})} />}
          />} />)}
      </>}
      <ActionNotice message={notice} />
    </AnnouncedReadonlyMessages.Provider>
  );
}
export function SessionPicker({ view }: { view: ProjectSettingsView }) {
  const client = useClient();
  const [sessions, setSessions] = useState<
    Extract<SettingsReply, { kind: "sessions" }>["sessions"]
  >([]);
  const [threadId, setThreadId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setError(undefined);
    void client
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
      action={<IconButton size="sm" variant="ghost" label="刷新话题" title="刷新话题" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}
      footer="模型从该会话下一轮生效。"
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
                {item.summary || item.threadId}
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
  const client = useClient();
  const [view, setView] = useState<SessionSettingsView>();
  const [error, setError] = useState<string>();
  async function refresh() {
    try {
      const reply = await client.settings({ type: "read", scope });
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
    void client
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
  if (!view) return <p className="settings-operation-message" role="status">正在读取话题设置…</p>;
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
        threadId={scope.threadId}
      >
        {(catalog) => (<>
          <Editor
            title="本话题模型"
            section={model}
            save={async (draft, revision) => {
              const reply = await client.settings({
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
                allowCustom
                speedControl={view.identity.backend === 'codex-appserver' && view.sections.speed &&
                  <SpeedEditor section={view.sections.speed} catalog={catalog} selection={draft.selection}
                    disabled={disabled || JSON.stringify(draft.selection) !== JSON.stringify(model.stored.selection)}
                    save={async (patch, revision) => {
                      const reply = await client.settings({type: 'save', edit: {scope, section: 'speed', revision, patch}});
                      if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
                      return reply;
                    }}/>
                }
              />
            )}
          />
        </>)}
      </Catalog>
    </>
  );
}
export function CodexPathPanel({
  view,
  refresh,
}: {
  view: HostSettingsView;
  refresh: () => Promise<void>;
}) {
  const client = useClient();
  const shell = useShellCapabilities();
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>();
  const execution = view.sections.execution;
  async function pick() {
    if (!shell?.chooseExecutablePath) {
      setPathDraft(execution.stored.codexBin ?? view.runtime.codexBin ?? "");
      return;
    }
    try {
      const selected = await shell.chooseExecutablePath();
      if (selected !== null) await savePath(selected);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法选择文件。"); }
  }
  async function savePath(path: string | null): Promise<boolean> {
    if (execution.access.kind === 'readonly') return false;
    try {
      const reply = await client.settings({
        type: "save",
        edit: {scope: view.scope, section: "execution", revision: execution.revision, patch: {codexBin: path}},
      });
      const message = errorText(reply) ?? (path === null ? "Codex 路径已恢复自动检测。" : "Codex 路径已保存，下次启动 daemon 时使用。");
      if (reply.kind === "saved" && reply.result.kind === "saved") {
        setPathDraft(null);
        await refresh();
        setNotice(message);
        return true;
      }
      if (reply.kind === "saved" && reply.result.kind === "conflict") await refresh();
      setNotice(message);
      return false;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Codex 路径保存失败。");
      return false;
    }
  }
  useDraft(pathDraft !== null, {title: 'Codex 可执行文件', save: () => pathDraft === null ? Promise.resolve(false) : savePath(pathDraft), discard: () => setPathDraft(null)});
  async function reset() {
    await savePath(null);
  }
  return (
    <SettingsGroup
      label="Codex 可执行文件"
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
        value={pathDraft ?? "尚未选择"}
        trailing={
          <Button
            size="sm"
            aria-label={shell?.chooseExecutablePath ? "选择 Codex 可执行文件" : "输入 Codex 可执行文件路径"}
            disabled={execution.access.kind === "readonly"}
            onClick={() => void pick()}
          >
            更改路径
          </Button>
        }
      />
      <div className="settings-edit-actions">
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
      <ActionNotice message={notice} />
      <Dialog open={pathDraft !== null} onClose={() => setPathDraft(null)} title="Codex 可执行文件路径" footer={<><Button onClick={() => setPathDraft(null)}>取消</Button><Button disabled={!pathDraft?.trim()} onClick={() => {if (pathDraft !== null) void savePath(pathDraft);}}>保存路径</Button></>}>
        <FormField label="绝对路径"><input aria-label="Codex 可执行文件绝对路径" value={pathDraft ?? ""} onChange={event => setPathDraft(event.target.value)} /></FormField>
      </Dialog>
    </SettingsGroup>
  );
}
/** The executable override is a host setting, presented with the Codex Provider. */
export async function readCodexPathView(client: Pick<VonvonClient, 'settings'>, signal?: AbortSignal, timeoutMs = 10000): Promise<HostSettingsView> {
  if (signal?.aborted) throw new Error('读取已取消。');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const reply = await Promise.race([
      client.settings({type: 'read', scope: {kind: 'host'}}),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('读取超时，请重新读取路径配置。')), timeoutMs);}),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('读取已取消。'));
        signal?.addEventListener('abort', onAbort, {once: true});
      }),
    ]);
    if (signal?.aborted) throw new Error('读取已取消。');
    if (reply.kind !== 'view' || !isHostView(reply.view)) throw new Error(reply.kind === 'refused' ? reply.message : '无法读取 Codex 路径配置。');
    return reply.view;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
export function CodexPathSettings() {
  const client = useClient();
  const [view, setView] = useState<HostSettingsView>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const activeRead = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    setLoading(true);
    setError('');
    try {
      const next = await readCodexPathView(client, controller.signal);
      if (!controller.signal.aborted) setView(next);
    } catch (failure) {if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法读取 Codex 路径配置。');}
    finally {if (!controller.signal.aborted) setLoading(false);}
  }, [client]);
  useEffect(() => {void refresh(); return () => activeRead.current?.abort();}, [refresh]);
  return <section id={settingAnchor('Codex 可执行文件')} aria-label="Codex 可执行文件">
    {view ? <CodexPathPanel view={view} refresh={refresh}/> : <SettingsGroup label="Codex 可执行文件"><SettingsRow title={loading ? '正在读取路径配置…' : '路径配置暂不可用'} /></SettingsGroup>}
    {error && view && <InlineNotice title="路径配置暂不可用" tone="warning">{error}</InlineNotice>}
    {error && !view && <InlineNotice title="路径配置暂不可用" tone="warning">{error}</InlineNotice>}
    <div className="provider-management-actions"><Button size="sm" disabled={loading} onClick={() => void refresh()}>重新读取路径配置</Button></div>
  </section>;
}
export function HostPanel({view}: {view: HostSettingsView}) {
  return <SettingsGroup label="运行后备" id={settingAnchor('运行后备')}><SettingsRow title="未绑定工作目录时的运行后备" value={view.runtime.fallbackCwd}/></SettingsGroup>;
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
  const client = useClient();
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
          client.settings({ type: "read", scope }),
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
    <SettingsGroup label="设置" action={<IconButton size="sm" variant="ghost" label="重新读取" title="重新读取" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}>
      {status ?? <SettingsRow title="正在读取当前设置…" />}
    </SettingsGroup>
  );
  const content = isAgentView(view) && props.scope === 'agent' ? (
    <AgentPanel view={view} refresh={refresh} />
  ) : isProjectView(view) && props.scope === 'project' ? (
    <ProjectPanel view={view} refresh={refresh} onOpenSecrets={props.onOpenSecrets} />
  ) : isHostView(view) ? (
    <HostPanel view={view} />
  ) : null;
  return (
    <>
      {props.scope !== "agent" && <div className="settings-scope-bar"><IconButton size="sm" variant="ghost" label="重新读取" title="重新读取" onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></div>}
      {status}
      {content}
    </>
  );
}
export function membershipSettingsTarget(member: Membership): ProjectScope {
  return { kind: "project", botId: member.agentId, projectName: member.name };
}
/** The group's settings are read once, on mount, and its 会话方式 decides whether 免@ shows (s25c): a switch on the
 * same page remounts them. */
export function membershipSettingsKey(member: Membership): string {
  return `project-${member.id}-${member.conversation}`;
}

export function groupJudgeVisible(view: ProjectSettingsView): boolean {
  return view.identity.kind === "smart" && Boolean(view.sections.judge);
}
