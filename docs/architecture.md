# Vonvon Bot 架构

这份文档说明 Vonvon Bot 的目标架构，以及每个关键决定的理由。实施顺序见 [roadmap.md](roadmap.md)。

## Vonvon Bot 做什么

Vonvon Bot 让飞书机器人把群聊和私聊消息交给你电脑上的 coding agent 处理，比如 Codex 和 Claude Code。一个飞书群对应一个项目目录，群里的一个话题对应一个 agent 会话。

用户在飞书里和 Bot 对话。Vonvon Bot 的桌面端和网页不聊天，只用来设置 Bot、群、会话和本机环境。

Vonvon Bot 是独立产品。它不依赖 feishu-codex-bridge，不调用用户装的 bridge CLI，也不和 bridge 共用数据目录。bridge 的老用户可以把数据导入 Vonvon Bot，导入成功后 bridge 的服务会自动关停。

## 整体结构

整体结构照搬 Paseo（`getpaseo/paseo`，`0009a7e71`，见它的 `docs/architecture.md`）。每台机器跑一个 daemon，桌面端、网页和 CLI 都是连接 daemon 的客户端。

```text
desktop (Electron)      web UI          vonvon CLI
      |                   |                 |
      +--- local: WebSocket to 127.0.0.1 ---+------------+
      |                   |                              |
      +--- remote: via cloud, end-to-end encrypted       |
                          |                              |
                   +------v-------+                      |
                   | Vonvon cloud |  accounts, machines, |
                   +------^-------+  presence, relay     |
                          | outbound from daemon         |
                   +------+-------+                      |
                   |    daemon    | <--------------------+
                   | (1 per host) |
                   +------+-------+
          +---------------+----------------+
   Feishu long conn   agent providers   local data
   (1 child per bot)  Codex, Claude,    ~/.vonvon-bot
                      ACP, OpenCode, Pi
```

daemon 负责这台机器上的一切。它运行 Bot、管理 agent 会话、保存设置，并通过 WebSocket 提供 API。

客户端只读写 daemon 暴露的 API。桌面端、网页、CLI 用同一套协议，区别只在怎么连上 daemon。

云端只做三件事。它管理账号，记录账号下有哪些机器以及是否在线，并在客户端和 daemon 之间转发加密后的数据。

## 关键决定

### daemon 是本机数据的唯一写入者

每台机器只有一个 daemon 进程。它用 `~/.vonvon-bot/daemon.pid` 防止第二个实例启动，做法同 Paseo 的 `packages/server/src/server/pid-lock.ts`。

现在的桌面端、bridge CLI 和 bridge 网页控制台都能改同一份数据，所以 bridge 需要宿主所有权锁和互斥检测。新结构里只有 daemon 写数据，客户端都通过 daemon 改设置，这类冲突不再存在。

Bot 不依赖桌面窗口。关掉窗口或退出桌面端，飞书里的 Bot 照常回复。开启**开机自动运行**后，daemon 注册为系统服务。代码从 bridge 已有的 launchd、systemd 和 Windows 启动项代码改来，但用 Vonvon 自己的服务标识（`com.vonvon.bot.daemon`、`vonvon-bot.service`），绝不读写 bridge 的服务注册。系统服务从 V5 开始提供，具体设计和原生验收见 [plan.md](plan.md) V5 一节的 *Service gate*。V3 的 `vonvon service install` 和 `uninstall` 一律报错退出，因为复制来的服务代码还在用 bridge 的标识。停止 daemon 不删除系统服务注册，关掉开机自动运行才删除。

V3 的 daemon 都由 CLI 启动，没人会再拉起它。停止和重启都先等已经接受的操作做完，并确认它启动的子进程都已退出，才释放 pid 锁，不为赶时间提前放锁。这些子进程包括 Bot 子进程、npm，以及 Codex app-server 和它的进程组。确认不了子进程退出时宁可一直占着锁。关闭 Codex 进程的调用在确认进程退出之前不会返回，清理出错只在确认退出之后才报告，所以上层缓存或忽略这个错误也不会提前放锁。daemon 排空期间仍接受本机凭据认证的连接，但只回答状态查询和停止请求，所以新开的 CLI 能先核实身份再请求停止，不会按 pid 文件里的数字直接发信号。重启后端口不变：一个没有时限的重启助手等旧进程退出后在原端口拉起新进程。旧 daemon 放锁之前收到的停止请求会取消重启：daemon 立即结束重启助手，确认助手已退出后才放锁。具体规则见 [plan.md](plan.md) V3 一节的 *Lifecycle ownership*。

### Bot 运行内核是 vonvon-bot 自己的源码

现在的桌面端 vendor 了 feishu-codex-bridge 的构建产物，并通过 HTTP 调用它。新结构把内核源码复制进 `packages/daemon`，之后两边各自演进。

复制的起点是 feishu-codex-bridge 的 `codex/device-handoff` 分支（`446b2a4`）。现在桌面端 vendor 的就是这个分支，它比 bridge `main` 多 49 个提交，包括桌面端要用的接口、咖啡 Hook 设置和 Codex 用量。

V2 先复制 `446b2a4` 的完整 `src/` 和 `test/`，包括 `src/web`，保留能运行、能对比的 bridge 基线。V2 不增加网页功能。V3 把旧网页控制台的管理路由改成 daemon RPC，然后删除 `src/web`。daemon 没运行时的只读预览页和它的“启动 daemon”按钮一起退役，改用 `vonvon daemon start`，V4 起用 `vonvon open` 打开新界面。私聊菜单卡里指向旧控制台的“网页控制台”按钮也在 V3 去掉，其他按钮不变。等 V4 真正提供新网页后，才考虑加回指向新界面的链接。旧测试里仍然有效的管理行为改成 RPC 测试保留，只有旧页面、静态资源和只读预览的断言可以删除。最终架构不依赖 bridge 的网页控制台。

这样做的理由是独立。vendor 构建产物时，每改一处内核都要在 bridge 仓库提交、发版、再 pin 版本。复制源码以后，一个功能在一个分支里就能改完。

### 设置只存在 daemon 上，云端不存

设置、Bot 列表、群、会话都只存在 daemon 所在的机器上。客户端连上 daemon 才能读到设置，连不上就读不到。这和 Paseo 一样。

理由有三条。第一，设置里有本机路径和 Bot 的 App Secret，不应该离开这台机器。第二，只有一份数据就不需要同步，也不会有冲突。第三，机器离线时 Bot 本来也不在运行，这时改设置没有意义。

### 本机和远程走同一套协议

客户端和 daemon 之间是一套用 zod 定义的 RPC 和事件，跑在 WebSocket 上。本机客户端直连 `127.0.0.1`，用 daemon 写在 `~/.vonvon-bot/local-credential`（权限 0600）里的凭据认证。远程客户端连云端，云端把加密后的帧转发给 daemon。两条路径上的消息完全一样。

协议的起点是现在 `desktop/shared` 下的 zod 合同，也就是 `bridge.ts` 的 `commandSchema` 以及 settings、collaboration、environment、machine 四组请求。`commandSchema` 里的 `quit`、`hideWindow`、`setLoginItem`、`chooseFolder` 只和桌面窗口有关，留在桌面端，不进协议。

在此基础上加两样东西。一是握手，客户端发 `hello`，daemon 回自己的 `machineId`、版本和协议版本。二是机器维度，客户端可能同时连着多台机器。

### 快照给界面，管理状态单独读

daemon 提供两种读状态的方式。`snapshot` 请求和 `snapshot` 事件用 V1 的 `DesktopSnapshot`，供界面使用，带递增的数字 revision。这个数字只出现在快照里，以及 `command` 和 `admin` 里本来就定义为数字 revision 的 `applied` 回复里。settings 和 collaboration 里的字符串 revision 仍是各自设置段或项目的并发令牌，含义和形状都不变。`admin` 组的 `state` 请求原样返回旧网页控制台 `GET /api/state` 的内容。其中 Bot 的字段包括进程号、启动时间和完成提醒，项目的字段包括话题数、分支和创建时间。会话列表走 `settings` 组的 `sessions` 请求。

分开读有三个理由。界面只需要投影后的数据，快照事件不必每次带上进程字段和头像。旧状态的字段一个不丢，V3 能逐字段核对新旧两条读路径。快照形状不变，V4 移植界面时不用改合同。

请求、事件、任务和 revision 的具体规则写在 [plan.md](plan.md) 的 V3 一节。

### 界面沿用现在的 React 界面

界面保留现在的 React 19 + Vite 代码和 `desktop/renderer/reference` 里的 UI 组件，也就是原来的样式。改动是把直接调用 `window.bridge` 的地方换成注入的客户端对象。

同一份界面构建产物用在三个地方：daemon 在本机提供的网页、Electron 桌面窗口、云端托管的网页。

Paseo 的界面是 Expo 和 React Native Web，搬过来要重写全部界面，所以不用。

### 目录选择交给 daemon

现在的桌面端用 Electron 的原生对话框选项目目录，再把结果包成 `FolderToken`。远程客户端打不开另一台机器上的原生对话框，所以新结构由 daemon 提供目录浏览 RPC，所有客户端用同一个。Paseo 的 `directory_suggestions_request` 是同样的做法。

### Provider 层保留 Codex，Claude Code 按 Paseo 重写，其他 provider 从 Paseo 移植

Bot 层调用 agent 的合同仍是 bridge 的 `AgentBackend`、`AgentThread`、`AgentRun`（`src/agent/types.ts`）。这个接口已经有 `capabilities` 和 `approval_request` 事件，能容纳更多 provider，不需要改 Bot 层。

Codex 后端原样保留。它通过 `codex app-server` 的 JSON-RPC 工作，有进程预热池，按模式设置沙箱。

Claude Code 后端改用 Paseo 的实现（`packages/server/src/server/agent/providers/claude/agent.ts`，基于 Claude Agent SDK）。bridge 现在的 Claude 后端有几处缺陷。它所有模式都用 `bypassPermissions`，不支持中途追加消息（`backend.ts` 里 `steer: false`），中断卡住时要杀进程。Paseo 的实现用 `canUseTool` 处理权限，把追加消息推进 SDK 的输入流，中断时先撤回排队的消息再调用 `query.interrupt()`。

其他 provider 从 Paseo 移植，包括通用 ACP（Copilot 也走 ACP）、OpenCode 和 Pi。

Paseo 的 provider 实现的是它自己的 `AgentClient` 和 `AgentSession` 接口（`agent-sdk-types.ts`）。所以加一层适配器，把 `AgentSession` 包成 `AgentBackend`，所有移植来的 provider 共用这一个适配器。Paseo 自己的工具目录和子 agent 存储不搬，provider 里用到它们的地方删掉。

这条决定还没验证。第一个 provider PR 要证明适配器能完整映射事件、权限请求、中断和追加消息。

### 数据目录是 `~/.vonvon-bot`

所有系统都用 `~/.vonvon-bot`，可以用 `VONVON_HOME` 覆盖。用户主目录下的固定路径在没有桌面的服务器上也好找，Paseo（`~/.paseo`）和 bridge（`~/.feishu-codex-bridge`）都是这样。

按 Bot 分目录的形状沿用 bridge（`bots.json`、`bots/<appId>/config.json`、`projects.json`、`sessions.json`），导入时基本是复制。读文件时用 zod 校验，写文件时先写临时文件再改名。

密钥用 `~/.vonvon-bot/master.key`（权限 0600，随机生成）加密。bridge 的密钥由主机名和用户名派生（`src/config/keystore.ts:75`），改了主机名就解不开，所以不沿用。

### 导入 bridge 数据时先停旧服务，成功后再永久关停

导入分两步。第一步是只读预检，列出要导入的 Bot、群、会话和设置，并检查 bridge 是否在运行。用户确认后执行第二步，顺序如下。

1. 暂停 bridge 服务。
2. 复制数据，用新密钥重新加密 App Secret。
3. 把 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 里的咖啡 Hook 命令改成 `vonvon hook`。
4. 在 daemon 里启动导入的 Bot，确认每个 Bot 的飞书长连接已经连上。
5. 永久移除 bridge 的开机自启，并在 `~/.feishu-codex-bridge/` 写入 `migrated-to-vonvon-bot.json` 标记。

任何一步失败，导入都会恢复 bridge 原来的服务。整个过程写 journal，进程崩溃后重新运行会接着做或者回滚。`~/.feishu-codex-bridge` 里的原始数据保持不动，作为备份。

先暂停再复制有两个原因。bridge 运行时还在写 `sessions.json`，边写边复制会得到不一致的数据。另外，两个进程连同一个 Bot 时，飞书的事件会分到两边。按飞书对长连接模式的说明，同一应用的多个客户端只有一个会收到某条事件。这一点还没有实测，roadmap 把它列为要验证的事。

实现参考 vonvon-bridge-legacy 的 `packages/runtime/src/cli-migration-*.ts` 和 `legacy-cli-control.ts`。legacy 只处理了 macOS 的 launchd，Linux 的 systemd 和 Windows 的启动项要新写。

### 账号不是使用前提

不登录也能完整使用本机的 Vonvon Bot，包括导入 bridge 数据。登录只用来把这台机器加到账号下，之后就能在网页或其他设备上管理它。

登录用飞书或 Lark 的网页 SSO，实现参考 vonvon-platform 的 `src/oauth.ts`。桌面端打开浏览器登录，然后轮询结果。没有桌面的服务器运行 `vonvon login`，它打印一个链接和验证码，你在任意浏览器里打开链接确认。

机器加入账号时，daemon 生成自己的设备凭据，和用户的登录会话分开。用户退出登录不会让机器掉线。从账号里移除机器时，云端吊销设备凭据。这个做法来自 vonvon-bridge-legacy 的 `packages/account-service`。

vonvon-bridge-legacy 的 ADR 0012 规定必须登录、暂不做多设备。这份架构推翻了这条决定。

### 远程访问端到端加密

云端存账号和机器记录，机器记录包括名称、系统、版本、公钥和最后在线时间。云端不存设置，也读不到转发的内容。

daemon 加入账号时生成 X25519 密钥对，把公钥登记到云端。远程客户端从云端拿到公钥，和 daemon 协商出会话密钥，之后每一帧都用 XSalsa20-Poly1305 加密。实现用 Paseo 的 `packages/relay`（`crypto.ts`、`e2ee.ts`、`encrypted-channel.ts`）。

这个方案信任云端分发的公钥。如果云端被攻破、换掉了公钥，攻击者可以做中间人。Paseo 用二维码在线下传公钥来避免这一点，代价是每台客户端都要扫码。Vonvon Bot 选择账号登录的便利，这个风险记在 roadmap 里。

同一个 Bot 只能在一台机器上运行，否则飞书事件会分到两台机器。云端不存 Bot 列表，所以由客户端检查。客户端同时连着多台机器时，如果发现同一个 `appId` 在两台在线机器上都启用了，就提示用户。

### 云端代码放在同一个仓库

云端是 `packages/cloud`，和 daemon 共用 `packages/protocol`。改协议的功能在一个分支里就能同时改 daemon、客户端和云端。

vonvon-platform 只有约 1170 行，数据存在一个 JSON 文件里，只能单实例运行。它的飞书和 Lark 登录代码可以直接用，其余部分重写。生产存储用 Postgres，测试用内存实现。部署平台还没定。

### 桌面端只是外壳

桌面端用 Electron。它启动时检查本机 daemon，没在运行就用内置的 daemon 拉起来，方式是用 Electron 自带的 Node 运行（`ELECTRON_RUN_AS_NODE=1`），做法同 Paseo 的 `packages/desktop/src/daemon/node-entrypoint-launcher.ts`。

桌面窗口加载和网页相同的界面。托盘、单实例、自动更新沿用现在 `desktop/main` 的实现。

桌面端内置的 daemon 和 `npm i -g vonvon-bot` 装的 daemon 共用 `~/.vonvon-bot` 和同一把 pid 锁，所以同一时间只会有一个在运行。版本不同时以协议版本判断能否连接。

## 核心数据形状

daemon 上的数据按机器、Bot、群、会话四层组织。

```ts
type Machine = { machineId: MachineId; name: string; platform: string; version: string };

type Bot = { appId: AppId; name: string; enabled: boolean; ownerOpenId: string };

type Project = {
	appId: AppId;
	chatId: ChatId;
	name: string;
	cwd: string;
	provider: ProviderId;
	mode: 'qa' | 'write' | 'full';
	response: 'mention' | 'all';
	sessions: 'threads' | 'shared';
};

type Session = {
	appId: AppId;
	threadId: ThreadId;
	chatId: ChatId;
	cwd: string;
	provider: ProviderId;
	providerSessionId: string;
	model?: string;
};

type SettingsScope =
	| { kind: 'host' }
	| { kind: 'bot'; appId: AppId }
	| { kind: 'project'; appId: AppId; chatId: ChatId }
	| { kind: 'session'; appId: AppId; threadId: ThreadId };
```

`AppId`（`cli_` 开头）、`ChatId`（`oc_` 开头）、`MachineId` 都是 branded 类型。客户端用 `(machineId, appId, chatId)` 定位一个群。

云端只有两种记录。

```ts
type Account = { accountId: AccountId; provider: 'feishu' | 'lark'; subject: string; name: string };

type Device = {
	deviceId: DeviceId;
	accountId: AccountId;
	machineId: MachineId;
	name: string;
	platform: string;
	version: string;
	publicKey: string;
	lastSeenAt: string;
};
```

## 包结构

仓库是 npm workspaces 的 monorepo。

```text
packages/
  protocol/   zod 合同。领域类型、RPC 方法、事件、协议版本
  daemon/     运行内核、API 服务、provider、导入、云端连接，以及 `vonvon` 命令
  client/     TypeScript 客户端。本机直连和云端加密通道两种传输
  ui/         React 界面，网页和桌面共用
  desktop/    Electron 外壳
  cloud/      账号、机器登记、转发、托管网页
```

`vonvon` 命令放在 daemon 包里，`npm i -g vonvon-bot` 就能在服务器上使用。常用命令有 `vonvon daemon start|stop|status`、`vonvon service install|uninstall`（V5 起可用）、`vonvon import feishu-codex-bridge`、`vonvon login`、`vonvon open`。

## 代码来源和许可证

| 来源 | 许可证 | 搬进来的部分 |
| --- | --- | --- |
| feishu-codex-bridge `codex/device-handoff` `446b2a4` | MIT | Bot 运行内核、Codex 后端、系统服务 |
| Paseo `getpaseo/paseo` `0009a7e71` | Apache-2.0 | provider、pid 锁、原子写文件、端到端加密、daemon 拉起方式 |
| vonvon-bridge-legacy `3a16853` | 自有 | 导入流程、旧服务控制、账号服务的设备凭据做法 |
| vonvon-platform `3427634` | 自有 | 飞书和 Lark 网页登录 |
| vonvon-bot PR 栈 `codex/device-handoff` `fab5237` | 自有 | 界面、UI 组件、zod 合同 |

复制 Apache-2.0 代码时保留原文件的版权声明，在仓库根目录加 `NOTICE`，并在改过的文件里注明改动。

## 在哪些系统上能跑

现在的桌面端在 Linux 上跑不起来，因为内核只打包了 macOS 和 Windows 版本。新结构的 daemon 是普通 Node 程序，网页由 daemon 提供，所以 macOS、Linux、Windows 都能跑完整的 daemon 和网页界面。没有桌面的 Linux 服务器也能用无头 Chromium 打开网页截图验证。
