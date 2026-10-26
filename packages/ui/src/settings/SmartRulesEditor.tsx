import {useEffect, useId, useRef, type ClipboardEvent, type KeyboardEvent} from 'react';
import {ChevronDown, ChevronUp} from 'lucide-react';
import {DEFAULT_SMART_RULES_TEXT} from '@vonvon/protocol';
import {smartRulesMarkup, smartRulesTextFromDom} from './smart-rules-editor';
import './smart-rules-editor.css';

export const SMART_RULES_MAX_LENGTH = 30000;

/** The browser owns the live editing DOM so React updates do not move the caret or interrupt IME. */
export function SmartRulesEditor({value, onChange, disabled = false, expanded, onExpandedChange}: {value: string; onChange: (text: string) => void; disabled?: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void}) {
  const id = useId();
  const sizeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Keep the bottom control reachable after the full writing surface shrinks.
    if (!expanded && document.activeElement === sizeButton.current) sizeButton.current?.scrollIntoView({block: 'nearest', behavior: 'instant'});
  }, [expanded]);
  const editor = useRef<HTMLDivElement>(null);
  const initial = useRef({__html: smartRulesMarkup(value)});
  const current = useRef(value);
  const composing = useRef(false);
  useEffect(() => {
    if (editor.current && value !== current.current && !composing.current) {
      editor.current.innerHTML = smartRulesMarkup(value);
      current.current = value;
    }
    editor.current?.querySelectorAll<HTMLButtonElement>('[data-remove-heading]').forEach(button => {button.disabled = disabled;});
  }, [value, disabled]);
  function publish() {
    if (!editor.current) return;
    current.current = smartRulesTextFromDom(editor.current);
    onChange(current.current);
  }
  function select(node: Node) {
    const range = document.createRange();
    range.selectNode(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  function removeHeading(button: HTMLButtonElement) {
    const heading = button.closest('[data-rule-heading]');
    if (!heading || disabled) return;
    editor.current?.focus();
    select(heading);
    // Native editing commands retain the undo transaction, unlike removeChild/innerHTML.
    document.execCommand('delete');
    publish();
  }
  function restore() {
    if (!editor.current || disabled) return;
    editor.current.focus();
    const range = document.createRange();
    range.selectNodeContents(editor.current);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    document.execCommand('insertHTML', false, smartRulesMarkup(DEFAULT_SMART_RULES_TEXT));
    publish();
  }
  function copy(event: ClipboardEvent<HTMLDivElement>, cut = false) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const fragment = selection.getRangeAt(0).cloneContents();
    event.clipboardData.setData('text/plain', smartRulesTextFromDom(fragment, false, false));
    event.preventDefault();
    if (cut && !disabled) {document.execCommand('delete'); publish();}
  }
  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled) return;
    let text = event.clipboardData.getData('text/plain');
    const selection = window.getSelection();
    const [startHeading, endHeading] = [selection?.anchorNode, selection?.focusNode].map(node =>
      (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest('[data-rule-heading]'));
    // Headings are a single line. Native multiline paste inside a span would clone the chip.
    if (startHeading && startHeading === endHeading) text = text.replace(/\r\n|\r|\n/g, ' ');
    document.execCommand('insertText', false, text);
    publish();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.nativeEvent.isComposing) return;
    // Formatting shortcuts must not silently change the plain-text rules.
    if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) event.preventDefault();
    if (event.key !== 'Enter') return;
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const heading = (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest('[data-rule-heading]');
    if (!heading || !editor.current?.contains(heading)) return;
    event.preventDefault();
    // Enter leaves the heading; it must not duplicate its chip/delete button on the next line.
    const range = document.createRange(); range.setStartAfter(heading); range.collapse(true);
    selection?.removeAllRanges(); selection?.addRange(range);
    document.execCommand('insertParagraph');
    publish();
  }
  const tooLong = value.length > SMART_RULES_MAX_LENGTH;
  return <div className="smart-rules-field" data-expanded={expanded || undefined}>
    <div className="smart-rules-toolbar">
      <p id={`${id}-help`} className="gd-note">直接修改正文和小标题，× 只删除小标题。</p>
      <button type="button" className="gd-text-action" disabled={disabled || value === DEFAULT_SMART_RULES_TEXT} onClick={restore}>恢复默认</button>
    </div>
    <div className="smart-rules-surface">
      <div id={`${id}-editor`} ref={editor} className="smart-rules-input" role="textbox" aria-label="判断规则" aria-multiline="true"
        aria-describedby={`${id}-help ${id}-constraint`} aria-disabled={disabled} aria-invalid={tooLong || undefined}
        contentEditable={!disabled} suppressContentEditableWarning tabIndex={0} data-empty={!value || undefined}
        data-placeholder="写下你的判断规则，也可以恢复默认后修改…" dangerouslySetInnerHTML={initial.current}
        onInput={() => {if (!composing.current) publish();}}
        onCompositionStart={() => {composing.current = true;}}
        onCompositionEnd={() => {composing.current = false; publish();}}
        onKeyDown={keyDown}
        onMouseDown={event => {if ((event.target as Element).closest('[data-remove-heading]')) event.preventDefault();}}
        onClick={event => {const button = (event.target as Element).closest<HTMLButtonElement>('[data-remove-heading]'); if (button) removeHeading(button);}}
        onCopy={event => copy(event)} onCut={event => copy(event, true)}
        onPaste={paste}
        onDrop={event => event.preventDefault()}/>
      <button ref={sizeButton} type="button" className="smart-rules-size-button" aria-expanded={expanded} aria-controls={`${id}-editor`} aria-label={expanded ? '缩小规则窗口' : '展开规则窗口'} onClick={() => onExpandedChange(!expanded)}>{expanded ? '收起规则' : '展开全部规则'}{expanded ? <ChevronUp size={13} strokeWidth={1.6} aria-hidden="true"/> : <ChevronDown size={13} strokeWidth={1.6} aria-hidden="true"/>}</button>
    </div>
    <div className="smart-rules-footer">
      <p id={`${id}-constraint`} className="gd-note">话题内只判断是否回应，需要回应时留在当前话题。保存后，下次判断生效。</p>
      {tooLong && <p className="gd-note" role="alert">规则超过 {SMART_RULES_MAX_LENGTH} 字，请缩短后保存。</p>}
    </div>
  </div>;
}
