# 私聊 Agent：总设计

owner 2026-11-05 定，经过六轮讨论。产品行为写在 `docs/product.md` 的 3.7、第 4 节和第 6 节，本文只写做法、共享契约和切片。所有切片从 `claude/dm-agent-integration` 开，最后统一进 `dev`，CI 只在集成 PR 上跑一次（`AGENTS.md`"2026-10-30 起"）。行号按基线 `origin/dev` 7dc08110，漂了按函数名找。`D/` 指 `packages/daemon/src/`。

本文取代 `docs/v1-plan.md` 的 s49、s50、s51a、s54a、s54b、s55 里和下面冲突的部分。那几片的原方案是"私聊默认工作区可写、设置工具、回执卡、聊天改设置开关"，都不做了。

## 1. 做什么

管理员私聊 Bot，背后是一个完全访问的 Agent。它带内置 Skill `vonvon-config`，用 `vonvon` 命令行读和改本机所有 Bot 的配置，用内置飞书读取工具看群和文档。用户不用知道有哪些设置，直接说"老抢话，帮我调调"或"照这篇帖子建个群"。

**私聊的定位（owner 2026-11-05）：** 目标是把 Bot 做得像人，私聊就像和一个同事私聊。可以让它改在群里的行为（其实就是改配置），给它安排事情，也可以单独聊、一起做事。要协作的工作尽量在群里做，因为群里还有别的人和别的 Bot。这只是引导，不拦：Skill 和文案可以这样说，vonvon 不挡私聊里的工作。

要做的是三块地基和一层能力：

1. **管理员**：只有一种角色，是私聊唯一的门（第 3 节）。
2. **私聊项目**：每个 Bot 一个固定的项目，私聊走和群一样的回合路径（第 4、5 节）。
3. **飞书工具**：所有群、私聊和云文档评论都能读；Bot 有编辑权限的文档能直接改。一律用 Bot 自己的身份，不依赖 lark-cli，不借用户的权限（第 7 节）。
4. **配置能力**：权限表放开到所有 Bot，加 `vonvon-config`（第 6、9 节）。

不做：

- 影子索引和记忆优化（owner 以后做，这批的读取工具是它的基础）。
- 群和云文档评论里，改已有文档以外的飞书写操作。私聊能做，用通用工具（第 7.6 节，owner 2026-11-05）。lark-cli 本身不动，owner 以后整理。
- 设置回执卡和撤销（3.7 已推迟）。
- 群里改设置。
- 按人分权限。
- vonvon 对 Agent 行为的约束：帖子可不可信、改之前要不要确认、读到的内容算不算指令，都是 Agent 自己的事。vonvon 只提供能力（owner 2026-11-05）。

## 2. 已定的事

| 事 | 定法 |
|---|---|
| 档位 | 私聊固定完全访问，没有第二档 |
| 门 | 只有 vonvon 的管理员名单，消息到 Agent 之前查 |
| 范围 | 本机所有 Bot 和它们的群，一种范围，没有开关，私聊不用 `--scope` |
| 角色 | 只叫管理员，至少一个，注册进 Bot 的人默认是。飞书的名单不自动算数。群命令、Bot 记忆和操作这台电脑绑在一起，接受 |
| 候选人 | 扫码的人一定在；飞书应用的管理员和开发者（开了可选权限）；私聊被拒的人；群成员。选人，不填 Open ID |
| 管理员入口 | 全局设置新加"管理员"，排在"飞书连接"后面。页面列出每个 Bot，名单仍按 Bot 存。聊天里不能改 |
| 私聊项目 | 每个 Bot 一个，放在 `<data>/projects/<bot>/dm/`，用户不选，新 Bot 和升级上来的 Bot 都自动建；默认只有内置 Skill |
| 普通文字 | 进 Agent。`/menu` 出原来的卡片，`/settings` 不列出，效果同 `/menu`；其余斜杠命令和群一样 |
| 不能做 | 注册 Bot、改凭据；API key；管理员名单；停止、重启、升级、后台服务；配对和远程连接；删除 Bot、停用当前 Bot；Provider 和 lark-cli 登录；Bridge 导入。其余都能做，包括绑群和解绑 |
| 人点卡片 | `/menu` 的重启、更新这些按钮不算 Agent 做的，人点照旧能用 |
| 定时任务 | 给群建的发群里，私聊建的发私聊里。私聊任务运行时没人在场，也能读能改，按创建人的身份跑 |
| 飞书工具 | 读：消息、话题、单条消息、图片和文件、群公告和成员、文档（含知识库）、表格、云空间文件下载、搜索消息。改：文档。Skill 调工具，工具调飞书 |
| 飞书身份 | 读和改都用 Bot 自己的身份。Bot 能读的文档就读，能改的就改，不借用户的权限（owner 2026-11-05）。文档权限靠用户分享给 Bot |
| 权限 | 必需的不增加；一键开通链接不加这批新权限；缺权限时给预选好的链接，并说明要发布新版本 |
| Skill | 3 个：`vonvon-schedule`、`vonvon-feishu`（合并原 `vonvon-feishu-message`）、`vonvon-config`（只给私聊） |
| 风险 | 管理员让看某个群，就是管理员授权的。工具不标注"别人说的"，不做风险判断 |
| 私聊设置入口 | Bot 页"已加入的飞书群"列表最上面一行"私聊"，点开是和群同样的页面，能复用群的设置就复用；聊天方式只有连续交谈和智能两档（owner 2026-11-06） |

## 3. 管理员（A1、A2）

### 3.1 判断

`D/config/schema.ts`：

```ts
export function isAdmin(cfg: AppConfig, senderId: string): boolean {
  return Boolean(senderId) && Boolean(cfg.preferences?.access?.admins?.includes(senderId));
}
/** 替 Bot 说话时要一个人：创建者还是管理员就是创建者，否则是名单第一个。不代表权限比别人大。 */
export function primaryAdmin(cfg: AppConfig): string | undefined {
  const { ownerOpenId, admins = [] } = cfg.preferences?.access ?? {};
  return ownerOpenId && admins.includes(ownerOpenId) ? ownerOpenId : admins[0];
}
```

- `access.ownerOpenId` 继续存扫码的人，意思收窄成"创建者"，只给界面的小标签和候选人用，不参与判断。
- `resolveOwner` 删除。调用点换成：
  - `handle-message.ts` 的 `collaboration()`（拉谁进新群，第 6.4 节）和 bot-added 通知（`:9259`）用 `primaryAdmin`；
  - `host/crash-notify.ts:108` 发给这个 Bot 的**每个**管理员（3.10）；
  - `admin/settings.ts:679-684`、`:1193-1196`、`cli/commands/settings.ts:242-248` 不再分主人。
- `isOwner`、`NOT_OWNER_MESSAGE`、`dmOwner`、`not-owner` 删除。`roleOf`（`agent/entry/registry.ts:244`）只回 `admin`、`member`、`bot`。
- 存盘里已有的 `role: 'owner'`（任务的 `createdBy`、记忆的 `actorRole`）读的时候照旧认，等同 admin；不再写新的。
- `app-roles.ts` 的刷新留着，只给候选人用。`ask-coordinator.ts:74` 的 `eligible` 和 `administratorIds` 去掉飞书名单。`/resume` 的"只在主人私聊列"去掉：私聊只列这个私聊窗口自己的会话，归属不明的不列。

### 3.2 升级

Bot 进程启动时做一次，做完写 `access.adminsVersion: 2`：

1. `admins` 去重，加上 `ownerOpenId`。
2. 结果是空的，再加飞书快照里的 `ownerOpenId`。
3. 还是空的（老数据才会这样），不猜。客户端在管理员页和 Bot 列表显示"这个 Bot 还没有管理员"，私聊的人进候选人。

必须有这个版本号：没有它，每次启动都会把被用户移除的创建者加回来。

飞书名单里另外的管理员升级后不再算（owner：老数据兼容可以不管）。

### 3.3 改名单

只有桌面端、网页和终端能改。`settings.act.adminMember` 的私聊格改成 `deny`（第 6.2 节）。`/menu` 的管理员页只读，旧卡片上的增删按钮一律只重画成只读卡。

移除时，`admin/settings.ts` 的 `adminMember` 分支在同一个 Bot 进程里按顺序做：

1. 只剩一个时拒绝："至少要有一个管理员。"创建者没有特殊保护，别人还在就能移除。
2. 写 `preferences`。写完以后 `isAdmin` 立刻是 false，后面的 ★ 检查随之拒绝。
3. 停掉这个人私聊窗口里在跑的回合，清空排队的消息。
4. 作废这些会话的令牌（`sessions.revoke`）。
5. 暂停这个人的私聊定时任务，`pausedReason: 'admin-removed'`。再加回来也不自动恢复，要手动。

第 3 到 5 步失败只记日志，名单照样改完：第 2 步已经把门关上了。

群里的任务不暂停，它属于群。

`refresh-bot.ts:35` 去掉 `isAdmin` 检查，只核对扫码返回的 `clientId === appId`：能扫出这个应用的人本来就是它的管理员或开发者。否则创建者被移除后就换不了凭据。

### 3.4 候选人

`AgentSettingsView.administrators` 加：

```ts
candidates: { openId: string; name: string; sources: ('creator' | 'feishu' | 'refused')[]; at?: number }[];
```

| 来源 | 怎么来 | 读不到名字时 |
|---|---|---|
| `creator` | `access.ownerOpenId`，不管在不在飞书名单里 | 显示"创建者"，永远列出 |
| `feishu` | 开了 `application:application:self_manage` 时的所有者和协作者 | 不列 |
| `refused` | 私聊被拒的人，存 `<botDir>/dm-refused.json`，最多 20 人，30 天过期 | 不记 |

群成员不进这个字段：界面选一个群，走已有的 `command.listGroupMembers` 现查。

名字只从飞书读：`contact/v3/users/batch`，失败时被拒的人再试 `GET /im/v1/chats/<p2p>/members`（2026-11-05 对一个用户实测能读到，A2 要用通讯录范围外的人再测一次）。消息内容里的名字一律不用，免得有人私聊说"我是张三"，管理员点一下就把电脑交出去。

### 3.5 被拒的人

非管理员私聊，在转写语音、下载附件之前就挡下：

- 回一句："你还不是这个 Bot 的管理员，请管理员在 Vonvon Bot 的「设置 → 管理员」里添加你。"同一个人 10 分钟回一次。
- 记进 `dm-refused.json`。
- 不再用"⛔ 仅管理员可在私聊里管理项目。"（`dm-console.ts`、`handle-message.ts:9457`）。

### 3.6 管理员页（A2）

- 设置的一级页"管理员"，排在"飞书连接"后面，加进 `search.ts`。
- 每个 Bot 一段：头像、名字，下面是管理员行（头像、姓名，创建者带小标签「创建者」），右边移除。
- "添加管理员"打开选人弹窗：上面是候选人，下面可以选群再选人，都能搜。没有填 Open ID 的入口，`SettingsPanel.tsx:879-930` 的手动输入删掉。
- 页底一句："管理员能通过私聊操作这台电脑和这台电脑上的所有 Bot。"按 Bot 存不代表权限只到这个 Bot。
- 移除确认框写清：这个人正在跑的私聊会停下，私聊定时任务会暂停。

能打开客户端的人，包括配对过的设备，都能改这个页面（3.14"能连上的都当主人本人"）。

## 4. 私聊项目（D1）

### 4.1 存法

`projects.json` 里每个 Bot 多一行，用 `Project` 同一个形状，加一个字段：

```ts
interface Project {
  /** 这一行是这个 Bot 的私聊。键是飞书的 p2p chat_id，每个私聊过的管理员一个 */
  dm?: { people: Record<string, { openId: string; name?: string; at: number }> };
}
```

| 字段 | 值 |
|---|---|
| `chatId` | `oc_dm_<appId>`，界面和命令行指代这一行用，不是飞书的 id。形状过得了 `groupIdSchema` |
| `name` | `私聊`，只显示，不按名字查 |
| `cwd` | `<data>/projects/<bot>/dm`，启动时建 |
| `blank`、`origin`、`kind`、`noMention`、`mode` | `true`、`created`、`single`、`true`、`full` |
| `backend`、`defaultModel`、`defaultEffort`、`modelAccess` | 建这一行时取 `execOf(undefined)` 和 `pickGroupDefault(undefined, …)` 当时算出的值，之后就是私聊自己的。和 Bot 默认分开，因为 Bot 默认还是云文档评论的后备 |
| `projectId` | 没有。私聊不在项目库里，没有项目记忆 |

用一行而不是每人一行：设置只有一份，模型和能力页直接复用；用 `Project` 形状：`handle-message.ts` 里几十处读 `project` 的代码不用分支。

### 4.2 读写

`D/project/registry.ts`：

- `listProjects()`、`getProjectByName()` **过滤掉** `dm` 行。所有没想到私聊的代码默认看不见它，绑定列表、快照、群设置、解绑都不受影响。
- `getProjectByChatId(id)` 和同步版：先按 `chatId` 找；再找 `dm.people[id]`，命中时返回 `{ ...row, chatId: id }`，这样回合、会话、定时任务拿到的就是真实的 p2p chat_id。`oc_dm_<appId>` 命中时返回原行，给设置用。
- 新增 `dmProject()`、`rememberDmChat(chatId, openId, name?)`。`rememberDmChat` 在这个人第一次私聊时写，放在进入回合之前，定时任务靠它从 chat_id 找回私聊。
- 按 `chatId` 改行的函数统一走 `rowIndexOf(rows, chatId)`，p2p chat_id 也映射到 `dm` 行。
- 过一遍所有绕过 `listProjects` 直接读行的地方（`storedRows`、`withStoredRows`、`directory-audit.ts`、启动时给行连项目库的代码、`splitTierChats`），`dm` 行一律跳过。

`D/bot/dm-project.ts` 的 `ensureDmProject()` 在 Bot 进程启动时跑，幂等，新 Bot 和升级上来的 Bot 走同一条路。失败只记日志，这时私聊只有 `/menu` 能用，回一句"私聊项目没建好，请到 Vonvon Bot 的诊断页看看"。

`dm` 行不能解绑、不能删、不能改名，`settings save.project` 对它只接受 `model`、`speed`、`modelAccess`、`skills`，其余返回错误。

### 4.3 多个管理员

目录共用，会话和记忆按人分开。`/resume` 按 `rec.chatId === msg.chatId` 列，所以看不到别人的会话。文件是共用的，互相看得到，这是有意的：管理员本来就都能操作这台电脑。

## 5. 私聊回合（D2）

`handle-message.ts` 的 p2p 分支（`:2716`）改成：

```ts
if (msg.chatType === 'p2p') {
  if (await syncCopy.skip(msg, true)) return;
  if (fromBot(msg)) return;
  if (!isAdmin(cfg, msg.senderId)) return refuseDm(msg);        // 第 3.5 节，转写之前
  if (msg.rawContentType === 'audio') { /* 照旧转写 */ }
  if (askAnswered(msg)) return;
  if (isMenuCommand(msg)) return handleDmConsole(channel, cfg, msg);
  await rememberDmChat(msg.chatId, msg.senderId, name);
  // 往下和单会话群同一条路：parseCommand、turnSession、handleTurn
}
```

- **提问卡**：`asks.dmText` 现在把提问显示期间的任何私聊文字都吃掉。改成只有**回复那张卡**的消息才算回答（`quotedId(msg)` 等于这张卡的 message_id）。其余文字进 Agent，提问卡不受影响。卡片文案改成"点卡片回答，或回复这张卡"。
- **`/menu`**：`isMenuCommand` 认 `/menu` 和 `/settings`。卡片保留，文案"私聊用于建项目和管理；具体任务请到项目群里 @我"改成"直接跟我说就行。这里是常用入口。"`/help` 在私聊多列一行 `/menu`，群里不列。
- **位置**：`handle-message.ts` 里 9 处写死的 `{ kind: 'group', chatId }` 改成 `placeOf(project, chatId)`，`dm` 行给 `{ kind: 'p2p', chatId }`。`createWithPermission` 的 `place.kind === 'group'` 判断同样放宽。这之后 `sessionEnv` 发的就是私聊令牌，`authorizeNow` 的 `grant.place.kind === 'p2p'` 也成立。
- **`profileOf`**：`dm` 行用 `builtinPackage('dm')`，`tools` 打开 `schedule` 和 `feishu`，`contextSourcesFor` 给 `{ kind: 'dm', person }`，带角色设定、Bot 记忆和这个人的私聊记忆，不带项目记忆。
- **挡路的群检查**：`isChatAllowed`、`isUserAllowedInProject`、群解绑相关的判断对 `dm` 行直接过。门只有第一步的 `isAdmin`。
- **会话键**：`msg.threadId ?? msg.chatId`，和群一样。主区一条，话题各一条，`/new` 换一条。
- **运行设置**：运行中来了消息、卡片显示、完成提醒都没写在 `dm` 行，读 Bot 层的默认值。
- **删除**：`chatSettingsOn` 和它的拒绝原因 `switch-off`；`command-tools.ts` 里没接通的 `settings_get/access/set`。私聊的 Agent 只用命令行改设置。

### 私聊记忆（D3）

- `memory-writer.ts:113` 的 `storeFor` 接上 `memory-store.ts:65` 已有的 `dm` 位置。键用 `d_<openId>`。
- `memory-authority.ts` 已有 `turn.place === 'dm'` 的分支，只需要接通。
- 记忆页在私聊下按人分组，读 `dm.people`。没有项目记忆。

### 第一次见面（D5）

owner 2026-11-05 定。只给新注册的 Bot，老 Bot 不管：现在只发给了内部老用户。

- **客户端：** 注册完保留建群的引导，再加一个"去飞书私聊"，打开 `https://applink.feishu.cn/client/bot/open?appId=<id>`。两个都给，用户自己选。
- **Bot 主动开口：** 权限开通并发布、Bot 第一次发得出私聊时，给创建者发一条，只发一次。发不出去（权限还没开通、还没发布、不在可用范围）就等下次再试，不报错。发过的记在 `access`，老 Bot 不补发。
- 这条是固定文字，不跑 Agent：这时 Provider 可能还没登录。用户回一句就进普通的私聊回合。内容像新同事打招呼，说能帮什么，举两三个例子，并提一句一起做的事拉进群更合适。

```text
你好，我是{Bot 名}，有事私聊找我就行。
你可以让我改在群里的表现，比如"在测试群少说话"；
给我安排事情，比如"每天早上汇总一下这个群"；
也可以就在这里聊，让我查东西、改文档。
要和大家一起做的事，把我拉进群里更合适。
```

## 6. 权限表（C1）

### 6.1 范围

`D/server/authz.ts`：

- `withinReach` 开头：`principal.place === 'dm'` 时直接过，不看 Bot、群和项目。一种范围就是不查范围。
- `checkSessionScope`：私聊不要求 `--scope`，给了也不起作用。私聊会话的环境里不再设 `VONVON_SCOPE`。`daemon-client.ts` 有令牌、没 scope 时照常握手。
- `sessionSnapshot`：私聊返回所有 Bot 的快照，只去掉 `crashes` 和 `diagnostics`。
- `askBot(principal.appId, …)` 不变：★ 只问**会话所在 Bot**这一轮还在不在、是不是管理员。实际操作照常发给请求里写的目标 Bot。

这张表是防误操作的，不是安全边界。完全访问的会话能读本机凭据，也能直接改名单文件。名单安全，只因为门在 Bot 进程里读它、而且在消息到 Agent 之前读；不是因为 Agent 写不了。

### 6.2 不能做的

私聊格为 `deny`：

| 分组 | 行 |
|---|---|
| 注册和凭据 | `command.registerAgent`、`refreshAgentCredentials` |
| 删除 | `command.deleteAgent` |
| 服务 | `command.restartHost`；`machine.service.*`、`setServiceSkipped`、`startHost`、`stopHost`、`checkCoreUpdate`、`applyCoreUpdate`、`coreUpdateStatus`、`desktopUpdateReport` |
| 导入 | `machine.bridgeImport.*` |
| 登录和安装 | `environment` 下全部写操作和登录（`backendInstall`、`backendLogin`、`install`、`startLogin`、`profile*` 等） |
| 密钥 | `admin.secrets`、`setSecret`、`removeSecret`、`testSecret` |
| 配对和远程 | `device.*` |
| 管理员名单 | `settings.act.adminMember` |

`command.setAgentEnabled` 单列：目标是会话自己的 Bot 时拒绝，否则这一轮会把自己的私聊断掉；别的 Bot 可以。

其余行私聊格一律 `bot`，包括现在是 `deny` 的 `command.bindGroup`、`collaboration.removeProject`、`stop`、`settings.save.host`、`machine.mcp.*`、`machine.logs`、`memory` 全部、`schedule` 全部，和 `environment` 的只读行（`scan`、`backendCatalog`、`backendVersion`、`authStatus`）。

拒绝文字告诉用户去哪里做，例如"这件事要在 Vonvon Bot 客户端或终端里做"。

### 6.3 这一轮的检查

`agent/entry/registry.ts` 的 `authorizeNow`、`adminTurn`、`authorizeSchedule` 在私聊下合成一条：

```ts
function dmTurn(grant, auth) {
  // 入口活着、这一轮还在
  if (auth.human) return opts.isAdmin(auth.facts.requesterOpenId ?? '') ? undefined : refused('not-admin');
  if (auth.presence === 'scheduled') return opts.isAdmin(creatorOf(auth)) ? undefined : refused('not-admin');
  return refused('not-human-turn');
}
```

私聊定时任务的 `facts.requesterOpenId` 填创建人。人和任务在私聊里权限一样（owner 2026-11-05）。创建人不再是管理员时，任务本来已经暂停（第 3.3 节），这里再挡一次。

### 6.4 飞书的 id 跨 Bot 不通

open_id 按应用分。A 里查到的 id，写进 B 的白名单、拉进 B 的群都无效，而且可能悄悄失败。规则：

- **会话的 Bot 和目标 Bot 不同时，daemon 不接受 A 的 open_id。** `settings.act.projectMember` 这类写人名单的请求，目标 Bot 用 `listGroupMembers` 核对这个 id 在它能查到的人里，不在就拒绝："这个 ID 不是 Bot B 查到的。用 `vonvon feishu members --bot B` 查。"
- **建群拉人。** `collaboration.createProject` 目前拉的是 `resolveOwner`，改成：
  - 私聊回合：拉发起人。同一个 Bot 用 open_id；跨 Bot 用 `union_id`（事件的 `sender_id.union_id`，随 `TurnFacts` 带上，`user_id_type: 'union_id'`）。union_id 在同一开发主体下相同，所以另一个组织的 Bot 会失败，这时不建群，拒绝并说明："Bot B 拉不了你。可以你自己建群、把 B 拉进去，再让我绑定。"
  - 桌面端和终端：`primaryAdmin`，和今天一样。
- **记录创建人。** 跨 Bot 建的任务和写的记忆只记名字，不记 open_id。任务失败提醒里不 @，写名字。

### 6.5 飞书应用权限

`D/config/scopes.ts` 不动 `REQUIRED_SCOPES` 和 `GRANT_SCOPES`。新增分组（权限名以 F1 实测为准，见第 7.5 节）：

| 分组 | 权限 | 没开时少什么 |
|---|---|---|
| `DOC_READ_SCOPES` | 云文档读取，加已有的 `wiki:wiki:readonly` | 读不了文档和知识库 |
| `DOC_EDIT_SCOPES` | 云文档编辑 | 改不了文档 |
| `SHEET_READ_SCOPES` | 表格读取 | 读不了表格 |
| `BITABLE_READ_SCOPES` | `bitable:app:readonly` | 读不了多维表格 |
| `DRIVE_READ_SCOPES` | 云空间文件下载 | 下载不了云空间文件 |
| `SLIDES_READ_SCOPES` | `slides:presentation:read` | 读不了幻灯片 |
| `MINDNOTE_READ_SCOPES` | `mindnote:node:read` | 读不了思维笔记 |
| `BOARD_READ_SCOPES` | `board:whiteboard:node:read` | 读不了画板 |
| `MINUTES_READ_SCOPES` | `minutes:minutes:readonly`、`minutes:minutes.transcript:export` | 读不了妙记 |
| `LEGACY_DOC_READ_SCOPES` | `docs:doc:readonly` | 读不了旧版文档 |
| `DRIVE_LIST_SCOPES` | `space:document:retrieve` | 看不了云空间文件夹里有什么 |
| `WIKI_READ_SCOPES` | `wiki:space:retrieve`、`wiki:node:retrieve` | 看不了知识库和它的目录 |
| `COMMENT_READ_SCOPES` | `docs:document.comment:read`，`GRANT_SCOPES` 里已有 | 读不了文档评论 |
| `DOC_MEDIA_SCOPES` | `docs:document.media:download` | 下载不了文档里的图片和附件 |
| `MESSAGE_SEARCH_SCOPES` | `search:message` | 搜不了消息 |

这几组合成 `FEISHU_TOOL_SCOPES`，单独一个预选链接，不进 `GRANT_SCOPES`。

原因（2026-11-05 查证）：飞书没有通用的免审名单，免审由各企业管理员配置，飞书只推荐普通权限免审、高级权限审核。`GET application/v6/applications/:app_id` 返回应用已有权限的等级，这一批全是高级。测试企业把它们都标成免审，不能外推到别的企业。放进第一次的链接，企业管理员要审的范围变大，被拒时连收发消息一起受影响。

`GRANT_SCOPES` 里已有的可选高级权限（文档评论等）不动：必需权限里有 8 个高级权限，企业第一次发布按推荐规则本来就要审核。

状态接口的 `scopes` 加 `missingTools`（缺的 `FEISHU_TOOL_SCOPES`）和 `toolsGrantUrl`（只预选缺的）。状态与诊断页的权限行里加一行"飞书文档能力"，缺时给这个链接，开通后要发布新版本。这一行不算未就绪，不进开通向导。工具缺权限时照第 7.5 节回复。

## 7. 飞书工具（F1、F2、F3、F4）

### 7.1 工具

代码放 `D/feishu-read/`，只用 Bot 的 tenant_access_token，不碰 lark-cli。

| 工具 | 读什么 | 接口 | 权限 |
|---|---|---|---|
| `feishu_messages` | 群或话题的消息，按时间和游标翻页 | `im/v1/messages` | 必需，已有 |
| `feishu_message` | 单条消息，合并转发展开 | `im/v1/messages/:id` | 必需，已有 |
| `feishu_file` | 消息里的图片和文件，下载到收到附件时的同一个目录 | `im/v1/messages/:id/resources/:key` | 必需，已有 |
| `feishu_chat` | 群名、描述、公告 | `im/v1/chats/:id`、公告接口 | 公告必需，群信息可选 |
| `feishu_members` | 群成员 | 已有 | 已有 |
| `feishu_doc` | 文档和知识库页面，转成文本；旧版文档也走它（F6） | `docs_ai/v1/documents/:id/fetch`，回退 `docx/v1/documents/:id/raw_content`，旧版文档 `doc/v2/:token/raw_content`；知识库先解析节点 | 可选 |
| `feishu_sheet` | 表格区域 | `sheets` 接口 | 可选 |
| `feishu_base` | 多维表格的数据表、字段、视图和记录，记录可按视图和条件筛选（F4） | `bitable/v1/apps/:app_token/...`，记录走 `records/search` | 可选 |
| `feishu_drive_file` | 下载云空间文件 | `drive` 接口 | 可选 |
| `feishu_folder` | 云空间文件夹里有什么（F5） | `drive/v1/files` | 可选 |
| `feishu_wiki` | 知识库和它的目录（F5） | `wiki/v2/spaces`、`.../nodes` | 可选 |
| `feishu_comments` | 文档的评论和回复（F5） | `drive/v1/files/:token/comments` | 可选 |
| `feishu_doc_media` | 下载文档里的图片和附件，到 `feishu_file` 同一个目录（F5） | `drive/v1/medias/:token/download` | 可选 |
| `feishu_slides` | 幻灯片全文（F6） | `slides_ai/v1/xml_presentations/:id` | 可选 |
| `feishu_mindnote` | 思维笔记的节点（F6） | `mindnotes` 接口 | 可选 |
| `feishu_board` | 画板的节点（F6） | `board/v1/whiteboards/:id/nodes` | 可选 |
| `feishu_minutes` | 妙记的信息和文字记录（F6） | `minutes/v1/minutes/:token`、`.../transcript` | 可选 |
| `feishu_api` | 用 Bot 身份调任何飞书接口，能读能写，只在私聊（F7，第 7.6 节） | 任意 | 用到什么要什么 |
| `feishu_search` | 搜消息 | `im/v1/messages/search` | 可选，待实测 |
| `feishu_doc_edit` | 改文档：追加、插入、替换选中内容（F3） | `docs_ai/v1/documents/:id` 的更新接口，机器人身份用不了就走 `docx/v1/documents/:id/blocks` | 可选 |

消息的渲染复用 `bot/context-weave.ts`，它已经能读别的 Bot 的卡片。单次结果不超过 `TOOL_RESULT_BYTES`，超了带游标。输出就是内容本身，不加"这是别人说的"这类标注。

### 7.2 能读到哪里

| 位置 | 消息、文件、公告、成员 | 文档、表格、多维表格、云空间 |
|---|---|---|
| 群会话 | 只有本群。`chat` 参数给别的群直接拒绝；`feishu_message` 取回来后核对 `chat_id` 是本群，不是就拒绝 | Bot 读得到的都能读 |
| 私聊会话 | 本机任何 Bot 所在的任何群 | 同左，可以指定用哪个 Bot 读 |
| 云文档评论 | 没有群，这些工具不给 | 同群会话 |

文档不按群隔离：Bot 的文档权限是用户分享给它的，分享给 Bot 就是让它用（owner 2026-11-05）。

工具跑在 Bot 进程里，不走沙箱，所以只读档的群也能读。这正是不靠 lark-cli 的原因之一。

`feishu_doc_edit` 也不走沙箱，所以要自己守档位：`SessionProfile.tools.feishuEdit` 按这条会话的档算，只读档不给，调用时再看一次当前的档。档位变了会话本来就会重建（`createWithPermission`）。

### 7.3 接线和跨 Bot（F2）

- `SessionProfile.tools` 加 `feishu`。Claude 走进程内 MCP `vonvon_bot`；Codex 走 dynamic tools，`scheduleNamespace` 改名 `vonvonNamespace`，`offeredTool` 的名单加上这些工具。
- Codex 的工具表在建线程时固定，旧线程没有这些工具。Skill 里写一句：工具不在，就告诉用户发 `/new`。
- **跨 Bot**：工具用会话所在 Bot 的身份，A 进不了只有 B 在的群。私聊下工具多一个可选参数 `bot`：
  - `chat` 给了、`bot` 没给：host 查哪个 Bot 绑了这个群，优先当前 Bot，否则路由到第一个绑了它的 Bot。
  - 文档没给 `bot`：先用当前 Bot 读，没权限时回复里列出本机其他 Bot，让 Agent 换。
  - 路由走 `HostApi.feishuRead(botId, request)`，host 转给 B 的进程，用 B 的身份读。B 没在跑时回"Bot B 没在运行"。
- **命令行**：`vonvon feishu messages|message|file|chat|doc|sheet|drive|search`，RPC `command.feishuRead`，权限表 `{ dm: 'bot', group: 'bot', comment: 'deny' }`，群会话按 7.2 的范围。和工具调同一组函数，`cli/parity-allowlist.ts` 过得了。

### 7.4 云文档评论（F3）

评论会话今天的默认指令写着"用 lark-cli 读 / 改这篇文档"（`bot/comments.ts:268`），用的不是 Bot 的身份。改成：

- `profileOf(…, 'comment')` 打开 `tools.feishu` 和 `tools.feishuEdit`。评论会话的位置是 `{ kind: 'doc', docId }`，工具走一个新的 `authorizeFeishu`：入口活着、这一轮还在，只放第 7.2 节里文档这一列的工具。评论 @bot 只响应管理员（`handle-message.ts:9001`），这条不变。
- `DEFAULT_COMMENT_INSTRUCTIONS` 的"怎么做"改成：用 vonvon 的飞书工具读和改这篇文档，身份是 Bot 自己；Bot 没有权限时在回复里说清楚要用户做什么，不要换别的身份去读或改。"不要删被评论的原文"这条留着。用户改过的指令文件不动。
- 表格和多维表格上的评论：能读（多维表格用 F4 的 `feishu_base`），不能改，回复里说明。要改的话到私聊里说（第 7.6 节）。

### 7.5 缺权限和实测

没有权限分两种，回复不一样：

| 情况 | 工具回 |
|---|---|
| 应用缺权限（`utils/feishu-error.ts` 的 `scopeDenial`） | 少了什么、影响什么、`buildScopeGrantUrl(appId, tenant, [缺的权限])` 的链接、"开通后要发布新版本才生效；打不开这个链接，就转给这个飞书应用的管理员。"跨 Bot 时给 B 的链接 |
| 应用有权限，但这篇文档没分享给 Bot | "这篇文档还没分享给 Bot。在文档右上角的分享里搜「Bot 名」，给阅读权限。" |
| Bot 只有阅读权限，要改 | 同上，说要给编辑权限 |

管理员不再绑定飞书身份，这个人可能进不了飞书后台，所以第一种的最后一句不能省。

F1 开工先用测试 Bot 实测：真实文档（`docs_ai` 只用假 id 碰到过接口）、知识库、表格、云空间下载、`search:message` 能不能用机器人身份，以及机器人身份改文档走哪个接口、文档没分享时各返回什么错误码。不能用的工具不上，写进 PR。权限名以实测为准。开通权限和发版由 Mac 上的 Codex 用 ego-browser 做。

### 7.6 通用工具（F7）

owner 2026-11-05 定（方案三）：私聊里 Bot 有权限的飞书操作都能做，比如往多维表格加记录、建新文档、查日历和审批。专门工具总有漏的，管理员私聊时不该被挡住。这取代第 7 节原来"这批不做通用工具"。

- `feishu_api({ method, path, params?, body?, bot? })`，用会话所在 Bot 的 tenant_access_token，也可以用 `bot` 指定本机另一个 Bot（第 7.3 节，F2 接上之前只有当前 Bot）。
- **只在私聊：** `SessionProfile.tools.feishuApi`，只有 `dm` 行打开。群和云文档评论的工具表里没有它，调用时再核对位置是 `p2p`、这一轮是管理员或管理员的私聊定时任务（第 6.3 节）。这样一个群读不到别的群，也写不了飞书内容。
- `path` 必须以 `/open-apis/` 开头，host 固定用这个 Bot 的租户。拒绝 `/open-apis/auth/`：换令牌的接口没有用，只会把令牌写进记录。这是防误操作，不是安全边界（第 6.1 节）。
- 回复是飞书的原文，不超过 `TOOL_RESULT_BYTES`，超了说明被截断、让 Agent 缩小范围。二进制响应存到 `feishu_file` 同一个目录，回路径。
- 缺权限走第 7.5 节的回复：飞书的错误里带着缺的权限，给预选好的链接和"开通后要发布新版本"。写权限不预先开，用到时才开。
- `vonvon-feishu` 只教怎么用：先用专门工具；没有专门工具时查飞书开放平台文档（链接加 `.md` 能读到文本），再调 `feishu_api`。不写 Agent 该不该改、要不要先确认。

## 8. 定时任务（C2）

任务仍属于一个（Bot，chat）。`chatId` 现在可以是 p2p chat_id。

- `placeScheduled`（`:9840`）写死的 `chatType: 'group'` 按 `project.dm` 取。`getProjectByChatId` 已经能找到私聊（第 4.2 节），`ruleKind` 是 `single`，走主区一条会话，不开话题。
- 工具不变：在私聊里调任务工具，任务建在这个私聊。
- 给群建任务走命令行：`vonvon schedule add --bot B --group X`。`schedule-commands.ts` 的 `ScheduleActor` 加 `kind: 'dm'`（`{ openId?, name?, chatId }`），跳过 `request.chatId !== actor.chatId` 这条。`not-group` 的文字只留给评论。
- 跨 Bot 建的任务 `createdBy` 不写 open_id（第 6.4 节）。
- 群任务建好以后就是普通的群任务，按群的权限档跑，3.13 的规则不变。
- `pausedReason` 加 `admin-removed`。任务页显示"创建人已不是管理员"。
- `listBot` 带上私聊任务，桌面端标"私聊 · 张三"。上限照旧（一个 chat 20，一个 Bot 200）。

私聊任务运行时不走 `no-human-create` 和 `scheduled-run-scope`：它和人在场时一样（第 6.3 节）。

## 9. Skill（C3）

`agent/builtin-skills/registry.ts`：

```ts
export function builtinSkillsOfSet(set: 'group' | 'dm'): BuiltinSkill[] {
  switch (set) {
    case 'group': return [scheduleSkill, feishuSkill];
    case 'dm': return [dmScheduleSkill, dmFeishuSkill, configSkill];
  }
}
```

`thread.ts:120` 的 `BUILTIN_SKILL_NAMES` 取两组的并集。两组的 `vonvon-schedule`、`vonvon-feishu` 名字相同，私聊用自己的文字：群的文字照旧不教命令行（`settings-dm-only`），私聊的任务、读取范围和写操作都和群不一样，写在一起会把另一边的规矩教给这一边。

- **`vonvon-feishu`**：合并 `vonvon-feishu-message` 的卡片、图片、文件做法，加读取工具的用法。写操作照旧，不提 lark-cli 的取舍。升级后老名字的 `SKILL.md` 由 `writeBuiltinPackage` 在下次开会话时清掉，不留两份。
- **`vonvon-schedule`**：群的文字不变。私聊的写明任务建在这个私聊，给群建任务用 `vonvon schedule add --bot B --group X`，定时回合和人在场时一样。
- **`vonvon-config`**：只教能力，不写 Agent 该怎么判断。内容：
  - `vonvon` 的完整路径；
  - 先用 `--help` 和 `vonvon bot list`、`vonvon group list`、`vonvon settings` 看现状，不要背设置项；
  - `--bot`、`--group`、`--dm` 怎么指定目标；不写就是这个 Bot（私聊看得到所有 Bot，会话多带一个 `VONVON_BOT`，`pickBot` 没给 `--bot` 时用它）；
  - 群设置改完下一轮生效，Skill 和 MCP 要等新会话（3.6）；
  - Bot 自己进不了已有的群，要用户拉；
  - 哪些事这里做不了，告诉用户去哪里做（第 6.2 节）；
  - 调"老抢话"这类问题要看什么：用读取工具看群里的记录，用命令行看群的沟通方式和智能提示词。
- **`vonvon` 要保证找得到**：桌面版启动时已经注册命令（`packages/desktop/src/cli-registration.ts`：Mac 写进 shell 启动文件，Windows 写用户 PATH），Linux 服务端也有 PATH 块。但这靠会话的 shell 读到那些文件：注册可能失败，开发版不注册，非登录的 shell 不读，daemon 在注册之前起来时也拿不到新的 PATH。修法不依赖它们：
  - Bot 进程启动时写启动器 `<data>/bin/vonvon`（Windows 写 `vonvon.cmd`，旁边再放一个 `vonvon`：Claude 在 Windows 上的 Bash 是 Git Bash，不认 `.cmd`），内容是 `process.execPath` 加 `selfEntry()`，daemon 带 `ELECTRON_RUN_AS_NODE` 时也写进去。每次启动重写，升级后跟着变。写失败只记日志，这个 Bot 的会话不设这两个变量，和以前一样。
  - **所有会话**（不只私聊）都找得到：Bot 启动时把这个目录加到自己进程的 `PATH` 最前面，会话继承；`profile.env` 设 `VONVON_CLI=<完整路径>`。不用 `profile.env` 设 `PATH`：Codex 的 `shell_environment_policy.set` 是整个替换，会丢掉 Provider 给子进程补的工具目录（Codex 自己的目录、nvm）。
  - `vonvon-config` 写 `"$VONVON_CLI"`，变量是空的才写 `vonvon`：登录 shell 会重排 `PATH`，排前面的可能是另一份安装（Mac 验收 356）。
  - 验收时 Mac、Windows、Linux 各用两家跑一次 `vonvon --version`。

## 10. 界面（D4）

- 快照：`agentSchema` 加 `dm?: membershipSchema`，不进 `memberships`，所有群列表、群目录、搜索都不用改。
- `BotGroupList.tsx`：列表最上面固定一行，图标 + "私聊"，右边显示 Provider，没有沟通方式那一列。计数不含它。就算 Bot 还没绑群，也显示这一行。"尚未绑定飞书群"放在它下面。
- 点开走 `collaboration-navigation.ts` 新路由 `{ kind: 'dm', agentId, tab }`。复用 `GroupWorkspace`，传一个合成的 `Group`（`{ id: 'oc_dm_…', name: '私聊' }`），`dmMode` 下：

| 标签 | 内容 |
|---|---|
| 模型与权限 | Provider、模型、强度，和群相同；权限只显示"完全访问"，不能改；目录只显示 |
| 能力 | Skill 和 MCP，和群相同 |
| 沟通方式 | 群的滑块，连续交谈或智能；智能时有决策模型和判断规则；运行中来了消息、消息与提醒和群相同 |
| 记忆 | 按人分组的私聊记忆；有 Bot 记忆的入口，没有项目记忆 |
| 任务 | 这个 Bot 的私聊任务，新建时选给哪位管理员的私聊。也汇总在 Bot 的任务页 |

  没有飞书群链接和解绑。
- 命令行：`vonvon settings … --dm`、`vonvon schedule … --dm`，解析成 `oc_dm_<appId>`。

## 11. 切片

| 片 | 做什么 | 依赖 | 估计行数 |
|---|---|---|---|
| A1 | 管理员规则：判断、升级、移除、`refresh-bot`、拿掉"主人" | 无 | 500 |
| F1 | 读取工具：实测、`D/feishu-read/`、两家接线、群和私聊的范围、新的权限分组 | 无 | 900 |
| D1 | 私聊项目：`dm` 行、读写、`ensureDmProject` | 无 | 400 |
| D2 | 私聊回合：门、提问卡、`/menu`、位置、`profileOf` | A1、D1 | 700 |
| A2 | 管理员页和候选人、被拒的话、`/menu` 只读 | A1 | 700 |
| D3 | 私聊记忆 | D2 | 300 |
| C1 | 权限表：一种范围、不能做的、这一轮、id 规则、建群拉人 | D2 | 500 |
| F2 | `vonvon feishu` 命令、跨 Bot 路由、缺权限的回复 | F1、C1 | 500 |
| F3 | 改文档工具、评论会话接上读和改、默认指令 | F1 | 400 |
| F4 | 多维表格读取工具 `feishu_base` | F1、F3 | 300 |
| F5 | 文件夹、知识库目录、文档评论、文档图片 | F4 | 400 |
| F6 | 幻灯片、思维笔记、画板、妙记、旧版文档 | F4 | 400 |
| F7 | 私聊的通用工具 `feishu_api` | D2、F4 | 200 |
| D5 | 第一次见面：客户端引导和 Bot 主动开口 | D2 | 200 |
| C2 | 定时任务 | C1 | 400 |
| D4 | 私聊页面和 `--dm` | D1、D3、C2 | 500 |
| C3 | 3 个 Skill、启动器和会话 PATH、`docs/` | F1、C1 | 300 |

A1、F1、D1 马上同时开，互不依赖。D2 和 A2 接着开。合计约 6,200 行。每片一个 PR 进集成分支，`claude/dm-agent-<片>` 分支、隔离 worktree，自测过就合进集成分支，全部做完再打 `frozen`。

## 12. 验收

- **JP-VPS（Claude 先做）**：用 Bot 6、7 在测试群里跑下面第 1 到 6 条，Codex 和 Claude 两家各一遍。
- **Mac，然后 Windows**：不同时跑。Mac 看私聊页、管理员页和 macOS 上的启动器；Windows 只走主流程。

1. 刚扫码注册的 Bot，创建者私聊"列一下这台电脑的 Bot 和群"，能答出来，没有权限报错。
2. 非管理员私聊，收到提示，语音不转写；客户端候选人里出现这个人；加上以后再私聊能用。
3. 私聊"测试群老抢话，帮我调调"：Agent 读了群记录，改了群的沟通方式或智能提示词，下一轮生效。
4. 私聊 Bot 6 改 Bot 7 的群、读只有 Bot 7 在的群，用的是 Bot 7 的身份。
5. 让它做每一条"不能做"的事，都被拒绝，并说明去哪里做。`/menu` 的重启能用。
6. 私聊建一个每天汇总群情况的任务：运行时能读群、能改设置，结果发在私聊。移除这个管理员：在跑的回合停下，任务暂停，令牌失效。
7. 群里问 Bot"看看这篇文档"：缺权限时收到一键链接；开通发版后能读。只读档的群也能读本群消息。群会话读别的群被拒绝。
8. 群里的 Agent 向管理员提问时，私聊里打普通的话进 Agent；回复问题卡才算回答。
9. 升级：老 Bot 启动后私聊项目自动建好，创建者在名单里；把创建者移除再重启，不会被加回来。
10. 云文档评论 @bot"帮我改这段"：文档分享给 Bot 可编辑时，文档改动的作者是 Bot，不是用户；只给阅读权限时，回复说要给编辑权限；没分享时，回复说要分享。被评论的原文还在。
11. 只读档的群读得到文档，改不了。
12. 把幻灯片、思维笔记、画板、妙记、旧版文档、文件夹、知识库分享给 Bot，群和私聊都能读；没分享时回复说要分享，缺权限时给链接。
13. 私聊说"把这条加进多维表格"：Bot 有权限时加上了，记录的创建人是 Bot；缺权限时给预选好的链接。同样的话在群里和文档评论里做不到。
14. 新注册一个 Bot：客户端同时有建群和去私聊两个引导；开通发布后 Bot 主动私聊创建者一次，重启不重发；回一句就进对话。

## 13. 已知限制

- 私聊的消息先留在 `holdDm`，等人停下 1.5 秒，连着的几句合成一条再走智能路径的 named 通道，判断一次，回一次。只让判断看最后一句时，"谢谢"会把前面的问题一起跳过（2026-11-06 实测）；靠历史记录带回前面的话时，长消息会被截断，撤回最后一句会丢掉前面的话（Codex 368）。图片、文件和引用只能跟着自己的消息进回合，所以这一组挂在带它们的那条上，第二份另起一组。2026-11-06 以前建的私聊行没有 `smart`，还是每条都回，内部用户在设置页或 `vonvon settings set --dm conversation.mode=smart` 换。

- 名单和"不能做"挡不住完全访问的 Agent 自己改文件、读凭据。管理员私聊等于拿到这台电脑，这是 owner 定的前提。
- 管理员名单按 Bot，权限却到整台电脑。在 A 是管理员的人，能经私聊改 B，但在 B 的群里不算管理员。页面上写明。
- Linux 上用 root 跑时 Claude 拒绝完全访问，私聊没有低一档可退，只有 `/menu` 能用。这是 Claude 的限制，vonvon 不处理（owner 2026-11-03）。
- 旧的 Codex 线程没有读取工具，要 `/new`。
- 群会话能读到 Bot 读得到的所有文档，不按群隔离。文档分享给 Bot 就是让它用。
- 群和云文档评论里，表格和多维表格只读不改，要改到私聊里说。
- 用户另装的 `lark-*` Skill 还在，会话里可能同时看到两种办法；文档以外的写操作仍走它，身份是用户自己的，等 owner 以后整理。
- 飞书应用管理员的名字读不到时不进候选人，这个人私聊一次就会进。
