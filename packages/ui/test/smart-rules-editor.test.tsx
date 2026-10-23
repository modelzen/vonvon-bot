import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {DEFAULT_SMART_RULES_TEXT} from '@vonvon/protocol';
import {SmartRulesEditor} from '../src/settings/SmartRulesEditor';
import {smartRulesMarkup, smartRulesTextFromDom} from '../src/settings/smart-rules-editor';

// The serialization boundary accepts browser-generated mixed text/div/br trees, not HTML strings.
const text = (value: string): Node => ({nodeType: 3, textContent: value} as Node);
const element = (tagName: string, childNodes: Node[], attrs: string[] = []): Node => ({nodeType: 1, tagName, childNodes, hasAttribute: (key: string) => attrs.includes(key)} as unknown as Node);
const root = (...children: Node[]) => element('DIV', children);
const line = (...children: Node[]) => element('DIV', children);
const br = () => element('BR', []);

it('escapes custom text and heading labels instead of accepting pasted markup', () => {
  const html = smartRulesMarkup('## <img src=x onerror=alert(1)>\n<script>alert(2)</script>');
  expect(html).not.toContain('<img'); expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;');
  expect(html.match(/data-rule-heading/g)).toHaveLength(1);
});
it('preserves blank lines, trailing Enter and Shift+Enter without adding blank paragraphs', () => {
  expect(smartRulesTextFromDom(root(line(text('第一段')), line(br()), line(text('第二段')), line(br())))).toBe('第一段\n\n第二段\n');
  expect(smartRulesTextFromDom(root(text('开始'), line(text('续写'), br(), text('换行'))))).toBe('开始\n续写\n换行');
  expect(smartRulesTextFromDom(root(line(br())))).toBe('');
  expect(smartRulesTextFromDom(root(line(text('软换行\n\n'))))).toBe('软换行\n');
  expect(smartRulesTextFromDom(root(line(text('软换行'), br(), br())))).toBe('软换行\n');
  expect(smartRulesTextFromDom(root(line(text('软换行\n\n\n'))))).toBe('软换行\n\n');
  expect(smartRulesTextFromDom(root(line(text('软换行'), text('\n'), text('\n'))))).toBe('软换行\n');
});
it('keeps renamed headings in saved rules, excludes controls from save/copy and leaves body after removal', () => {
  const label = element('SPAN', [text('只处理研发问题：')], ['data-rule-label']);
  const button = element('BUTTON', [text('×')], ['data-remove-heading']);
  const heading = element('SPAN', [label, button], ['data-rule-heading']);
  expect(smartRulesTextFromDom(root(line(heading), line(text('规则正文'))))).toBe('## 只处理研发问题：\n规则正文');
  expect(smartRulesTextFromDom(root(line(heading), line(text('规则正文'))), false)).toBe('只处理研发问题：\n规则正文');
  expect(smartRulesTextFromDom(root(line(br()), line(text('规则正文'))))).toBe('\n规则正文');
});
it('keeps selected terminal newlines when copying a range rather than serializing the full editor', () => {
  expect(smartRulesTextFromDom(root(text('选中的行'), br()), false, false)).toBe('选中的行\n');
  expect(smartRulesTextFromDom(root(text('选中的行\n\n')), false, false)).toBe('选中的行\n\n');
  expect(smartRulesTextFromDom(root(line(text('第一段')), line(br()), line(text('第二段'))), false, false)).toBe('第一段\n\n第二段');
});
it('renders one labeled writing surface with four headings and readonly guidance', () => {
  const html = renderToStaticMarkup(<SmartRulesEditor value={DEFAULT_SMART_RULES_TEXT} onChange={() => {}}/>);
  expect(html.match(/data-remove-heading/g)).toHaveLength(4);
  expect(html.match(/role="textbox"/g)).toHaveLength(1);
  expect(html).toContain('aria-multiline="true"');
  expect(html).toContain('× 只删除小标题');
  expect(html).toContain('话题内只判断是否回应');
});
it('keeps empty user rules empty instead of displaying the default as their content', () => {
  const html = renderToStaticMarkup(<SmartRulesEditor value="" onChange={() => {}} disabled/>);
  expect(html).not.toContain('data-rule-heading');
  expect(html).toContain('data-empty="true"');
  expect(html).toContain('contentEditable="false"');
});
