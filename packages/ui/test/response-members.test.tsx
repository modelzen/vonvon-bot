import {permissionValue} from './permission-fixture';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentIdSchema, type ProjectSettingsView } from '@vonvon/protocol';
import { createClient } from '../../client/src/client';
import { ClientProvider } from '../src/client-context';
import { ProjectPanel } from '../src/settings/SettingsPanel';
const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const section = <const T,>(stored: T) => ({ stored, effective: stored, revision: 'r', access: { kind: 'writable' as const }, apply: [] });
function view(): ProjectSettingsView {
  return { scope: {kind: 'project', botId: agentIdSchema.parse('cli_fixture'), projectName: 'demo'},
    identity: {chatId:'oc_fixture', backend:'codex-appserver', cwd:'/fixture', kind:'smart'},
    sections: {permission: section(permissionValue()), response:section({noMention:false}), model:section({selection:{kind:'default'}})},
    members: {openIds:['ou_saved_missing'], revision:'r', roster:{state:'partial',otherBots:true,entries:[{openId:'ou_bot_peer',name:'同名',kind:'bot'},{openId:'ou_person',name:'同名',kind:'person'}]}} };
}
const render = (v: ProjectSettingsView) => renderToStaticMarkup(<ClientProvider client={client}><ProjectPanel view={v} refresh={async()=>{}} /></ClientProvider>);
it('shows saved members and a picker action instead of an inline Open ID form', () => {
  const html = render(view());
  expect(html).toContain('回应谁');
  expect(html).toContain('aria-label="指定成员"');
  expect(html).toContain('…issing');
  expect(html).not.toContain('成员 Open ID');
  expect(html).toContain('恢复所有成员');
});
it('keeps saved members for old daemons and disables the picker for readonly settings', () => {
  const v = view(); delete v.members.roster;
  expect(render(v)).toContain('…issing');
  v.sections.permission.access = {kind:'readonly',reason:'owner-offline',message:'offline'};
  expect(render(v)).toMatch(/aria-label="指定成员"[^>]*disabled=""/);
});
