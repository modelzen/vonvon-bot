import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AgentSettingsView} from '@vonvon/protocol';
import {AdministratorRows, CandidateRows} from '../src/management/AdministratorsPanel';

const view = (openIds: string[], names: Record<string, string> = {}) => ({
  ownerOpenId: 'ou_creator',
  administrators: {openIds, names, candidates: [], revision: 'r1'},
}) as unknown as AgentSettingsView;

// A1 left the creator and the people Feishu names without a remove button; the page now treats everyone alike
it('lets anyone be removed while another stays, the creator included, and labels the creator', () => {
  const html = renderToStaticMarkup(<AdministratorRows view={view(['ou_creator', 'ou_second'], {ou_creator: '李四', ou_second: '张三'})} busy={false} onRemove={() => {}}/>);
  expect(html).toContain('李四');
  expect(html).toContain('张三');
  expect(html.match(/创建者/g)).toHaveLength(1);
  expect(html).toContain('aria-label="移除 李四"');
  expect(html).toContain('aria-label="移除 张三"');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain('风险');
});

it('keeps the last administrator from being removed and says why', () => {
  const html = renderToStaticMarkup(<AdministratorRows view={view(['ou_only'], {ou_only: '王五'})} busy={false} onRemove={() => {}}/>);
  expect(html).toContain('disabled=""');
  expect(html).toContain('至少要有一个管理员。');
});

it('shows a name Feishu would not give as the tail of the id, and asks for the first administrator when there is none', () => {
  expect(renderToStaticMarkup(<AdministratorRows view={view(['ou_abcdef123456'])} busy={false} onRemove={() => {}}/>)).toContain('…123456');
  expect(renderToStaticMarkup(<AdministratorRows view={view([])} busy={false} onRemove={() => {}}/>)).toContain('这个 Bot 还没有管理员');
});

it('disables removal when the Bot is not running, and while a change is going through', () => {
  expect(renderToStaticMarkup(<AdministratorRows view={view(['ou_a', 'ou_b'])} readonly="这个 Bot 没在运行" busy={false} onRemove={() => {}}/>)).toContain('title="这个 Bot 没在运行"');
  expect(renderToStaticMarkup(<AdministratorRows view={view(['ou_a', 'ou_b'])} busy onRemove={() => {}}/>).match(/disabled=""/g)).toHaveLength(2);
});

it('lists the candidates with where each comes from, and no field for an Open ID', () => {
  const html = renderToStaticMarkup(<CandidateRows busy={false} total={3} onPick={() => {}} candidates={[
    {openId: 'ou_c', name: '创建者', sources: ['creator']},
    {openId: 'ou_f', name: '赵六', sources: ['feishu', 'refused'], at: 1},
  ]}/>);
  expect(html).toContain('<span class="admin-source">创建者</span>');
  expect(html).toContain('飞书应用成员 · 私聊被拒');
  expect(html).toContain('aria-label="添加 赵六"');
  expect(html).not.toContain('Open ID');
});

it('says so when there is no candidate or none matches the search', () => {
  expect(renderToStaticMarkup(<CandidateRows busy={false} total={0} onPick={() => {}} candidates={[]}/>)).toContain('没有候选人');
  expect(renderToStaticMarkup(<CandidateRows busy={false} total={2} onPick={() => {}} candidates={[]}/>)).toContain('没有匹配的人');
});
