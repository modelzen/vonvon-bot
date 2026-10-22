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
    sections: {permission: section({mode:'full',guestMode:'full',network:false}), response:section({noMention:false}), model:section({selection:{kind:'default'}})},
    members: {openIds:['ou_saved_missing'], revision:'r', roster:{state:'partial',otherBots:true,entries:[{openId:'ou_bot_peer',name:'同名',kind:'bot'},{openId:'ou_person',name:'同名',kind:'person'}]}} };
}
const render = (v: ProjectSettingsView) => renderToStaticMarkup(<ClientProvider client={client}><ProjectPanel view={v} refresh={async()=>{}} /></ClientProvider>);
it('offers people and bots, distinguishes names and preserves absent saved members', () => {
  const html = render(view());
  expect(html).toContain('value="ou_bot_peer"'); expect(html).toContain('同名 · Bot · …t_peer');
  expect(html).toContain('value="ou_person"'); expect(html).toContain('同名 · …person');
  expect(html).toContain('未读取到名称 · …issing'); expect(html).toContain('已选成员保留');
});
it('keeps manual input for old daemons and disables the picker for readonly settings', () => {
  const v = view(); delete v.members.roster;
  expect(render(v)).toContain('成员 Open ID');
  v.sections.permission.access = {kind:'readonly',reason:'owner-offline',message:'offline'};
  expect(render(v)).toContain('aria-label="选择响应成员" disabled=""');
});
