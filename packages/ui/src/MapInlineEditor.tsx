import {useLayoutEffect, useRef, useState, type RefObject} from 'react';
import type {MapEditStart} from './MindMap';

export type MapInlineEditorSession = {commit: () => Promise<boolean>; focus: () => void};

/** Own the DOM draft for this edit session: polling must never replace what the user is typing. */
export function MapInlineEditor({value, label = '编辑节点', busy = false, point, onCommit, onCancel, cancelWhenEmpty = false, session}: {
  value: string; label?: string; busy?: boolean; point?: MapEditStart['point'];
  onCommit: (text: string) => Promise<boolean> | boolean; onCancel?: () => void; cancelWhenEmpty?: boolean;
  session?: RefObject<MapInlineEditorSession | null>;
}) {
  const initial = useRef(value);
  const sessionHandle = useRef<MapInlineEditorSession | null>(null);
  const editor = useRef<HTMLSpanElement>(null);
  const submitting = useRef<Promise<boolean> | null>(null);
  const composing = useRef(false);
  const pendingBlur = useRef(false);
  const mounted = useRef(true);
  const restoreFocus = useRef(false);
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    mounted.current = true;
    const element = editor.current;
    if (element) {
      element.focus({preventScroll: true});
      const selection = window.getSelection();
      const documentWithCaret = document as Document & {caretRangeFromPoint?: (x: number, y: number) => Range | null};
      const clicked = point && documentWithCaret.caretRangeFromPoint?.(point.x, point.y);
      const range = clicked && element.contains(clicked.startContainer) ? clicked : document.createRange();
      if (range !== clicked) {range.selectNodeContents(element); range.collapse(false);}
      selection?.removeAllRanges(); selection?.addRange(range);
    }
    return () => {mounted.current = false;};
  }, []);
  useLayoutEffect(() => {
    if (!session) return;
    const handle = sessionHandle.current ??= {commit: () => commit(), focus: () => editor.current?.focus({preventScroll: true})};
    handle.commit = () => commit();
    session.current = handle;
    return () => {if (session.current === handle) session.current = null;};
  });
  useLayoutEffect(() => {
    if (!saving && !busy && restoreFocus.current) {restoreFocus.current = false; editor.current?.focus({preventScroll: true});}
  }, [saving, busy]);
  async function commit(fromKeyboard = false): Promise<boolean> {
    if (submitting.current) return submitting.current;
    if (busy || composing.current) return false;
    const text = editor.current?.innerText ?? initial.current;
    if (!text.trim() && cancelWhenEmpty && onCancel) {onCancel(); return true;}
    restoreFocus.current = fromKeyboard;
    setSaving(true);
    const pending = Promise.resolve().then(() => onCommit(text));
    submitting.current = pending;
    try {const ok = await pending; if (ok) restoreFocus.current = false; return ok;}
    finally {submitting.current = null; if (mounted.current) setSaving(false);}
  }
  return <span ref={editor} className="mm-inline-editor" role="textbox" aria-label={label} aria-multiline="true"
    aria-busy={busy || saving || undefined} contentEditable={busy || saving ? false : 'plaintext-only'} suppressContentEditableWarning
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onCompositionStart={() => {composing.current = true;}}
    onCompositionEnd={() => {composing.current = false; if (pendingBlur.current) {pendingBlur.current = false; void commit();}}}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing) return;
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Escape') {event.preventDefault(); void commit(true);}
    }} onBlur={() => {if (composing.current) pendingBlur.current = true; else void commit();}}>{initial.current}</span>;
}
