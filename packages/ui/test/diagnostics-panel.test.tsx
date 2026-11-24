import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {formatTime, type AdminSetupStatus, type Agent, type ApplicationCrashes, type DesktopSnapshot, type NotReplied, type ToolState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {crashBars, DiagnosticsPanel, scopeView, setupView, toolScopeView} from '../src/management/DiagnosticsPanel';
import {diagnosticsSection, findEntries, searchEntries, settingAnchor} from '../src/search';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const agent: Agent = {id: 'cli_diag' as Agent['id'], name: '值班助手', enabled: true, running: true, connection: 'connected', activation: 'active'};
const now = Date.now();
const record = (fields: Partial<NotReplied>): NotReplied => ({at: now, count: 1, groupId: 'oc_bound_group', place: 'main', reason: 'unbound', ref: 'a1b2c3', ...fields});
const tools: ToolState[] = [
  {tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1'},
  {tool: 'claude', installation: 'installed', authentication: 'unknown', version: '0.3.296'},
];
const snapshot = (agents: Agent[], crashes?: ApplicationCrashes): DesktopSnapshot => ({
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.9.0'},
  agents, groups: [{id: 'oc_bound_group' as never, name: '发布群'}],
  memberships: [{id: 'm' as never, agentId: agent.id, groupId: 'oc_bound_group' as never, name: '发布群', directory: '/tmp/x', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false}],
  tools, jobs: [], application: {platform: 'macos', version: '0.9.0', loginItem: false, dataPath: '/tmp/vonvon-home', ...(crashes ? {crashes} : {})},
});
const render = (agents: Agent[], crashes?: ApplicationCrashes) => renderToStaticMarkup(<ClientProvider client={client}>
  <DiagnosticsPanel snapshot={snapshot(agents, crashes)} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/>
</ClientProvider>);

it('shows the lock holder across retries, and gives a pause priority', () => {
  const waiting = { ...agent, lockHeld: { since: now, pid: 123 } };
  expect(render([waiting])).toContain('PID 123');
  expect(render([{ ...waiting, running: false }])).toContain('等待占用的进程退出');
  expect(render([{ ...waiting, lockHeld: { since: now } }])).toContain('另一个进程占着这个 Bot');
  expect(render([{ ...waiting, paused: { since: now, crashes: 3 } }])).not.toContain('等待占用的进程退出');
});

it('shows this machine, and 检查中 for Claude before its first login check', () => {
  const html = render([]);
  // owner 2026-11-02: this computer's page says 本机
  expect(html).toContain('>本机<');
  expect(html).toContain('本机上的 Provider 每分钟检查一次');
  expect(html).toContain('0.9.0');
  expect(html).toContain('可用 · 0.156.1');
  expect(html).toContain('检查中 · 0.3.296');
  expect(html).not.toContain('无法确认配置');
  expect(html).toContain('/tmp/vonvon-home');
  expect(html).toContain('后台日志');
  expect(html).toContain(`id="${settingAnchor('daemon 日志')}"`);
});

it('keeps machine details and logs reachable without reading the log until expanded', () => {
  const html = render([agent]);
  expect(html).toMatch(/<details class="diag-runtime"><summary>运行详情/);
  expect(html).toContain('/tmp/vonvon-home');
  expect(html).toMatch(new RegExp(`<details[^>]*id="${settingAnchor('daemon 日志')}"[^>]*><summary[^>]*><span>后台日志<\\/span>`));
  expect(html).not.toContain('daemon 日志内容');
});

it('keeps detailed Bot diagnostics inside a closed disclosure with a searchable anchor', () => {
  const html = render([agent]);
  expect(html).toMatch(new RegExp(`<details id="${settingAnchor(diagnosticsSection(agent.id))}"[^>]*><summary`));
  expect(html).toContain('查看 值班助手 的诊断');
  expect(html).toContain('详细诊断');
  expect(html).toContain('最近没回的消息');
  expect(html).not.toContain('飞书设置完成 · 权限完整');
});

it('shows unknown tool and Bot states as unknown, not installed or healthy', () => {
  const uncertain = {...snapshot([{...agent, readError: '配置暂时读不到'}]), tools: [
    {tool: 'codex', installation: 'unknown', authentication: 'unknown'},
    {tool: 'claude', installation: 'unknown', authentication: 'unknown'},
  ] as ToolState[]};
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <DiagnosticsPanel snapshot={uncertain} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/>
  </ClientProvider>);
  expect(html).toContain('配置暂时读不到');
  expect(html).toContain('无法确认');
  expect(html).not.toContain('未安装');
  expect(html).not.toContain('飞书设置完成 · 权限完整');
});

it('shows a stopped Bot in a neutral state but keeps a configuration read error visible', () => {
  const stopped = render([{...agent, enabled: false, running: false, connection: 'disconnected'}]);
  expect(stopped).toContain('已停用，诊断记录仍可查看');
  expect(stopped).toContain('已停用');
  const unreadable = render([{...agent, enabled: false, running: false, connection: 'disconnected', readError: '配置文件损坏'}]);
  expect(unreadable).toContain('配置文件损坏');
  expect(unreadable).toContain('读取失败');
  expect(unreadable).not.toContain('已停用，诊断记录仍可查看');
});

it('keeps a paused Bot alert visible above its collapsed diagnostics', () => {
  const html = render([{...agent, running: false, paused: {since: now, crashes: 3}}]);
  expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf(`id="${settingAnchor(diagnosticsSection(agent.id))}"`));
  expect(html).toContain('恢复运行');
  expect(html).toContain('已暂停');
});

it('lists a bot\'s not-replied messages newest first, with the group, place, sender, count and next step', () => {
  const html = render([{...agent, diagnostics: {deniedScopes: [], notReplied: [
    record({reason: 'signed-out', backend: 'claude', place: 'topic', sender: '某同事', count: 10}),
    record({groupId: 'oc_unknown_9f8e7d', reason: 'unbound'}),
  ]}}]);
  expect(html).toContain(`id="${settingAnchor(diagnosticsSection(agent.id))}"`);
  expect(html).toContain('11 条未回复记录');
  expect(html).toContain('Claude 没配置好或配置过期了');
  expect(html).toContain('10 次');
  expect(html).toContain('发布群 · 话题 · 某同事 · 消息尾号 a1b2c3');
  expect(html).toContain('在终端运行 claude 配置好');
  expect(html).toContain('没绑定的群（尾号 9f8e7d） · 主区');
  expect(html.indexOf('Claude 没配置好')).toBeLessThan(html.indexOf('没绑定的群'));
  expect(html).toContain('Codex 可用 · 0.156.1（1 个群）');
});

it('lists a group\'s queued messages a restart dropped as one record with their count (s18c)', () => {
  const html = render([{...agent, diagnostics: {deniedScopes: [], notReplied: [record({reason: 'restarted', place: 'topic', count: 3})]}}]);
  expect(html).toContain('重启或停止时这条还在排队，没处理');
  expect(html).toContain('3 次');
  expect(html).toContain('已在原处回了一句请重发。');
  expect(html).toContain('3 条未回复记录');
  expect(render([{...agent, diagnostics: {deniedScopes: [], notReplied: [record({reason: 'restarted', detail: '最新那条撤回了'})]}}]))
    .toContain('在原处回一句请重发没成功（最新那条撤回了），请告诉发消息的人重发。');
});

it('offers another tier or a Codex upgrade, with --bot only when the host has several bots', () => {
  const refused = {...agent, diagnostics: {deniedScopes: [], notReplied: [record({reason: 'tier-unavailable', backend: 'codex'})]}};
  const one = render([refused]);
  expect(one).toContain('这个群的权限档位在当前 Codex 环境不可用，这一轮没开始');
  expect(one).toContain('在群设置里换一档，或者升级 Codex。也可以运行 vonvon settings set --group oc_bound_group permission.mode=full。');
  expect(one).not.toContain('guestMode');
  const two = render([refused, {...agent, id: 'cli_other' as Agent['id'], name: '另一个'}]);
  expect(two).toContain('vonvon settings set --bot cli_diag --group oc_bound_group permission.mode=full');
});

it('shows a red bar per paused bot that starts it alone again, and the paused daemon\'s bar alone (s18a)', () => {
  const paused = {...agent, running: false, connection: 'disconnected', paused: {since: now, crashes: 3}};
  const other = {...agent, id: 'cli_other' as Agent['id'], name: '另一个', paused: {since: now, crashes: 4}};
  expect(crashBars(snapshot([paused, other, {...agent, id: 'cli_ok' as Agent['id']}], {records: []})).map(bar => bar.command)).toEqual([
    {type: 'setAgentEnabled', agentId: agent.id, enabled: true}, {type: 'setAgentEnabled', agentId: 'cli_other', enabled: true},
  ]);
  const html = render([paused], {records: [
    {at: now, kind: 'forced', reason: 'SIGKILL', appId: agent.id, uptimeMs: 12_000},
    {at: now - 1000, kind: 'forced', reason: '被系统强制结束', uptimeMs: 0, paused: true},
  ]});
  expect(html).toContain('role="alert"');
  expect(html).toContain('「值班助手」10 分钟内崩溃了 3 次，已停止自动重启，别的 Bot 照常。');
  expect(html).toContain('恢复运行');
  expect(html).toContain('已暂停');
  expect(html).toContain('被系统强制结束（SIGKILL），运行了 12 秒');
  expect(html).toContain('被系统强制结束（kill -9、内存不够，或者关机、注销时没来得及退出）（暂停期间）');
  const host = crashBars(snapshot([paused], {paused: {since: now, crashes: 5}, records: []}));
  expect(host).toEqual([expect.objectContaining({command: {type: 'restartHost'}, text: expect.stringContaining('daemon 已暂停：10 分钟内崩溃了 5 次')})]);
  const old = render([agent]);
  expect(old).not.toContain('role="alert"');
  expect(old).not.toContain('最近的崩溃');
  expect(render([agent], {records: []})).toContain('最近 24 小时没有崩溃');
});

it('says what the list holds when a bot has nothing', () => {
  const html = render([agent]);
  expect(html).toContain('暂无未回复记录');
  expect(html).toContain('重启后台服务后清空');
  expect(html).not.toContain('条未回复记录');
});

it('merges the console\'s missing scopes with the ones Feishu refused at runtime', () => {
  const status = {scopes: {missingRequired: ['im:message:readonly'], missingOptional: ['contact:user.base:readonly', 'im:chat.members:write_only'], grantUrl: 'https://open.feishu.cn/app/cli_diag/auth'}} as AdminSetupStatus;
  const denied = {...agent, diagnostics: {notReplied: [], deniedScopes: [{scope: 'im:message:readonly', where: 'history' as const, at: now}, {scope: 'im:chat:readonly', where: 'chat-info' as const, at: now}]}};
  const view = scopeView(status, denied, now);
  const html = renderToStaticMarkup(<>{view.badge}<ul>{view.lines}</ul></>);
  expect(html).toContain('缺 2 项');
  expect(html).toContain('<code>im:message:readonly</code> 必需');
  expect(html).toContain('可选：叫不出群里人的真名');
  expect(html).not.toContain('im:chat.members:write_only');
  expect(html).toContain('补拉群消息时被飞书拒绝：<code>im:message:readonly</code></li>');
  expect(html).toContain('读群信息时被飞书拒绝：<code>im:chat:readonly</code>。后台显示已开，但还没生效');
  expect(renderToStaticMarkup(<>{scopeView({scopes: {grantUrl: 'x'}} as AdminSetupStatus, agent, now).badge}</>)).toContain('暂时读不到已开通的权限');
  expect(renderToStaticMarkup(<>{scopeView(undefined, agent, now, '应用凭据不对').badge}</>)).toContain('读取失败');
  expect(renderToStaticMarkup(<>{scopeView({scopes: {missingRequired: [], missingOptional: [], grantUrl: 'x'}} as AdminSetupStatus, agent, now).badge}</>)).toContain('没有缺的');
});

it('lists what the Feishu tools lack as optional, with their own link', () => {
  const status = {scopes: {missingRequired: [], missingOptional: [], missingTools: ['docs:document.content:read', 'docx:document:readonly', 'search:message'], grantUrl: 'x', toolsGrantUrl: 'https://open.feishu.cn/app/cli_diag/auth?q=y'}} as AdminSetupStatus;
  const view = toolScopeView(status)!;
  const html = renderToStaticMarkup(<>{view.badge}<ul>{view.lines}</ul></>);
  expect(html).toContain('缺 3 项');
  expect(html.match(/读不了文档和知识库/g)).toHaveLength(1);
  expect(html).toContain('搜不了消息');
  expect(html).toContain('发布新版本');
  expect(view.url).toBe('https://open.feishu.cn/app/cli_diag/auth?q=y');
  expect(renderToStaticMarkup(<>{toolScopeView({scopes: {missingTools: [], grantUrl: 'x'}} as AdminSetupStatus)!.badge}</>)).toContain('没有缺的');
  expect(toolScopeView({scopes: {grantUrl: 'x'}} as AdminSetupStatus)).toBeUndefined();
  expect(renderToStaticMarkup(<>{scopeView(status, agent, now).badge}</>)).toContain('没有缺的');
});

it('says 全部完成 with the optional events the checklist warns about, and leaves the scope warning to 缺的权限', () => {
  const status = {appId: 'cli_diag', tenant: 'feishu', credentials: {ok: true}, eventConfigUrl: 'x', consoleUrl: 'x', cardCallback: {confirmed: true},
    event: {state: 'ok', missingOptional: ['im.message.recalled_v1']},
    scopes: {missingRequired: [], missingOptional: [], missingJoinScopes: ['im:chat:readonly'], grantUrl: 'x'}} as unknown as AdminSetupStatus;
  const view = setupView(agent, {status, checking: false});
  expect(renderToStaticMarkup(<>{view.badge}</>)).toContain('全部完成');
  expect(view.warnings).toEqual([expect.stringContaining('没订阅「撤回消息」')]);
  expect(setupView(agent, {problem: '应用凭据不对', checking: false}).warnings).toEqual([]);
});

it('writes today\'s time short and another day\'s with its date, and finds each bot from search', () => {
  const at = new Date(2026, 9, 14, 14, 2).getTime();
  expect(formatTime(at, {now: new Date(2026, 9, 14, 20, 0).getTime()})).toBe('14:02');
  expect(formatTime(at, {now: new Date(2026, 9, 15, 9, 0).getTime()})).toBe('10月14日 14:02');
  const entry = findEntries(searchEntries(snapshot([agent])), '没回的消息').find(item => item.id === `${agent.id}-diagnostics`);
  expect(entry?.destination).toEqual({page: 'diagnostics', section: diagnosticsSection(agent.id)});
});

it('lists the groups an older version put in a wrong directory, only when there are some (s36c2d)', () => {
  const misplaced = {...snapshot([agent]), memberships: [
    {...snapshot([agent]).memberships[0]!, directory: '/tmp/vonvon-home/projects/助手', directoryProblem: 'botRoot' as const},
    {...snapshot([agent]).memberships[0]!, id: 'm2' as never, groupId: 'oc_dot' as never, name: '点', directory: '/tmp/vonvon-home', directoryProblem: 'dataDir' as const},
    {...snapshot([agent]).memberships[0]!, id: 'm3' as never, groupId: 'oc_home' as never, name: '家', directory: '/tmp', directoryProblem: 'dataDirParent' as const},
  ]};
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <DiagnosticsPanel snapshot={misplaced} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/>
  </ClientProvider>);
  expect(html).toContain('群目录');
  expect(html).toContain('3 个群放错了位置');
  expect(html).toContain('「发布群」用的是某个 Bot 自己的目录');
  expect(html).toContain('「点」在 Vonvon 的数据目录里');
  expect(html).toContain('「家」用的是 Vonvon 数据目录的上级文件夹');
  expect(html).toContain('请在群设置的「工作区」中更换目录。原文件不会自动迁移。');
  const linked = renderToStaticMarkup(<ClientProvider client={client}>
    <DiagnosticsPanel snapshot={misplaced} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onOpenMembership={() => {}} onNotice={() => {}}/>
  </ClientProvider>);
  expect(linked).toContain('去更换');
  expect(render([agent])).not.toContain('群目录');
});

it('shows every smart group once with one group score, budget and old prompt notice; rules stay absent', () => {
  const snap = snapshot([{...agent, diagnostics: {notReplied: [], deniedScopes: [], attention: [{groupId: 'oc_bound_group', group: {score: 50, intervalMs: 180000, updatedAt: now}, main: {mode: 'watch', intervalMs: 180000}, focusedTopics: 2, watchedTopics: 1, budget: {kind: 'no-glance', until: now + 60000}}], customPromptGroups: ['oc_bound_group']}}]);
  snap.memberships[0]!.conversation = 'smart';
  snap.memberships[0]!.enabled = true;
  const html = renderToStaticMarkup(<ClientProvider client={client}><DiagnosticsPanel snapshot={snap} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/></ClientProvider>);
  expect(html).toContain('50 / 100 · 普通查看暂缓');
  expect(html).not.toContain('话题专注 2 个');
  expect(html).toContain('批量查看暂缓');
  expect(html).toContain('你的自定义提示词保持原样');
  expect(render([agent])).not.toContain('智能群注意力');
  for (const title of ['智能群注意力', '自定义智能提示词']) expect(findEntries(searchEntries(snap), title).some(entry => entry.destination.section === diagnosticsSection(agent.id))).toBe(true);
});

it('distinguishes a new daemon with empty attention from an old daemon without the field', () => {
  const show = (attention?: []) => {
    const snap = snapshot([{...agent, diagnostics: {notReplied: [], deniedScopes: [], ...(attention ? {attention} : {})}}]);
    snap.attentionModel = 'group';
    snap.memberships[0]!.conversation = 'smart';
    snap.memberships[0]!.enabled = true;
    return renderToStaticMarkup(<ClientProvider client={client}><DiagnosticsPanel snapshot={snap} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/></ClientProvider>);
  };
  expect(show([])).toContain('10 / 100 · 低度留意');
  expect(show()).toContain('当前版本未提供注意力状态');
});

// Codex review 244: a remote device's tools were explained as this computer's (这台电脑, 查看本机环境, 在终端运行 codex …)
describe('the tools of a remote device', () => {
  const remote = {id: 'test-remote', name: '测试远程设备', isRemote: true, platform: 'linux', version: '0.9.0', mode: 'full', capabilities: ['device']} as const;
  const view = (tools: ToolState[], device?: typeof remote) => renderToStaticMarkup(<ClientProvider client={client} device={device ? {...device, capabilities: [...device.capabilities]} : undefined}>
    <DiagnosticsPanel snapshot={{...snapshot([]), tools}} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/>
  </ClientProvider>);
  const signedOut: ToolState[] = [
    {tool: 'codex', installation: 'installed', authentication: 'signedOut', version: '0.163.0'},
    {tool: 'claude', installation: 'missing', authentication: 'unknown', version: null},
  ];

  it('names the device in the group, every instruction, the button and the footer', () => {
    const html = view(signedOut, remote);
    expect(html).toContain('>「测试远程设备」<');
    expect(html).toContain('没配置好 · 0.163.0');
    expect(html).toContain('在「测试远程设备」的终端运行 codex 配置好（账号或自定义 API 都行），然后重新检测。');
    expect(html).toContain('要用 Claude，在「测试远程设备」的 Provider 设置里安装 Claude Agent SDK。');
    expect(html).toContain('>打开「测试远程设备」的 Provider 设置<');
    expect(html).toContain('「测试远程设备」上的 Provider 每分钟检查一次；Claude 的配置可以单独检查。');
    expect(html).not.toContain('本机');
    expect(html).not.toContain('这台电脑');
  });

  it('names the device in a missing Codex, a too old one and the daemon\'s own Claude message', () => {
    const html = view([
      {tool: 'codex', installation: 'missing', authentication: 'unknown', version: null},
      {tool: 'claude', installation: 'installed', authentication: 'signedOut', version: '2.1.0', message: '没配置好。在终端运行 `claude` 配置账号，或设置 ANTHROPIC_API_KEY 用自定义 API。'},
    ], remote);
    expect(html).toContain('可以在「测试远程设备」的 Provider 设置里装托管副本（要用「测试远程设备」上的 Node.js 和 npm）。没装 Node.js 的话，在那台设备上装 ChatGPT 或 Codex 桌面应用，或者用 Homebrew 装 Codex。');
    expect(html).toContain('没配置好。在「测试远程设备」的终端运行 `claude` 配置账号，或设置 ANTHROPIC_API_KEY 用自定义 API。');
    expect(html).not.toContain('本机');
    const old = view([{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.100.0', compatibility: {status: 'tooOld', minimum: '0.150.0', verified: '0.163.0'}}], remote);
    expect(old).toContain('最低要 0.150.0，请在「测试远程设备」的 Provider 设置更新。');
    expect(old).not.toContain('本机');
  });

  // Provider remediation keeps the inspected device explicit and names the actual Provider page.
  it('names the device in what to do about a message it did not answer', () => {
    const records = [record({reason: 'codex-too-old', backend: 'codex'}), record({reason: 'tool-missing', backend: 'codex', ref: 'b2c3d4'})];
    const panel = (device?: typeof remote) => renderToStaticMarkup(<ClientProvider client={client} device={device ? {...device, capabilities: [...device.capabilities]} : undefined}>
      <DiagnosticsPanel snapshot={{...snapshot([{...agent, diagnostics: {deniedScopes: [], notReplied: records}}]), tools: signedOut}} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/>
    </ClientProvider>);
    const html = panel(remote);
    expect(html).toContain('在「测试远程设备」的 Provider 设置里更新 Codex。');
    expect(html).toContain('去「测试远程设备」的 Provider 设置安装。');
    expect(html).not.toContain('本机');
    expect(panel()).toContain('在「Provider」设置里更新 Codex。');
  });

  // 0.9.0 Linux acceptance (task 287): a managed Codex is on no PATH, so `codex` was a command not found there
  it('names what starts a managed copy where it says to run Codex or Claude in a terminal', () => {
    const codex = '/srv/vonvon/node/bin/node /srv/vonvon-data/managed-tools/codex/releases/g/bin/codex';
    const claude = '/srv/vonvon-data/managed-tools/claude/releases/g/bin/claude';
    const tools: ToolState[] = [{...signedOut[0]!, command: codex}, {tool: 'claude', installation: 'installed', authentication: 'signedOut', version: '2.1.0', command: claude}];
    const records = [record({reason: 'signed-out', backend: 'codex'}), record({reason: 'signed-out', backend: 'claude', ref: 'b2c3d4'})];
    const html = renderToStaticMarkup(<ClientProvider client={client} device={{...remote, capabilities: [...remote.capabilities]}}>
      <DiagnosticsPanel snapshot={{...snapshot([{...agent, diagnostics: {deniedScopes: [], notReplied: records}}]), tools}} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenProviders={() => {}} onOpenSecrets={() => {}} onNotice={() => {}}/>
    </ClientProvider>);
    expect(html).toContain(`在「测试远程设备」的终端运行 ${codex} 配置好（账号或自定义 API 都行），然后重新检测。`);
    expect(html).toContain(`在「测试远程设备」的终端运行 ${claude} 配置好（账号或自定义 API 都行），然后点&quot;检查配置&quot;。`);
    expect(html).toContain(`先把 Codex 配置好（账号或自定义 API 都行，用 Codex App 或 \`${codex}\` 命令行），再回到 Vonvon 检测。`);
    expect(html).toContain(`在「测试远程设备」的终端运行 ${claude} 配置好（账号或自定义 API 都行），再点「检查配置」。`);
    expect(html).not.toContain('运行 codex');
  });

  // owner 2026-11-02: this computer's page says 本机 where the remote one says 「X」
  it('says 本机 for this computer, the tool steps as they were', () => {
    const html = view(signedOut);
    expect(html).toContain('>本机<');
    expect(html).toContain('在终端运行 codex 配置好（账号或自定义 API 都行），然后重新检测。');
    expect(html).toContain('要用 Claude，在「Provider」设置里安装 Claude Agent SDK。');
    expect(html).toContain('>打开「Provider」设置<');
    expect(html).toContain('>本机上的 Provider 每分钟检查一次；Claude 的配置可以单独检查。<');
    expect(html).not.toContain('测试远程设备');
  });
});
