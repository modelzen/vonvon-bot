/** Heading syntax is presentation only; the complete text is the judge's rule document. */
export function smartRulesMarkup(text: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
  return text.split('\n').map(line => {
    const heading = /^## (.*)$/.exec(line);
    if (!heading) return `<div>${escape(line) || '<br>'}</div>`;
    return `<div><span class="smart-rule-heading" data-rule-heading><span data-rule-label>${escape(heading[1]!)}</span><button type="button" contenteditable="false" data-remove-heading aria-label="删除小标题" title="删除小标题，保留正文">×</button></span></div>`;
  }).join('');
}

/** Read browser editing DOM, including Enter's divs and Shift+Enter's brs, without UI controls. */
export function smartRulesTextFromDom(root: Node, markdown = true, normalizeCaret = true): string {
  const children = Array.from(root.childNodes);
  let result = children.reduce((text, node, index) => {
    if (node.nodeType === 3) return text + (node.textContent ?? '');
    if (node.nodeType !== 1) return text;
    const element = node as HTMLElement;
    if (element.hasAttribute('data-remove-heading')) return text;
    if (element.hasAttribute('data-rule-heading')) {
      return text + (markdown ? '## ' : '') + smartRulesTextFromDom(element, false, normalizeCaret);
    }
    if (element.tagName === 'BR') {
      const emptyBlock = children.length === 1 && root.nodeType === 1 && /^(DIV|P)$/.test((root as Element).tagName);
      return text + (emptyBlock || normalizeCaret && index === children.length - 1 ? '' : '\n');
    }
    const block = /^(DIV|P|LI|H[1-6])$/.test(element.tagName);
    if (block && text && !text.endsWith('\n')) text += '\n';
    text += smartRulesTextFromDom(element, markdown, normalizeCaret);
    if (block && index < children.length - 1) text += '\n';
    return text;
  }, '');
  // Chromium can split the terminal Shift+Enter caret placeholder across adjacent text nodes.
  let trailingText = '';
  for (let index = children.length - 1; index >= 0 && children[index]!.nodeType === 3; index--) trailingText = children[index]!.textContent + trailingText;
  if (normalizeCaret && root.nodeType === 1 && trailingText.endsWith('\n\n')) result = result.slice(0, -1);
  return result;
}
