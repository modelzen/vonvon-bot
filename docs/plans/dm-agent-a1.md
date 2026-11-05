# A1：管理员规则

设计见 `docs/plans/dm-agent.md` 第 3.1、3.2、3.3 节，产品行为见 `docs/product.md` 第 6 节和 3.7。`D/` 指 `packages/daemon/src/`。

## 1. 做什么

只有一种角色，叫管理员，判断只看 `preferences.access.admins`。飞书应用的所有者、管理员、开发者和扫码的人不再自动算数；扫码的人升级时写进名单，之后和别人一样，能被移除。名单在聊天里改不了，`/menu` 的管理员页只读。崩溃通知发给这个 Bot 的每个管理员。

不依赖别的片。D2、A2 依赖这一片。

## 2. 范围

做：

- `isAdmin` 改写，新增 `primaryAdmin`，删除 `resolveOwner`、`isOwner`、`NOT_OWNER_MESSAGE`、`dmOwner`、`not-owner`；
- `roleOf` 只回 `admin`、`member`、`bot`；
- 一次性升级，写 `access.adminsVersion: 2`；
- `settings.act.adminMember` 的私聊格改 `deny`，至少留一个管理员，创建者没有特殊保护；
- `/menu` 的管理员页只读，旧卡片按钮只重画；
- `refresh-bot.ts` 只核对是不是同一个应用；
- 移除管理员时留入口 `adminRemoved(openId)`。

不做：

- 管理员页面、候选人、被拒的话术（A2）；
- 私聊进 Agent（D2）；
- 权限表其余的格（C1）；
- 移除时的第 3 到 5 步：停私聊回合、作废令牌（D2），暂停私聊任务（C2）；
- 协议里的视图字段 `ownerOpenId`、`administrators.feishu` 这一片不删，只改含义，A2 再动。

## 3. 现在的代码

- `D/config/schema.ts`：`resolveOwner` 优先取飞书快照的所有者；`isAdmin` 是飞书所有者、飞书管理员、扫码的人和名单的并集。
- `D/agent/entry/registry.ts`：`roleOf`、`NOT_OWNER_MESSAGE`、`settingsWrite` 和 `adminMember` 共用一支，后者多查一次 `isOwner`。
- `D/admin/settings.ts`：`adminMember` 分支拒绝移除飞书的人和扫码的人；视图的 `ownerOpenId`、`scannerOpenId` 和 revision 都带 `resolveOwner`。
- `D/bot/handle-message.ts`：`dmOwner`、`administratorIds`、`DM.addAdminForm`、`DM.addAdminSubmit`、`DM.rmAdmin` 的处理；`collaboration()` 和 bot-added 用 `resolveOwner`。
- `D/bot/ask-coordinator.ts` 的 `eligible` 带飞书名单和扫码的人。
- `D/host/crash-notify.ts`：`loadOwnerSender` 一个 `openId`，`sendOwnerText` 发一条。
- `D/bot/refresh-bot.ts:35` 要求扫码的人是管理员，`:27` 要求有 `ownerOpenId`。
- `D/server/authz.ts`：`settings.act.adminMember` 在 `WRITE` 这组里，`sessionActionOf` 给它单独的 `SessionAction`。
- `/resume`：私聊现在还跑不到这个命令，"只在主人私聊列"只写在 `docs/product.md` 3.5，代码里没有。

## 4. 怎么改

**判断。** 照设计 3.1。`isAdmin` 只读名单；`primaryAdmin` 给 `collaboration()`（建群拉人、转移群主、桌面端发起的回合）和 bot-added。`ask-coordinator` 的 `eligible` 是名单加这一轮的发起人。`app-roles.ts` 的刷新和视图的 `administrators.feishu` 留着，A2 的候选人用。

**角色。** `roleOf` 的返回类型去掉 `owner`，`ctx.turn` 写 `admin`。`MemoryTurn.role`、`ScheduleActor.role`、协议的枚举和 `memory-authority`、`schedule-commands` 对 `owner` 的判断不动：存盘里的 `actorRole: 'owner'`、`createdBy.role: 'owner'` 照旧读。

**升级。** 新文件 `D/config/admins-upgrade.ts`：

```ts
export function upgradedAccess(access: AppAccess | undefined, feishuOwner: string | undefined): AppAccess | undefined;
export async function upgradeAdmins(cfg: AppConfig, write: AppPreferencesWriter): Promise<void>;
```

`upgradedAccess` 是纯函数，已是版本 2 或者谁都没有时回 `undefined`。`upgradeAdmins` 在 `orchestrator.initialize()` 开头跑：这时 `roles.refresh()` 已经做完，读得到飞书快照；走 `writePreferences`，和别的改名单排在同一条队列里，真正写的时候对着最新的 `preferences` 再算一次。失败只记日志，下次启动再来。

**改名单。** `adminMember` 分支：

1. `check` 的 revision 去掉 `resolveOwner`，只有 `[botId, admins]`；
2. 在 `writePreferences` 里判断：只剩这一个人时抛 `SettingsInputError('至少要有一个管理员。')`，名单没写；
3. 写完以后，真的移除了人才调 `deps.adminRemoved?.(openId)`，出错只记日志。入口的注释写明 D2、C2 接什么。

**权限表。** `settings.act.adminMember` 单列一行 `{ dm: 'deny', group: 'not-dm', comment: 'not-dm' }`。挡在 host 这边，到不了 Bot 进程，所以 `SessionAction` 的 `adminMember` 和 `registry.ts` 那一支一起删掉。

**卡片。** `buildAdminsCard(cfg, names)` 去掉 `editable`，列名单，创建者带"创建者"，没有增删按钮。`buildAddAdminCard` 删除。`DM.admins`、`DM.addAdminForm`、`DM.addAdminSubmit`、`DM.rmAdmin` 用同一个处理：是管理员就把这张卡重画成只读卡，别的什么也不写。

**崩溃通知。** `Sender.openId` 换成 `openIds`，`loadAdminSender` 读名单去重，空的回 `no-admin`。`sendAdminText` 取一次令牌，每人发一条。飞书的 `uuid` 按消息去重，所以每人用自己的 `uuid`：`<uuid>-<openId 的 sha256 前 8 位>`，共 44 个字符，重试时不管名单顺序都一样，已经收到的人不会收到第二条。结果：

| 情况 | 回 |
|---|---|
| 全部成功，或者有人收到、其余被飞书明确拒绝 | `ok` |
| 有人值得重试 | 第一个可重试的失败，走原来的重试 |
| 全部被明确拒绝 | 第一个失败，host 消息换下一个 Bot |

**重新扫码。** `refresh-bot.ts` 去掉 `isAdmin` 和 `ownerOpenId` 的要求，只核对 `clientId` 和租户。

**命令行。** `adminList` 只列名单，创建者带"（创建者）"。

**文字。** "主人和管理员""主人或管理员"这类写两种角色的话改成"管理员"。别的"主人"这一片不动。

## 5. 测试

- `admins-upgrade.test.ts`（新）：
  - 输入带重复、有创建者，得到去重加创建者、`adminsVersion: 2`，别的字段保留；
  - 空名单取飞书所有者；名单不空不取；
  - 谁都没有不写，飞书快照有了以后再启动会写；
  - 移除创建者后再启动两次，不写、不加回来（这条是版本号存在的理由）。
- `schema.test.ts`：名单外的创建者不是管理员（main 必败）；`primaryAdmin` 四种情况。
- `app-roles.test.ts`：飞书的人不是管理员（main 必败），快照照旧刷新。
- `settings-owner.test.ts`：
  - 创建者和飞书的人能移除（main 必败）；
  - 最后一个人拒绝，文字是"至少要有一个管理员。"；
  - `adminRemoved` 写完以后调一次，调的时候名单已经改了；抛错不影响结果；移除不在名单上的人、加人都不调。
- `dm-admins-card.test.ts`：谁看都没有增删按钮；旧卡片三个按钮只重画、不写、不发新卡（main 必败）；名单外的人点了没反应。
- `authz.test.ts`：私聊格是 `deny`。`cli-bot-session.test.ts`：私聊会话 `settings act admin add` 被拒，到不了 `act`（main 必败）。
- `crash-notify.test.ts`：每个管理员一条，`uuid` 各不相同、不超过 50 个字符，换名单顺序不变；一人 500 时重试；一人收到、一人被拒算成功；全部被拒走下一个 Bot。
- `register-bot.test.ts`：名单外的人、不带 `operatorOpenId` 的扫码都能换凭据（main 必败）；没有 `ownerOpenId` 的老 Bot 也能换。
- `dm-new-project.test.ts`：名单外的飞书管理员进不了私聊建项目（main 必败）。

## 8. 验收要点

- `grep -rE 'resolveOwner|isOwner|NOT_OWNER_MESSAGE|dmOwner|not-owner' packages/*/src` 没有结果。
- `isAdmin` 只读 `access.admins`，`eligible` 和 `administratorIds` 不再读飞书快照和 `ownerOpenId`。
- `roleOf` 不会回 `owner`，存盘的 `owner` 照旧能读（`memory-authority`、`schedule-commands`）。
- `adminsVersion` 写了 2 以后，启动不再改名单。
- 最后一个管理员移除不了，检查在 `writePreferences` 里面，不在外面。
- 私聊会话 `settings.act.adminMember` 在 host 这边被拒。
- 旧卡片按钮不写配置。
- 崩溃通知重试时，已经收到的人不会收到第二条。
- `refresh-bot.ts` 不看扫码的人是谁，仍核对 `clientId` 和租户。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

源码改 16 个文件，净减约 90 行。测试改动面大（约 80 个文件），多是把 fixture 里的创建者写进名单、去掉 `isOwner`。

- 升级前跑不到 `initialize` 的 Bot（比如启动就崩）名单没升级，崩溃通知发给现有名单；名单空时跳过，记 `no-admin`。
- 升级以后，只靠飞书名单当管理员的人失去权限，owner 已接受（设计 3.2）。
- 这一片合入后、A2 合入前，网页的管理员区还按旧规则隐藏移除按钮；终端能移除。
- 移除管理员时第 3 到 5 步还没接上，D2、C2 之前这个人在跑的回合不会被停（私聊这时也还没有 Agent）。
