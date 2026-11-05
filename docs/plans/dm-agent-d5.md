# D5：第一次见面

产品行为见 `docs/plans/dm-agent.md`“第一次见面（D5）”、第 12 节第 14 条和 `docs/product.md` 第 4 节。`D/` 指 `packages/daemon/src/`，`U/` 指 `packages/ui/src/`。

## 1. 做什么

新注册的 Bot，权限开通并发布后主动给创建者发一条私聊，只发一次。客户端在建群的引导旁边多一个“去飞书私聊”。依赖 D2（#710）。

## 2. 范围

做：

- 客户端的“去飞书私聊”，Lark 租户走 Lark 的域名。
- 待发标记、固定文字、发送和重试。

不做：

- 主动发的内容走 Agent。
- 多个管理员都发。
- 老 Bot 补发。
- `vonvon bot add` 命令行里的私聊引导（设计只说客户端）。

## 3. 现在的代码

- **注册完怎么走：** `U/setup/RegistrationDialog.tsx` 第 2 步开权限，点“检查连接”进 `U/setup/FeishuConnections.tsx`，建群的引导是页头的“连接群聊”。点“稍后配置”且还没绑群时，回到 `U/setup/WelcomeSetup.tsx`，建群的引导是“选择群聊”，下面是 `SetupChecklist` 的每个 Bot 一组。
- **外部链接：** `U/url-actions.ts` 已有 `bot-chat` 种类和 `botChatUrl`，没人用，只认飞书域名。桌面端 `packages/desktop/src/bridge.ts` 复用同一个 `allowedExternalUrl`。
- **租户：** `Agent` 不带租户，`AdminSetupStatus.tenant` 带。
- **新 Bot 的入口：** `D/bot/register-bot.ts` 的 `registerBotFromCredentials`，扫码和命令行向导都走它。Bridge 导入直接调 `registerBotEntry`，刷新凭据走 `D/bot/refresh-bot.ts`，都不经过它。
- **定时的地方：** `D/bot/bridge.ts` 的 `scheduleRoles`，每 10 分钟，失败时 5 分钟，刷新 `app-roles.json`。
- **写配置：** `createAppPreferencesWriter` 一个进程要共用一个，队列在实例里。

## 4. 怎么改

**标记。** `AppAccess.firstHelloPending?: boolean`，`withOwnerAdmin` 写，发完删。

**发送。** 新文件 `D/bot/first-hello.ts`，`createFirstHello(deps)` 回 `{ attempt, stop }`：

1. 没有标记，或创建者已不在管理员名单：直接返回，不碰网络。
2. 同时只跑一个；两次之间至少隔 `FIRST_HELLO_RETRY_MS`（一分钟）。
3. `validateAppCredentials`：必需权限不全、读不到权限、读不到名字，都等下次。
4. `im.v1.message.create`，`receive_id_type=open_id`，文字，`uuid` 固定为 `first-hello-<appId>`。`code !== 0` 算没发出去。
5. 发出去后记 `sent`，再删标记。删失败时下次只重试删，不重发。

`attempt` 不抛错，失败只记 info 日志。

**什么时候试：**

- Bot 进程连上以后一次（`startBridge`）。
- 跟着 `scheduleRoles` 的每一拍。这是用户没开客户端时的兜底，最多晚 10 分钟。
- 客户端看着的时候：host 的 `getSetupStatus` 读到必需权限齐全且配置里还有标记，转告 Bot 进程（`AdminServiceDeps.firstHello`，IPC `{ kind: 'firstHello' }`）。不等结果，错误吞掉。一键开权限的页面每 5 秒读一次，所以发布后几秒就到。这条不新增轮询，只用已有的读。

**停机。** `shutdown` 调 `stop`，之后不再开始新的尝试。在路上的那次不等，靠 `uuid` 挡住重启后的重发。

**客户端。** `botChatUrl(botId, tenant)`，`bot-chat` 放行 `applink.larksuite.com`。新组件 `U/setup/PrivateChatButton.tsx`，放在 `FeishuConnections` 页头和 `SetupChecklist` 每个 Bot 一组的右上角。状态没读到时不知道租户，按钮置灰。

## 5. 测试

`packages/daemon/test/first-hello.test.ts`：

- 新 Bot 发一次，文字和接收人对，标记删掉，再试不发。
- 重启不重发。
- 老 Bot、刷新过凭据的 Bot 没标记，不查飞书不发。
- `code=230013`、请求被拒：标记留着，不报错，下次再发，下个进程也接着发。
- 必需权限缺、读不到权限、读不到名字：不发。
- 一分钟内不重复问飞书，并发只跑一个。
- 删标记失败：不重发，下次补删。
- 创建者被移出名单：不发。
- `stop` 之后不试。

其余：

- `register-bot.test.ts`：注册写标记；刷新凭据不写回。
- `web-admin-service.test.ts`：权限齐全且有标记才转告 Bot，没标记不转告，转告失败不影响状态。
- `url-actions.test.ts`：Lark 的链接和放行，别的域名不放行。
- `feishu-connections.test.tsx`：按钮和“连接群聊”同时在，链接跟着选中 Bot 的租户走。

## 8. 验收要点

- [ ] `withOwnerAdmin` 是唯一写标记的地方；Bridge 导入和 `refresh-bot.ts` 不写。
- [ ] 发成功才删标记；`code !== 0` 不算成功。
- [ ] 删标记失败不会重发。
- [ ] 写配置用的是 Bot 进程共用的 `writePreferences`，没有新建第二个。
- [ ] 没有新增定时器；没有标记时 `attempt` 不碰网络。
- [ ] 主动发的文字和设计一字不差，不跑 Agent。
- [ ] 建群的引导还在，“去飞书私聊”走 `openExternalUrl(…, 'bot-chat', …)`。
- [ ] diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 400 行，其中产品代码约 130 行，比总表的 200 行估计多在测试。没开客户端时最多晚 10 分钟，这期间用户先开口的话，招呼会排在对话后面，内容仍然说得通，不处理。

## PR 描述草稿

### 用户能看到的变化

- 飞书连接页和首次设置的 Bot 检查里，多一个“去飞书私聊”，和建群的引导并排。
- 新注册的 Bot，权限开通并发布后主动给创建者发一条招呼，只发一次。回一句就是普通的私聊回合。

### 试用步骤

1. 扫码注册一个新 Bot，开权限前看一眼飞书：没有消息。
2. 开通权限、发布，留在客户端的页面上，几秒内收到招呼。
3. 重启这个 Bot：不再发。
4. 在飞书连接页点“去飞书私聊”：打开和这个 Bot 的私聊。
5. 回一句：进普通的私聊回合。

### 跑过的命令和结果

- `flock /tmp/vonvon-heavy.lock npm ci`、`npm run build`：通过。
- daemon：`npx vitest run test/web-admin-service.test.ts test/first-hello.test.ts test/register-bot.test.ts test/qr-register.test.ts test/bridge-card-callback.test.ts test/bridge-startup-drain.test.ts test/admin-ipc.test.ts test/admins-upgrade.test.ts test/supervisor-bridge-locks.test.ts`：9 个文件 123 条全过。
- ui：`npx vitest run test/url-actions.test.ts test/feishu-connections.test.tsx test/setup-presentation.test.tsx test/registration-dialog.test.tsx test/grant-step.test.tsx`：5 个文件 90 条全过。
- daemon、ui、desktop 的 `tsc --noEmit`：通过。

### 和计划不一样的地方

- 计划和实现同一个 PR，没有先走文档 PR。
- 总设计说“发过的记在 `access`”，这里按任务改成“待发标记，发完删”，效果一样，老 Bot 不用升级。
- 发之前先查必需权限：飞书允许 Bot 在权限没齐时就发出去，那时用户回了也听不到。
- 除了定时那一拍，host 读到权限齐全时也转告 Bot 进程，发布后几秒就到。
- 飞书消息带 `uuid`，进程死在发完、写盘之前时，重启不重发（飞书保留一小时）。
- 创建者被移出管理员名单时不发，标记留着。

### 还没验过的项

- 真飞书：没有发过消息，招呼的真实到达、未发布时的错误码都没验。`230013` 只是测试里的假数据。
- `applink.larksuite.com/client/bot/open` 没在真 Lark 客户端上打开过。
- 界面只跑了组件测试，没在真页面看过按钮的排布。窄窗口下页头三个按钮的样子要看一眼。
- 第 12 节第 14 条的验收。

### 独立审查结论

待 Codex 审查。
