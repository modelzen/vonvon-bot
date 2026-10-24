import {useCallback, useEffect, useRef, useState} from 'react';
import type {AgentId} from '@vonvon/protocol';
import {useClient} from './client-context';
import {MapInlineEditor, type MapInlineEditorSession} from './MapInlineEditor';
import type {MapEditStart, MapNode} from './MindMap';
import {useInlineDraft} from './settings/DraftGuard';

export type RoleScope = {kind: 'agent'; botId: AgentId} | {kind: 'project'; botId: AgentId; projectName: string};
export type RoleField = 'identity' | 'notes' | 'supplement';
type RoleData = {key: string; revision: string; fields: Partial<Record<RoleField, string>>; readonly?: string; draft?: string; notices: string[]};
type Edit = {key: string; field: RoleField; value: string; revision: string; point?: MapEditStart['point']};
const scopeKey = (scope?: RoleScope) => scope ? scope.kind === 'agent' ? `agent:${scope.botId}` : `project:${scope.botId}:${scope.projectName}` : '';
const errorText = (failure: unknown) => failure instanceof Error ? failure.message : '操作未完成，请重试。';

/** A single role editing session shared by the Bot and project map. The DOM owns its draft until save succeeds. */
export function useRoleMap(scope?: RoleScope) {
  const client = useClient();
  const key = scopeKey(scope);
  const session = useRef<MapInlineEditorSession | null>(null);
  const savedSession = useRef<MapInlineEditorSession | null>(null);
  const [role, setRole] = useState<RoleData>();
  const [editing, setEditing] = useState<Edit>();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{key: string; revision: string; fields: Partial<Record<RoleField, string>>}>();
  const [busy, setBusy] = useState(false);
  const serial = useRef(0);
  const reload = useCallback(async () => {
    if (!scope) return;
    const request = ++serial.current;
    try {
      const reply = await client.settings({type: 'read', scope});
      if (request !== serial.current) return;
      if (reply.kind !== 'view') throw new Error(reply.kind === 'refused' ? reply.message : '角色设定暂时读不到。');
      const view = reply.view;
      if (scope.kind === 'agent' && 'administrators' in view && view.scope.botId === scope.botId) {
        const section = view.sections.role;
        if (!section) throw new Error('这份角色设定暂不可用。');
        const notices = [
          view.roleInfo?.mergedNotice ? '原来 AGENTS.md 里的内容已并到「其他说明」末尾。' : '',
          view.roleInfo?.oversized ? '这份角色设定比现在的上限长，下次修改时请精简。' : '',
          view.roleInfo?.integrity === 'changed' ? '角色设定文件在应用之外改过。' : '',
        ].filter(Boolean);
        setRole({key, revision: section.revision, fields: {identity: section.stored.identity, notes: section.stored.notes},
          readonly: section.access.kind === 'readonly' ? section.access.message : undefined, draft: view.roleInfo?.draft, notices});
      } else if (scope.kind === 'project' && 'members' in view && view.scope.botId === scope.botId && view.scope.projectName === scope.projectName) {
        const section = view.sections.role;
        if (!section) throw new Error('这份角色设定暂不可用。');
        setRole({key, revision: section.revision, fields: {supplement: section.stored.supplement},
          readonly: section.access.kind === 'readonly' ? section.access.message : undefined, notices: []});
      } else throw new Error('角色设定身份与当前选择不一致。');
      setError('');
    } catch (failure) {if (request === serial.current) setError(errorText(failure));}
  }, [client, scope?.kind, scope?.botId, scope?.kind === 'project' ? scope.projectName : '', key]);
  useEffect(() => {setRole(undefined); setError(''); void reload(); return () => {serial.current++;};}, [reload]);

  const withSavedDraft = useCallback((action: () => void) => {
    const active = session.current;
    if (!active) {savedSession.current = null; action(); return;}
    if (savedSession.current === active) {action(); return;}
    void active.commit().then(ok => {if (ok) {savedSession.current = active; action();} else active.focus();}).catch(failure => {setError(errorText(failure)); active.focus();});
  }, []);
  useInlineDraft(Boolean(editing?.key === key), async () => {
    const active = session.current;
    if (!active) return false;
    const ok = await active.commit();
    if (!ok) active.focus();
    return ok;
  });
  const beginEdit = useCallback((field: RoleField, start?: MapEditStart) => {
    if (!role || role.key !== key || role.readonly || role.fields[field] === undefined) return;
    const value = start?.text ?? (field === 'identity' && role.draft !== undefined ? role.draft : role.fields[field]!);
    setEditing({key, field, value, revision: role.revision, point: start?.point});
    setError('');
  }, [role, key]);
  const commit = useCallback(async (edit: Edit, text: string) => {
    if (!scope || edit.key !== key || busy) return false;
    const limit = edit.field === 'identity' ? 500 : edit.field === 'supplement' ? 5_000 : 8_000;
    if ([...text].length > limit) {setError(`${edit.field === 'supplement' ? '本群角色' : edit.field === 'identity' ? '身份与职责' : '其他说明'}最多 ${limit} 字。`); return false;}
    if (text === role?.fields[edit.field] && !conflict && !(edit.field === 'identity' && role.draft !== undefined)) {
      setEditing(current => current === edit ? undefined : current); setError(''); return true;
    }
    setBusy(true); setError('');
    try {
      const reply = await client.settings({type: 'save', edit: {scope, section: 'role', patch: {[edit.field]: text}, revision: edit.revision}});
      if (reply.kind === 'saved' && reply.result.kind === 'saved') {
        const revision = reply.result.section.value.revision;
        setConflict(undefined);
        setRole(current => current?.key === key ? {...current, revision,
          fields: {...current.fields, [edit.field]: text}, draft: edit.field === 'identity' ? undefined : current.draft} : current);
        setEditing(current => current === edit ? undefined : current);
        void reload();
        return true;
      }
      if (reply.kind === 'saved' && reply.result.kind === 'conflict') {
        const latest = reply.result.current.value;
        const stored = latest.stored as Partial<Record<RoleField, string>> | undefined;
        setConflict({key, revision: latest.revision, fields: stored ?? {}});
      }
      const message = reply.kind === 'refused' ? reply.message : reply.kind === 'saved' && reply.result.kind === 'rejected'
        ? reply.result.fields.map(field => `${field.field}：${field.message}`).join('；')
        : reply.kind === 'saved' && reply.result.kind === 'unavailable' && reply.result.reason.kind === 'readonly' ? reply.result.reason.message
        : reply.kind === 'saved' && reply.result.kind === 'conflict' ? '角色设定已在别处更改。下方是最新内容，草稿已保留。' : '角色设定没有保存。';
      setError(message); return false;
    } catch (failure) {setError(errorText(failure)); return false;}
    finally {setBusy(false);}
  }, [client, scope, key, busy, role, reload, conflict]);
  const content = (field: RoleField, id: string) => editing?.key === key && editing.field === field
    ? <MapInlineEditor key={`${key}:${id}`} value={editing.value} label={field === 'supplement' ? '本群角色' : field === 'identity' ? '身份与职责' : '其他说明'} busy={busy} point={editing.point}
      session={session} onCommit={text => commit(editing, text)}/>
    : undefined;
  const statusNodes: MapNode[] = [
    ...(!role || role.key !== key ? !error && scope ? [{id: `role-status:${key}`, kind: 'leaf' as const, label: '正在读取角色设定…', tone: 'muted' as const}] : [] : []),
    ...(role?.key === key && role.readonly ? [{id: `role-readonly:${key}`, kind: 'leaf' as const, label: role.readonly, tone: 'muted' as const}] : []),
    ...(role?.key === key ? role.notices.map((notice, index) => ({id: `role-notice:${key}:${index}`, kind: 'leaf' as const, label: notice, tone: 'muted' as const})) : []),
    ...(error ? [{id: `role-error:${key}`, kind: 'leaf' as const, label: error, tone: 'pending' as const, menu: [{id: 'retry', label: '重新读取', onSelect: () => void reload()}]}] : []),
    ...(error && editing?.key === key ? [{id: `role-discard:${key}`, kind: 'action' as const, label: '放弃草稿并重新读取',
      content: <button type="button" className="mm-label" onPointerDown={event => event.preventDefault()} onClick={event => {
        event.stopPropagation(); setEditing(undefined); setConflict(undefined); setError(''); void reload();
      }}>放弃草稿并重新读取</button>}] : []),
    ...(conflict?.key === key ? Object.entries(conflict.fields).map(([field, value]) => ({id: `role-latest:${key}:${field}`, kind: 'leaf' as const, label: `最新${field === 'identity' ? '身份与职责' : field === 'notes' ? '其他说明' : '本群角色'}：${value || '尚未填写'}`, tone: 'muted' as const})) : []),
    ...(conflict?.key === key ? [{id: `role-conflict-action:${key}`, kind: 'action' as const, label: '保留草稿，采用最新版本重试',
      content: <button type="button" className="mm-label" onPointerDown={event => event.preventDefault()} onClick={event => {
        event.stopPropagation();
        setEditing(current => current?.key === key ? {...current, revision: conflict.revision} : current);
        setConflict(undefined); setError('');
      }}>保留草稿，采用最新版本重试</button>} ] : []),
  ];
  return {role: role?.key === key ? role : undefined, editing, error, busy, withSavedDraft, beginEdit, content, statusNodes, reload,
    clear: () => setEditing(undefined)};
}
