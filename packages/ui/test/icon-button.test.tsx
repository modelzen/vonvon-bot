import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {RefreshCw} from 'lucide-react';
import {IconButton} from '../src/reference/components/ui';

it('keeps the refresh action named and prevents duplicate clicks while loading', () => {
  const html = renderToStaticMarkup(<IconButton label="重新读取" title="重新读取当前设置" loading disabled={false}>
    <RefreshCw aria-hidden="true"/>
  </IconButton>);
  expect(html).toContain('aria-label="重新读取"');
  expect(html).toContain('title="重新读取当前设置"');
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('ui-button__spinner');
  expect(html).not.toContain('lucide-refresh-cw');
  expect(html).not.toMatch(/\sloading=/);
});

it('restores the action icon after loading and still respects caller-disabled state', () => {
  const ready = renderToStaticMarkup(<IconButton label="重新读取" loading={false}><RefreshCw aria-hidden="true"/></IconButton>);
  expect(ready).toContain('lucide-refresh-cw');
  expect(ready).not.toContain('disabled=""');
  expect(ready).not.toContain('aria-busy');
  expect(ready).not.toContain('ui-button__spinner');
  const disabled = renderToStaticMarkup(<IconButton label="重新读取" disabled loading={false}><RefreshCw/></IconButton>);
  expect(disabled).toContain('disabled=""');
  expect(disabled).toContain('aria-label="重新读取"');
});
