import { pendingGroupsSchema } from '@vonvon/protocol';
import { createPendingGroups, pendingGroupsFile } from '../src/project/pending-groups';
import { existsSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, botPaths, useBotDir } from '../src/config/paths';
import { seedBots } from './helpers/bot-fixture';
import { loadBots } from '../src/config/bots';
import { addProject, mutateProject } from '../src/project/registry';
import { upsertSession } from '../src/bot/session-store';
import {
  createAdminService,
  createReadonlyAdminService,
  NotWiredYetError,
  type AdminService,
} from '../src/admin/service';
import { AdminWriteError, type AdminWriteOp } from '../src/admin/ops';
import type { CodexSetupService } from '../src/agent/codex-appserver/setup';
import * as clientPool from '../src/agent/codex-appserver/client-pool';
import { REQUIRED_SCOPES } from '../src/config/scopes';
import { cardCallbackFile, recordCardCallback } from '../src/config/card-callback';

// 把整个 ~/.feishu-codex-bridge 指到临时目录，绝不碰真实用户数据。fixture 通过
// bots/registry/session-store 模块的导出写入（useBotDir 切目录后写）——服务层读
// 到的就是真实落盘格式；服务层自身只走 botPaths 显式路径，不再 useBotDir。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'web-admin-service-test-'));
  let currentBotDir = appDir;
  const botDir = (appId: string): string => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return {
      dir,
      configFile: join(dir, 'config.json'),
      sessionsFile: join(dir, 'sessions.json'),
      projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'),
      setupFile: join(dir, 'setup.json'),
    };
  };
  return {
    botDir,
    botPaths,
    useBotDir: (appId: string): void => {
      currentBotDir = botDir(appId);
    },
    paths: {
      appDir,
      cacheDir: appDir,
      botsFile: join(appDir, 'bots.json'),
      get configFile(): string {
        return join(currentBotDir, 'config.json');
      },
      get sessionsFile(): string {
        return join(currentBotDir, 'sessions.json');
      },
      get projectsFile(): string {
        return join(currentBotDir, 'projects.json');
      },
      get processesFile(): string {
        return join(currentBotDir, 'processes.json');
      },
      projectsRootDir: join(appDir, 'projects'),
    },
  };
});

const BOT_A = 'cli_botA';
const BOT_B = 'cli_botB';
let service: AdminService;

beforeAll(async () => {
  await seedBots({
    version: 1,
    current: BOT_A,
    bots: [
      { name: 'alpha', appId: BOT_A, tenant: 'feishu', botName: '阿尔法', createdAt: 1, active: true },
      { name: 'beta', appId: BOT_B, tenant: 'lark', createdAt: 2, active: false },
    ],
  });

  // bot A：一个项目 + 两个话题（另一个 chatId 的会话、s15c 之前分档留下的键都不算它的话题数）
  useBotDir(BOT_A);
  await addProject({
    name: 'proj-a',
    chatId: 'oc_aaa',
    cwd: '/tmp/proj-a',
    blank: false,
    createdAt: 100,
    kind: 'multi',
    mode: 'write',
    backend: 'codex-appserver',
    allowedUsers: ['ou_1'],
    ...(JSON.parse('{"autoCompact":false}') as object), // 旧数据：关过自动压缩，s12 起不读
  });
  // 每 bot 的完成提醒来自各自 config.json；A 自定义，B 缺省走 failures / 3。
  writeFileSync(
    botPaths(BOT_A).configFile,
    JSON.stringify({ preferences: { completionReminder: { mode: 'long', longTaskMinutes: 7 } } }),
    'utf8',
  );
  for (const [threadId, chatId] of [
    ['t1', 'oc_aaa'],
    ['t2', 'oc_aaa'],
    ['t3', 'oc_other'],
    ['t1#guest', 'oc_aaa'],
    ['t2#admin', 'oc_aaa'],
  ] as const) {
    await upsertSession({
      threadId,
      chatId,
      cwd: '/tmp/proj-a',
      sessionId: `sess-${threadId}`,
      backend: 'codex-appserver',
      summary: `话题 ${threadId}`,
      createdAt: 10,
      updatedAt: threadId === 't1' ? 30 : 20,
    });
  }

  // bot B：另一个目录下的项目（验证 per-bot 隔离）
  useBotDir(BOT_B);
  await addProject({
    name: 'proj-b',
    chatId: 'oc_bbb',
    cwd: '/tmp/proj-b',
    blank: true,
    createdAt: 200,
  });

  // 服务层不依赖 useBotDir 的全局态——故意把全局目录切到一个无关 bot，证明
  // 读取走的是显式路径（第一棒 useBotDir 切目录的坑已修掉）。
  useBotDir('cli_unrelated');

  service = createReadonlyAdminService();
});

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

describe('createReadonlyAdminService · 只读方法（显式路径，不碰全局 currentBotDir）', () => {
  it('listBots：全部 bot + current/active 标记，预览态下 running=false 且无 connection', async () => {
    const bots = await service.listBots();
    expect(bots.map((b) => b.appId).sort()).toEqual([BOT_A, BOT_B]);
    const a = bots.find((b) => b.appId === BOT_A)!;
    const b = bots.find((b) => b.appId === BOT_B)!;
    expect(a.current).toBe(true);
    expect(a.active).toBe(true);
    expect(a.botName).toBe('阿尔法');
    expect(a.registeredAt).toBe(1);
    expect(b.registeredAt).toBe(2);
    expect(a.completionReminder).toEqual({ mode: 'long', longTaskMinutes: 7 });
    expect(b.completionReminder).toEqual({ mode: 'failures', longTaskMinutes: 3 });
    expect(b.current).toBe(false);
    expect(b.active).toBe(false);
    // 没有单实例锁文件 → 未在跑；真实 WS 状态只有 daemon 进程内才有
    expect(a.running).toBe(false);
    expect(b.running).toBe(false);
    expect(a.connection).toBeUndefined();
  });

  it('listProjects：effective 字段已解析（默认值回填）+ 话题数按 chatId 聚合', async () => {
    const projects = await service.listProjects(BOT_A);
    expect(projects).toHaveLength(1);
    const p = projects[0]!;
    expect(p.name).toBe('proj-a');
    expect(p.kind).toBe('multi');
    expect(p.enabled).toBe(true); // Old stored projects without the flag are enabled.
    expect(p.origin).toBe('created'); // 缺省回填
    expect(p.mode).toBe('write');
    expect(p.guestMode).toBe('write'); // s15c: deprecated mirror of the one tier
    expect(p.noMention).toBe(true); // created+multi 默认免@ 开
    expect(p).not.toHaveProperty('autoCompact'); // s12: always on, no longer reported
    expect(p.network).toBe(false);
    expect(p.backend).toBe('codex-appserver'); // 显式设的后端原样透传
    expect(p.allowedUsersCount).toBe(1);
    expect(p.sessionCount).toBe(2); // oc_other 的 t3、停用的 t1#guest / t2#admin 不算
  });

  it('listProjects：读取外部保存的停用状态，恢复旧项目的缺省启用状态', async () => {
    const location = {file: botPaths(BOT_A).projectsFile, dataRoot: paths.appDir};
    try {
      await mutateProject('proj-a', project => {project.enabled = false;}, undefined, location);
      expect((await service.listProjects(BOT_A))[0]?.enabled).toBe(false);
      expect((await service.listProjects(BOT_B))[0]?.enabled).toBe(true);
    } finally {
      await mutateProject('proj-a', project => {delete project.enabled;}, undefined, location);
    }
    expect((await service.listProjects(BOT_A))[0]?.enabled).toBe(true);
  });

  it('listProjects exposes custom permission effects rather than the stored full tier', async () => {
    const location = { file: botPaths(BOT_A).projectsFile, dataRoot: paths.appDir };
    try {
      await mutateProject('proj-a', p => {
        p.mode = 'full'; p.network = true;
        p.custom = { backend: 'codex-appserver', settings: { sandbox: 'read-only', network: false } };
      }, undefined, location);
      expect((await service.listProjects(BOT_A))[0]).toMatchObject({ mode: 'qa', guestMode: 'qa', network: false });
    } finally {
      await mutateProject('proj-a', p => { p.mode = 'write'; delete p.network; delete p.custom; }, undefined, location);
    }
  });

  it('listProjects：per-bot 隔离（B 的项目读不到 A 的数据），且 effective 默认后端回填', async () => {
    const projects = await service.listProjects(BOT_B);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('proj-b');
    expect(projects[0]!.mode).toBe('full'); // 老数据无 mode → full
    expect(projects[0]!.backend).toBe('codex-appserver'); // 缺省 → 默认后端
    expect(projects[0]!.sessionCount).toBe(0);
  });

  it('并发跨 bot 读互不串（显式路径天然无共享可变态）', async () => {
    const [a, b] = await Promise.all([service.listProjects(BOT_A), service.listProjects(BOT_B)]);
    expect(a.map((p) => p.name)).toEqual(['proj-a']);
    expect(b.map((p) => p.name)).toEqual(['proj-b']);
  });

  it('getProject：命中返回详情，未命中返回 undefined', async () => {
    expect((await service.getProject(BOT_A, 'proj-a'))?.cwd).toBe('/tmp/proj-a');
    expect(await service.getProject(BOT_A, 'nope')).toBeUndefined();
  });

  it('listSessions：按项目 chatId 过滤、去掉 s15c 之前分档留下的键，并按 updatedAt 新→旧排序', async () => {
    const sessions = await service.listSessions(BOT_A, 'proj-a');
    expect(sessions.map((s) => s.threadId)).toEqual(['t1', 't2']);
    expect(sessions[0]!.summary).toBe('话题 t1');
    expect(await service.listSessions(BOT_A, 'nope')).toEqual([]);
  });

  it('eventDiagnosis：配置缺失 → unchecked 降级（绝不抛错）', async () => {
    const d = await service.eventDiagnosis(BOT_A);
    expect(d.state).toBe('unchecked');
    expect(d.reason).toBeTruthy();
  });

  it('tailLogs：返回字符串（文件日志尾部）', async () => {
    expect(typeof (await service.tailLogs({ maxBytes: 4096 }))).toBe('string');
  });
});

it('Host 用量读取只依赖 Codex 账号，不查机器人或群配置', async () => {
  const calls: boolean[] = [];
  const usage = { profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 456 } };
  const account = createAdminService({ fetchAccountUsage: async force => {
    calls.push(force);
    return usage;
  } });
  account.listBots = async () => { throw new Error('account usage must not read bots'); };
  expect(await account.accountUsage(false)).toEqual(usage);
  expect(await account.accountUsage(true)).toEqual(usage);
  expect(calls).toEqual([false, true]);
  await account.close?.();
});

it('Host 退出等待在途用量读取，再清理 Codex 常驻客户端，并拒绝新的读取', async () => {
  const usage = { profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 456 } };
  let releaseUsage!: (value: typeof usage) => void;
  const pendingUsage = new Promise<typeof usage>(resolve => { releaseUsage = resolve; });
  const events: string[] = [];
  const codexTools = { close: async () => { events.push('setup closed'); } } as CodexSetupService;
  const residentClose = vi.spyOn(clientPool, 'shutdownResidentClients').mockImplementation(async () => {
    events.push('residents closed');
  });
  const account = createAdminService({ fetchAccountUsage: () => pendingUsage, codexTools });
  try {
    const read = account.accountUsage(false).then(result => { events.push('usage finished'); return result; });
    let closed = false;
    const closing = account.close?.().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(events).toEqual([]);
    await expect(account.accountUsage(true)).rejects.toThrow('daemon 正在退出');
    releaseUsage(usage);
    expect(await read).toEqual(usage);
    await closing;
    expect(events).toEqual(['usage finished', 'setup closed', 'residents closed']);
    await account.close?.();
    expect(residentClose).toHaveBeenCalledTimes(1);
  } finally {
    releaseUsage(usage);
    residentClose.mockRestore();
  }
});

describe('createReadonlyAdminService · 写方法（只读预览占位）', () => {
  it('四个写方法一律抛 NotWiredYetError', async () => {
    await expect(service.switchBackend(BOT_A, 'proj-a', 'codex-appserver')).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(service.setPermissionMode(BOT_A, 'proj-a', { mode: 'qa' })).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(service.setNoMention(BOT_A, 'proj-a', true)).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(
      service.setCompletionReminder(BOT_A, { mode: 'failures', longTaskMinutes: 3 }),
    ).rejects.toBeInstanceOf(NotWiredYetError);
  });

  it('NotWiredYetError 带 code 和「先起 daemon」的引导文案', async () => {
    const err = await service.switchBackend(BOT_A, 'proj-a', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotWiredYetError);
    expect((err as NotWiredYetError).code).toBe('NOT_WIRED_YET');
    expect((err as NotWiredYetError).message).toContain('daemon');
    expect((err as NotWiredYetError).message).toContain('只读预览');
  });

  it('只读预览里扫码注册说「注册 Bot」', async () => {
    await expect(service.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} })).rejects.toThrow('「注册 Bot」需要 daemon 在跑');
  });
});

describe('createAdminService · daemon 进程内（executeWrite + liveStatus 注入）', () => {
  it('写方法把 botId + AdminWriteOp 原样交给执行器（Web 与 DM 同一写路径的接缝）', async () => {
    const calls: { botId: string; op: AdminWriteOp }[] = [];
    const daemon = createAdminService({
      executeWrite: async (botId, op) => void calls.push({ botId, op }),
    });
    await daemon.switchBackend(BOT_A, 'proj-a', 'codex-appserver');
    await daemon.setPermissionMode(BOT_A, 'proj-a', { mode: 'qa' });
    await daemon.setNoMention(BOT_A, 'proj-a', false);
    await daemon.setCompletionReminder(BOT_A, { mode: 'long', longTaskMinutes: 8 });
    expect(calls).toEqual([
      { botId: BOT_A, op: { kind: 'switchBackend', project: 'proj-a', backend: 'codex-appserver' } },
      {
        botId: BOT_A,
        op: { kind: 'setPermissionMode', project: 'proj-a', mode: 'qa' },
      },
      { botId: BOT_A, op: { kind: 'setNoMention', project: 'proj-a', on: false } },
      { botId: BOT_A, op: { kind: 'setCompletionReminder', mode: 'long', longTaskMinutes: 8 } },
    ]);
  });

  it('执行器抛 AdminWriteError（校验拒绝）原样透传给调用方', async () => {
    const daemon = createAdminService({
      executeWrite: async () => {
        throw new AdminWriteError('后端「x」当前不可用');
      },
    });
    await expect(daemon.switchBackend(BOT_A, 'proj-a', 'x')).rejects.toBeInstanceOf(AdminWriteError);
  });

  it('liveStatus 注入：listBots 用真实 WS 状态替代锁文件探测；未覆盖的 bot 回退锁文件', async () => {
    const daemon = createAdminService({
      liveStatus: async (botId) =>
        botId === BOT_A
          ? { running: true, pid: 4242, startedAt: 1000, connection: 'connected' }
          : undefined,
    });
    const bots = await daemon.listBots();
    const a = bots.find((b) => b.appId === BOT_A)!;
    const b = bots.find((b) => b.appId === BOT_B)!;
    expect(a.running).toBe(true);
    expect(a.pid).toBe(4242);
    expect(a.connection).toBe('connected');
    // B 不归 daemon 管 → 锁文件探测（无锁文件 = 未在跑）
    expect(b.running).toBe(false);
    expect(b.connection).toBeUndefined();
  });

  it('liveStatus 抛错不致命：回退锁文件探测（绝不让 /api/state 整页 500）', async () => {
    const daemon = createAdminService({
      liveStatus: async () => {
        throw new Error('IPC 超时');
      },
    });
    const bots = await daemon.listBots();
    expect(bots.find((b) => b.appId === BOT_A)!.running).toBe(false);
  });
});

describe('createAdminService · getSetupStatus（初始化 checklist 聚合）', () => {
  // 真飞书 API 一律 mock：token / bot-info / scopes / app_versions / application。
  // 写一个带明文 secret 的完整 config.json（resolveAppSecret 直接吃明文）到 bot 目录。
  const SETUP_BOT = 'cli_setupbot';
  const configuredCallback = { state: 'configured', mode: 'websocket' };

  function writeCompleteConfig(tenant: 'feishu' | 'lark' = 'feishu', preferences?: unknown): void {
    const dir = botPaths(SETUP_BOT).dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      botPaths(SETUP_BOT).configFile,
      JSON.stringify({ accounts: { app: { id: SETUP_BOT, secret: 'plain-secret', tenant } }, preferences }),
    );
  }

  function stubFetch(opts: { grantedScopes: string[]; eventEvents: string[]; published?: boolean; callbackInfo?: unknown }): typeof fetch {
    return (async (input: unknown): Promise<Response> => {
      const u = String(input);
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return json({ code: 0, tenant_access_token: 't-xyz' });
      }
      if (u.includes('/bot/v3/info')) {
        return json({ code: 0, bot: { app_name: 'SetupBot', open_id: 'ou_bot' } });
      }
      if (u.includes('/application/v6/scopes')) {
        return json({ data: { scopes: opts.grantedScopes.map((s) => ({ scope_name: s, grant_status: 1 })) } });
      }
      if (u.includes('/app_versions')) {
        return json({
          code: 0,
          data: opts.published === false ? { items: [] } : { items: [{ version: '1.0.0', status: 1, events: opts.eventEvents }] },
        });
      }
      if (u.includes(`/application/v6/applications/${SETUP_BOT}?`)) {
        return json({ code: 0, data: { app: { callback_info: opts.callbackInfo ?? {
          callback_type: 'websocket', subscribed_callbacks: ['card.action.trigger'],
        } } } });
      }
      throw new Error('unexpected fetch ' + u);
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    // Manual confirmation tests also call the aggregate endpoint: never let them
    // silently contact real Feishu when no test-specific stub was installed.
    vi.stubGlobal('fetch', stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'] }));
  });

  beforeAll(async () => {
    await seedBots({
      version: 1,
      current: BOT_A,
      bots: [
        { name: 'alpha', appId: BOT_A, tenant: 'feishu', botName: '阿尔法', createdAt: 1, active: true },
        { name: 'beta', appId: BOT_B, tenant: 'lark', createdAt: 2, active: false },
        { name: 'setup', appId: SETUP_BOT, tenant: 'feishu', createdAt: 3, active: false },
      ],
    });
  });

  it('tells the running bot to greet its creator once every required scope shows, and only then', async () => {
    const granted = stubFetch({ grantedScopes: [...REQUIRED_SCOPES], eventEvents: ['im.message.receive_v1'] });
    const firstHello = vi.fn(async () => { throw new Error('bot not running'); });
    writeCompleteConfig('feishu', { access: { firstHelloPending: true } });
    await createAdminService({ firstHello }).getSetupStatus(SETUP_BOT); // the default stub: nothing granted yet
    expect(firstHello).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', granted);
    await createAdminService({ firstHello }).getSetupStatus(SETUP_BOT);
    expect(firstHello).toHaveBeenCalledExactlyOnceWith(SETUP_BOT);
    writeCompleteConfig();
    await createAdminService({ firstHello }).getSetupStatus(SETUP_BOT);
    expect(firstHello).toHaveBeenCalledTimes(1);
  });

  it('全绿：密钥有效 + scope 齐全 + 事件 ok（长连接靠锁文件探测，预览态 running=false）', async () => {
    writeCompleteConfig();
    // 授予全部必需 scope，且事件含 im.message.receive_v1 → ok。
    vi.stubGlobal(
      'fetch',
      stubFetch({
        grantedScopes: [
          'im:message.group_at_msg:readonly',
          'im:message.group_msg',
          'im:message.p2p_msg:readonly',
          'im:message:readonly',
          'im:message:send_as_bot',
          'im:message.pins:write_only',
          'im:message.reactions:write_only',
          'im:resource',
          'im:chat:create',
          'im:chat:update',
          'im:chat.managers:write_only',
          'im:chat.announcement:read',
          'im:chat.announcement:write_only',
          'im:chat.top_notice:write_only',
          'im:chat.tabs:write_only',
          'cardkit:card:write',
        ],
        eventEvents: ['im.message.receive_v1'],
      }),
    );
    const svc = createReadonlyAdminService();
    const s = await svc.getSetupStatus(SETUP_BOT);
    expect(s.appId).toBe(SETUP_BOT);
    expect(s.credentials.ok).toBe(true);
    expect(s.botName).toBe('SetupBot');
    expect(s.scopes.missingRequired).toEqual([]);
    // 加入现有群的权限没开：只作提醒，不影响 missingRequired。
    expect(s.scopes.missingJoinScopes).toEqual(['im:chat:readonly', 'im:chat.members:write_only']);
    // The 3.11 optional scopes the 状态与诊断 page lists (s19).
    expect(s.scopes.missingOptional).toEqual(['contact:user.base:readonly', 'im:chat:readonly', 'im:message.group_at_msg.include_bot:readonly', 'application:application:self_manage']);
    expect(s.scopes.grantUrl).toContain('/app/cli_setupbot/auth?q=');
    expect(s.scopes.missingTools).toContain('docs:document.content:read');
    expect(decodeURIComponent(s.scopes.toolsGrantUrl!)).toContain('search:message');
    expect(decodeURIComponent(s.scopes.grantUrl)).not.toContain('search:message');
    expect(s.event.state).toBe('ok');
    // 机器人进群事件没订阅：清单靠 missingOptional 提醒。
    expect(s.event.missingOptional).toContain('im.chat.member.bot.added_v1');
    expect(s.connection.running).toBe(false); // 没锁文件 + 预览态
    expect(s.eventConfigUrl).toContain('/app/cli_setupbot/event');
    expect(s.consoleUrl).toBe('https://open.feishu.cn/app/cli_setupbot');
    expect(s.cardCallback).toEqual({ confirmed: false, configuration: configuredCallback });
  });

  it('飞书后台改了名：检查连接时 bots.json 里的显示名跟着变，句柄和 appId 不变；只读预览、凭据被拒、配置换了应用都不写', async () => {
    const seeded = [
      { name: 'alpha', appId: BOT_A, tenant: 'feishu' as const, botName: '阿尔法', createdAt: 1, active: true },
      { name: 'beta', appId: BOT_B, tenant: 'lark' as const, createdAt: 2, active: false },
      { name: 'setup', appId: SETUP_BOT, tenant: 'feishu' as const, botName: 'Vonvon Bot 6', createdAt: 3, active: false },
    ];
    await seedBots({ version: 1, current: BOT_A, bots: seeded });
    const raw = (): string => readFileSync(paths.botsFile, 'utf8');
    try {
      writeCompleteConfig();
      const before = raw();
      expect((await createReadonlyAdminService().getSetupStatus(SETUP_BOT)).botName).toBe('SetupBot');
      expect(raw()).toBe(before);

      vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ code: 10014, msg: 'app secret invalid' }), { status: 400 })) as unknown as typeof fetch);
      expect((await createAdminService({}).getSetupStatus(SETUP_BOT)).credentials.ok).toBe(false);
      expect(raw()).toBe(before);

      vi.stubGlobal('fetch', stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'] }));
      writeFileSync(botPaths(SETUP_BOT).configFile, JSON.stringify({ accounts: { app: { id: 'cli_someone_else', secret: 'plain-secret', tenant: 'feishu' } } }));
      await createAdminService({}).getSetupStatus(SETUP_BOT);
      expect(raw()).toBe(before);

      writeCompleteConfig();
      expect((await createAdminService({}).getSetupStatus(SETUP_BOT)).botName).toBe('SetupBot');
      expect((await loadBots()).bots).toEqual([seeded[0], seeded[1], { ...seeded[2], botName: 'SetupBot' }]);
    } finally {
      await seedBots({ version: 1, current: BOT_A, bots: seeded.map(({ botName, ...bot }) => (bot.appId === SETUP_BOT ? bot : { ...bot, ...(botName ? { botName } : {}) })) });
    }
  });

  it('卡片回调勾选按 Bot 存在 setup.json，重开后还在；文件坏了按未勾选', async () => {
    writeCompleteConfig();
    rmSync(botPaths(SETUP_BOT).setupFile, { force: true });
    const svc = createAdminService({});
    await svc.confirmCardCallback(SETUP_BOT, true);
    expect((await svc.getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: true, configuration: configuredCallback });
    expect(statSync(botPaths(SETUP_BOT).setupFile).mode & 0o777).toBe(0o600);
    expect((await createAdminService({}).getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: true, configuration: configuredCallback });
    await svc.confirmCardCallback(SETUP_BOT, false);
    expect((await svc.getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: false, configuration: configuredCallback });
    writeFileSync(botPaths(SETUP_BOT).setupFile, '{not json');
    expect((await svc.getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: false, configuration: configuredCallback });
  });

  it('不认识的 Bot、目录已删的 Bot 和只读预览都不写卡片回调勾选', async () => {
    await expect(createAdminService({}).confirmCardCallback('cli_nobody', true)).rejects.toThrow('没有这个 Bot');
    expect(existsSync(botPaths('cli_nobody').setupFile)).toBe(false);
    rmSync(botPaths(SETUP_BOT).dir, { recursive: true, force: true });
    await expect(createAdminService({}).confirmCardCallback(SETUP_BOT, true)).rejects.toThrow('没有这个 Bot');
    expect(existsSync(botPaths(SETUP_BOT).dir)).toBe(false);
    writeCompleteConfig();
    await expect(createReadonlyAdminService().confirmCardCallback(SETUP_BOT, true)).rejects.toThrow('卡片回调勾选');
    expect(existsSync(botPaths(SETUP_BOT).setupFile)).toBe(false);
  });

  it('真实回调证据重开后保留，取消人工勾选不影响验证；轻量读取不调用飞书', async () => {
    writeCompleteConfig();
    rmSync(botPaths(SETUP_BOT).setupFile, { force: true });
    const fetch = vi.fn(() => { throw new Error('must not contact Feishu'); });
    vi.stubGlobal('fetch', fetch);
    const svc = createAdminService({});
    const verifiedAt = 1_790_000_000_000;
    try {
      expect(await svc.getCardCallbackStatus!(SETUP_BOT)).toEqual({ confirmed: false });
      await svc.confirmCardCallback(SETUP_BOT, true);
      expect(await svc.getCardCallbackStatus!(SETUP_BOT)).toEqual({ confirmed: true });
      await Promise.all([recordCardCallback(SETUP_BOT, verifiedAt), svc.confirmCardCallback(SETUP_BOT, false)]);
      expect(await createReadonlyAdminService().getCardCallbackStatus!(SETUP_BOT)).toEqual({ confirmed: true, verifiedAt });
      expect(await svc.getCardCallbackStatus!(BOT_B)).toEqual({ confirmed: false });
      await expect(svc.getCardCallbackStatus!('cli_missing')).rejects.toThrow('没有这个 Bot');
      expect(fetch).not.toHaveBeenCalled();
      vi.stubGlobal('fetch', stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'] }));
      expect((await svc.getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: true, verifiedAt, configuration: configuredCallback });
    } finally {
      rmSync(cardCallbackFile(SETUP_BOT), { force: true });
      rmSync(botPaths(SETUP_BOT).setupFile, { force: true });
    }
  });

  it('远程配置已订阅不生成本机确认或真实回调证据；刷新会反映配置变化', async () => {
    writeCompleteConfig();
    rmSync(botPaths(SETUP_BOT).setupFile, { force: true });
    rmSync(cardCallbackFile(SETUP_BOT), { force: true });
    const svc = createReadonlyAdminService();
    expect((await svc.getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: false, configuration: configuredCallback });
    expect(await svc.getCardCallbackStatus!(SETUP_BOT)).toEqual({ confirmed: false });
    expect(existsSync(botPaths(SETUP_BOT).setupFile)).toBe(false);
    expect(existsSync(cardCallbackFile(SETUP_BOT))).toBe(false);
    vi.stubGlobal('fetch', stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'], callbackInfo: { callback_type: 'websocket', subscribed_callbacks: [] } }));
    expect((await svc.getSetupStatus(SETUP_BOT)).cardCallback).toEqual({ confirmed: false, configuration: { state: 'missing', mode: 'websocket' } });
  });

  it.each([
    [{ callback_type: 'webhook', subscribed_callbacks: ['card.action.trigger'] }, { state: 'wrong-mode', mode: 'webhook' }],
    [{ callback_type: 'websocket' }, { state: 'unchecked', mode: 'websocket', reason: '应用接口未返回可识别的回调订阅列表' }],
  ])('回调配置诊断不覆盖本机已验证的证据：%j', async (callbackInfo, configuration) => {
    writeCompleteConfig();
    const verifiedAt = 1_790_000_000_000;
    await recordCardCallback(SETUP_BOT, verifiedAt);
    vi.stubGlobal('fetch', stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'], callbackInfo }));
    try {
      expect((await createReadonlyAdminService().getSetupStatus(SETUP_BOT)).cardCallback)
        .toEqual({ confirmed: true, verifiedAt, configuration });
    } finally {
      rmSync(cardCallbackFile(SETUP_BOT), { force: true });
    }
  });

  it('读取回调配置缺权限时，凭据、事件订阅仍返回各自的检测结果', async () => {
    writeCompleteConfig();
    const base = stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'] });
    vi.stubGlobal('fetch', (async (input: unknown, init?: RequestInit) => String(input).includes(`/applications/${SETUP_BOT}?`)
      ? new Response(JSON.stringify({ code: 99991672, msg: 'denied' }), { status: 400 })
      : base(input as string, init)) as typeof fetch);
    const status = await createReadonlyAdminService().getSetupStatus(SETUP_BOT);
    expect(status.credentials).toEqual({ ok: true });
    expect(status.event.state).toBe('ok');
    expect(status.cardCallback.configuration).toEqual({ state: 'unchecked', reason: '没有读取应用配置的权限，请检查飞书应用权限后重试' });
  });

  it.each([
    [400, { code: 10014, msg: 'app secret invalid' }, { ok: false, reason: 'code=10014 msg=app secret invalid' }],
    [400, 'not json', { ok: false, reason: 'HTTP 400', unreachable: true }],
    [503, { code: 1, msg: 'busy' }, { ok: false, reason: 'HTTP 503', unreachable: true }],
  ])('换 token 返回 HTTP %i 时，带错误码的算凭据被拒，其余算没检测', async (status, body, credentials) => {
    writeCompleteConfig();
    vi.stubGlobal('fetch', (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch);
    expect((await createReadonlyAdminService().getSetupStatus(SETUP_BOT)).credentials).toEqual(credentials);
  });

  it('连不上飞书时凭据算"无法确认"，不算无效', async () => {
    writeCompleteConfig();
    vi.stubGlobal('fetch', (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch);
    const s = await createReadonlyAdminService().getSetupStatus(SETUP_BOT);
    expect(s.credentials).toEqual({ ok: false, reason: '飞书接口 10 秒没有响应', unreachable: true });
    expect(s.event).toEqual({ state: 'unchecked', reason: '飞书接口 10 秒没有响应' });
    expect(s.cardCallback.configuration).toEqual({ state: 'unchecked', reason: '飞书接口 10 秒没有响应' });
  });

  it('缺 scope + 事件未发布：missingRequired 非空、event=unpublished', async () => {
    writeCompleteConfig();
    vi.stubGlobal('fetch', stubFetch({ grantedScopes: ['im:resource'], eventEvents: [], published: false }));
    const svc = createReadonlyAdminService();
    const s = await svc.getSetupStatus(SETUP_BOT);
    expect(s.credentials.ok).toBe(true);
    expect((s.scopes.missingRequired ?? []).length).toBeGreaterThan(0);
    expect(s.scopes.missingRequired).toContain('im:message:send_as_bot');
    expect(s.event.state).toBe('unpublished');
  });

  it('迁移来的 bot 没开 im:message:readonly：missingRequired 只列出这一项', async () => {
    writeCompleteConfig();
    const grantedScopes = REQUIRED_SCOPES.filter((scope) => scope !== 'im:message:readonly');
    vi.stubGlobal('fetch', stubFetch({ grantedScopes, eventEvents: ['im.message.receive_v1'] }));
    const s = await createReadonlyAdminService().getSetupStatus(SETUP_BOT);
    expect(s.scopes.missingRequired).toEqual(['im:message:readonly']);
    expect(decodeURIComponent(s.scopes.grantUrl)).toContain('im:message:readonly');
  });

  it('开了读群信息、订阅了机器人进群：missingJoinScopes 只剩退群权限，missingOptional 不含进群事件', async () => {
    writeCompleteConfig();
    vi.stubGlobal('fetch', stubFetch({
      grantedScopes: [...REQUIRED_SCOPES, 'im:chat:readonly'],
      eventEvents: ['im.message.receive_v1', 'im.chat.member.bot.added_v1'],
    }));
    const s = await createReadonlyAdminService().getSetupStatus(SETUP_BOT);
    expect(s.scopes.missingRequired).toEqual([]);
    expect(s.scopes.missingJoinScopes).toEqual(['im:chat.members:write_only']);
    expect(s.event.missingOptional).not.toContain('im.chat.member.bot.added_v1');
  });

  it('读不到已开通的权限时，missingRequired 和 missingJoinScopes 都是 undefined', async () => {
    writeCompleteConfig();
    const base = stubFetch({ grantedScopes: [], eventEvents: ['im.message.receive_v1'] });
    vi.stubGlobal('fetch', (async (input: unknown, init?: RequestInit) =>
      String(input).includes('/application/v6/scopes') ? new Response('denied', { status: 400 }) : base(input as string, init)) as unknown as typeof fetch);
    const s = await createReadonlyAdminService().getSetupStatus(SETUP_BOT);
    expect(s.credentials.ok).toBe(true);
    expect(s.scopes.missingRequired).toBeUndefined();
    expect(s.scopes.missingJoinScopes).toBeUndefined();
  });

  it('配置缺失（未写 config.json）→ credentials.ok=false + event unchecked，绝不抛错', async () => {
    rmSync(botPaths(SETUP_BOT).dir, { recursive: true, force: true });
    const svc = createReadonlyAdminService();
    const s = await svc.getSetupStatus(SETUP_BOT);
    expect(s.credentials.ok).toBe(false);
    expect(s.event.state).toBe('unchecked');
    expect(s.cardCallback.configuration).toEqual({ state: 'unchecked', reason: '配置缺失，无法诊断卡片回调' });
    expect(s.scopes.grantUrl).toContain('/auth?q='); // 深链总归得给
  });
});

it('reads pending events from all inviters and filters bound groups and disabled bots', async () => {
  const id = 'cli_pending';
  const prior = await import('../src/config/bots').then(module => module.loadBots());
  await seedBots({ ...prior, bots: [...prior.bots, { appId: id, name: 'Pending', tenant: 'feishu', createdAt: 1, active: true }] });
  const files = botPaths(id); mkdirSync(files.dir, { recursive: true });
  const config = { accounts: { app: { id, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { admins: ['ou_admin'] } } };
  writeFileSync(files.configFile, JSON.stringify(config));
  const queue = createPendingGroups({ file: pendingGroupsFile(files.projectsFile), eligible: async () => true, verify: async () => ({ state: 'ready', name: 'Research', topic: false }), onError: error => { throw error; } });
  await queue.add('oc_pending', 'ou_admin'); await queue.add('oc_other', 'ou_removed'); await queue.refresh();
  const reader = createAdminService({ liveStatus: async () => ({ running: true }) });
  try {
    expect(await reader.pendingGroups?.(id)).toEqual({ groups: ['oc_pending', 'oc_other'].map(chatId => ({ chatId, name: 'Research', addedAt: expect.any(Number), topic: false })) });
    useBotDir(id);
    await addProject({ name: 'Bound', chatId: 'oc_pending', cwd: '/tmp', blank: false, createdAt: 1 });
    expect(await reader.pendingGroups?.(id)).toEqual({ groups: [{ chatId: 'oc_other', name: 'Research', addedAt: expect.any(Number), topic: false }] });
    const records = Array.from({ length: 1001 }, (_, i) => ({ chatId: `oc_limit_${i + 1}`, operator: 'ou_other', addedAt: i + 1, generation: `fixture-${i}`, state: 'ready', name: 'Pending', ...(i === 1000 ? { topic: true } : {}) }));
    writeFileSync(pendingGroupsFile(files.projectsFile), JSON.stringify({ version: 1, groups: records }));
    const result = await reader.pendingGroups?.(id);
    expect(result?.groups).toHaveLength(1000);
    expect(result?.groups[0]).toEqual({ chatId: 'oc_limit_1001', name: 'Pending', addedAt: 1001, topic: true });
    expect(result?.groups.at(-1)).toEqual({ chatId: 'oc_limit_2', name: 'Pending', addedAt: 2 });
    expect(result?.groups.some(group => group.chatId === 'oc_limit_1')).toBe(false);
    expect(pendingGroupsSchema.safeParse(result).success).toBe(true);
    expect(await reader.pendingGroups?.(BOT_B)).toEqual({ groups: [] });
    expect(await reader.pendingGroups?.('cli_missing')).toEqual({ groups: [] });
    writeFileSync(pendingGroupsFile(files.projectsFile), '{');
    await expect(reader.pendingGroups?.(id)).rejects.toThrow();
  } finally { await reader.close?.(); await seedBots(prior); }
});


it('keeps the group identity read bound to the captured Bot registration and exact echoed group', async () => {
  const original = await loadBots();
  const id = 'cli_group_identity';
  const bot = {appId: id, name: 'Identity fixture', tenant: 'feishu' as const, createdAt: 1, registrationId: 'captured'};
  await seedBots({...original, bots: [...original.bots, bot]});
  const executeGroups = vi.fn(async (_botId: string, _op: unknown): Promise<unknown> => ({kind: 'groupIdentity', agentId: id, groupId: 'oc_exact', name: '飞书平台群'}));
  const reader = createAdminService({executeGroups});
  try {
    expect(await reader.readGroupIdentity!(id, 'oc_exact')).toEqual({kind: 'groupIdentity', agentId: id, groupId: 'oc_exact', name: '飞书平台群'});
    expect(executeGroups).toHaveBeenCalledWith(id, {kind: 'groupIdentity', chatId: 'oc_exact', identity: {appId: id, tenant: 'feishu', createdAt: 1, registrationId: 'captured'}});
    executeGroups.mockResolvedValueOnce({kind: 'groupIdentity', agentId: id, groupId: 'oc_other', name: 'wrong target'});
    await expect(reader.readGroupIdentity!(id, 'oc_exact')).rejects.toThrow('目标不一致');
    executeGroups.mockImplementationOnce(async () => {
      await seedBots({...original, bots: [...original.bots, {...bot, registrationId: 'replaced'}]});
      return {kind: 'groupIdentity', agentId: id, groupId: 'oc_exact', name: 'late name'};
    });
    await expect(reader.readGroupIdentity!(id, 'oc_exact')).rejects.toThrow('重新注册');
  } finally {await reader.close?.(); await seedBots(original);}
});
