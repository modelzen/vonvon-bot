import {useLayoutEffect, useRef, useState} from 'react';
import type {MapEditStart} from './MindMap';

/** Own the DOM draft for this edit session: polling must never replace what the user is typing. */
export function MapInlineEditor({value, label = '编辑节点', busy = false, point, onCommit, onCancel, cancelWhenEmpty = false}: {
  value: string; label?: string; busy?: boolean; point?: MapEditStart['point'];
  onCommit: (text: string) => Promise<boolean> | boolean; onCancel?: () => void; cancelWhenEmpty?: boolean;
}) {
  const initial = useRef(value);
  const editor = useRef<HTMLSpanElement>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
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
    if (!saving && !busy && restoreFocus.current) {restoreFocus.current = false; editor.current?.focus({preventScroll: true});}
  }, [saving, busy]);
  async function commit(fromKeyboard = false) {
    if (busy || submitting.current || composing.current) return;
    const text = editor.current?.innerText ?? initial.current;
    if (!text.trim() && cancelWhenEmpty && onCancel) {onCancel(); return;}
    restoreFocus.current = fromKeyboard;
    submitting.current = true; setSaving(true);
    try {if (await onCommit(text)) restoreFocus.current = false;}
    finally {submitting.current = false; if (mounted.current) setSaving(false);}
  }
  return <span ref={editor} className="mm-inline-editor" role="textbox" aria-label={label} aria-multiline="true"
    aria-busy={busy || saving || undefined} contentEditable={busy || saving ? false : 'plaintext-only'} suppressContentEditableWarning
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing) return;
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Escape') {event.preventDefault(); void commit(true);}
    }} onBlur={() => {void commit();}}>{initial.current}</span>;
}
