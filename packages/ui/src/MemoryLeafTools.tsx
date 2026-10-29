import {Check, ChevronUp, Info, Pencil, Trash2, Undo2} from 'lucide-react';
import type {MemoryEvent, MemoryItem} from '@vonvon/protocol';
import {Button, IconButton} from './reference/components/ui';

/** Only undo the event that produced this exact revision, never another item's latest change. */
export function undoEventFor(events: readonly MemoryEvent[], item: MemoryItem, kind: 'confirm' | 'archive'): string | undefined {
  return [...events].reverse().find(event => event.kind === kind && event.itemId === item.id
    && event.after?.revision === item.revision && !event.undoOf)?.eventId;
}

// Intent: read and act on one memory without leaving its node. Existing Mac controls,
// semantic status colors and a compact 4px rhythm keep the text above its actions.
export function MemoryLeafTools({busy, reference, editing, undo, source, sourceOpen, onConfirm, onEdit, onDelete, onSource, onCollapse, onSave, onCancel}: {
  busy: boolean; reference: boolean; editing: boolean;
  undo?: {label: string; run?: () => void}; source: string[]; sourceOpen: boolean;
  onConfirm?: () => void; onEdit: () => void; onDelete: () => void; onSource: () => void; onCollapse: () => void;
  onSave: () => void; onCancel: () => void;
}) {
  if (editing) return <div className="mm-leaf-tools" onPointerDown={event => event.preventDefault()}>
    <Button type="button" size="sm" variant="primary" disabled={busy} onClick={onSave}>保存</Button>
    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
  </div>;
  return <>
    <div className="mm-leaf-tools" aria-label="记忆操作">
      {reference && onConfirm && <Button type="button" size="sm" variant="primary" icon={<Check size={13} aria-hidden="true"/>} disabled={busy} onClick={onConfirm}>设为可信</Button>}
      {undo && <><span className="mm-leaf-result" role="status"><Check size={13} aria-hidden="true"/>{undo.label}</span><Button type="button" size="sm" variant="ghost" disabled={busy || !undo.run} icon={<Undo2 size={13} aria-hidden="true"/>} onClick={undo.run}>撤销</Button></>}
      <Button type="button" size="sm" variant="ghost" disabled={busy} icon={<Pencil size={13} aria-hidden="true"/>} onClick={onEdit}>编辑</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} icon={<Trash2 size={13} aria-hidden="true"/>} onClick={onDelete}>删除</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} aria-expanded={sourceOpen} icon={<Info size={13} aria-hidden="true"/>} onClick={onSource}>来源</Button>
      <IconButton type="button" label="收起记忆操作" size="sm" variant="ghost" disabled={busy} onClick={onCollapse}><ChevronUp size={13} aria-hidden="true"/></IconButton>
    </div>
    {reference && <p className="mm-leaf-note">已保存 · 设为可信后，可用于行动与回复判断。</p>}
    {sourceOpen && <div className="mm-leaf-source">{source.map((line, at) => <p key={at}>{line}</p>)}</div>}
  </>;
}
