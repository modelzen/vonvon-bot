import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {MachineRequestHandler} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {UpdatePanel} from '../src/management/UpdatePanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});
const request: MachineRequestHandler = async () => { throw new Error('Unexpected machine request'); };
const render = (externalCoreAvailable: boolean, attached = false) => renderToStaticMarkup(
  <ClientProvider client={client}>
    <DraftGuardProvider>
      <UpdatePanel request={request} attached={attached} externalCoreAvailable={externalCoreAvailable}
        version="0.7.14" device="这台 Mac" advancedSettings={<p>测试高级运行选项</p>}>
        <p>测试启动选项</p>
      </UpdatePanel>
    </DraftGuardProvider>
  </ClientProvider>,
);

it('shows the installed desktop version before checking for updates', () => {
  const html = render(false);
  expect(html).toContain('0.7.14');
  expect(html).toContain('这台 Mac');
  expect(html).toContain('尚未检查');
  expect(html).toContain('检查更新');
  expect(html).toContain('测试启动选项');
  expect(html).toContain('测试高级运行选项');
});

it.each([false, true])('hides external Core controls without installation support, even with attached=%s', attached => {
  const html = render(false, attached);
  for (const label of ['外部 Core / CLI', 'Core 来源', '检查 Core 更新', '更新外部 Core', '查看 Core 更新进度']) {
    expect(html).not.toContain(label);
  }
});

it('keeps external Core controls available when the installation supports them', () => {
  const html = render(true, true);
  expect(html).toContain('外部 Core / CLI');
  expect(html).toContain('检查 Core 更新');
  expect(html).toContain('更新外部 Core');
  expect(html).toContain('查看 Core 更新进度');
});
