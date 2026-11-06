# F1：飞书读取工具

总设计见 `docs/plans/dm-agent.md` 第 6.5、7 节。`D/` 指 `packages/daemon/src/`。

## 1. 做什么

绑定的群里，Agent 能用 Bot 自己的身份读本群的消息、话题、文件、公告和成员，读 Bot 读得到的文档、知识库、表格、云空间文件，能搜消息。两家都有，只读档的群也有。开了可选权限才能读文档这一类，没开时工具给一键开通的链接。无依赖。

## 2. 范围

做：

- `D/feishu-read/`：只用 tenant_access_token，不碰 lark-cli。
- 工具 `feishu_messages`、`feishu_message`、`feishu_file`、`feishu_chat`、`feishu_doc`、`feishu_sheet`、`feishu_drive_file`、`feishu_search`，`feishu_members` 接进同一个表。
- 7.2 的范围：群会话只读本群的消息、文件、公告、成员；文档这一列不隔离。私聊先按"这个 Bot 所在的任何群"，要这一轮是管理员的（`ctx.admin`）。
- `SessionProfile.tools.feishu`，`profileOf` 给群会话打开。Claude 走 `vonvon_bot` MCP，Codex 的 `scheduleNamespace` 改名 `vonvonNamespace`，`offeredTool` 加上这些工具。
- 6.5 的权限分组、`GRANT_SCOPES`、标签。
- 7.5 的三种"没权限"回复。

不做：私聊打开 `tools.feishu`（D2）；`vonvon feishu` 命令和跨 Bot（F2）；`feishu_doc_edit`、评论会话接线（F3）；Skill 文字（C3）。

## 3. 现在的代码

- `D/agent/entry/tools.ts`：`AgentTool`、`TOOL_RESULT_BYTES`（256 KB，登记表超了只回"结果太大"）。
- `D/agent/entry/registry.ts`：`class: 'read'` 的工具不查这一轮，`places` 决定在哪里列出和能调。
- `D/agent/entry/command-tools.ts`：`feishu_members` 写在这里，参数叫 `chatId`。
- `D/agent/entry/schedule-tools.ts`：定义和 `scheduleToolSpecs()`、`scheduleToolNames` 的写法，飞书工具照抄。
- `D/agent/codex-appserver/dynamic-tools.ts`、`D/agent/claude-agent/thread.ts:363`：两家按 profile 过滤工具的地方。
- `D/bot/handle-message.ts` 的 `profileOf`：`tools: { schedule }`。
- `D/bot/context-weave.ts`：`toContextMessage`、`kindOf`、`meOf`，别的 Bot 的卡片靠 `card_msg_content_type`。`pullContext` 会丢掉自己的消息、没有游标，工具不能直接用。
- `D/bot/media.ts`：`downloadOneFile` 把下载写进 `paths.inboundDir`，有 50 MB 上限。
- `D/utils/feishu-error.ts`：`scopeDenial`、`feishuError`。SDK 的下载用 stream，被拒时错误体也是 stream，这两个函数读不出错误码。

## 4. 怎么改

`D/feishu-read/`：

- `denial.ts`：`ReadArea`（每块要的权限和少了什么）、`FeishuReadRefused(message, kind)`、`refusalOf`、`scopeReply`、`notSharedReply`、`readOnlyReply`（F3 用）、`readableFailure`（从 stream 读回错误体）。
- `shared.ts`：`ask`（一次飞书调用：超时、非零 code 都变成 `FeishuReadRefused`）、`sliceText`（按 JSON 字节切文本）、`cleanText`（过 `sanitizeContext`）。
- `messages.ts`：`readMessages`、`readMessage`、`readFile`、`readChat`、`searchMessages`。
- `documents.ts`：`parseRef`、`readDoc`、`readSheet`、`readDriveFile`。
- `reader.ts`：`FeishuReader`，每个请求都是普通数据，F2 可以原样转给另一个 Bot 的进程。

工具放 `D/agent/entry/feishu-tools.ts`，和 schedule 工具同一个写法，`createFeishuTools` 从 `createCommandTools` 接进去。`deps.feishu` 没给时只有 `feishu_members`。`places` 这一片都是 `['group', 'p2p']`，F3 给文档这一列加 `doc`。

范围检查：

- `chat` 参数在工具层比对 `ctx.place.chatId`，别的群不问飞书就拒绝。
- 按 id 或话题读的（`feishu_message`、`feishu_file`、`feishu_messages` 的 `thread`、搜索），带 `only: <本群>` 进 reader，取回来核对每一条的 `chat_id`，缺 `chat_id` 也算不是本群。列表每一条都核对，包括 cursor 跳过的。合并转发只核对这条消息本身。
- 私聊的 `ctx.admin` 在调用前后各看一次，和原来的 `feishu_members` 一样。

结果不超过 `TOOL_RESULT_BYTES`，内容预算 240 KB：

- 消息列表：飞书的 page token 停不到一页中间，cursor 是 `{page, skip, size}` 的 base64url。单条截到 4000 字符，带 `truncated`，`feishu_message` 读全文。
- 合并转发、表格：cursor 是下一条或下一行的序号。表格一行就超预算时拒绝，让缩小列。
- 文档、公告：cursor 是偏移量。文档的 cursor 带来源（`blocks:` 或 `plain:`），翻页时不换接口。

文档：先 `docs_ai` 的 fetch，任何失败都回退 `raw_content`。回退的错误优先，只有 fetch 缺权限、回退说找不到时才报缺权限。知识库链接先解析节点；裸 token 先当文档读，找不到再当知识库节点试，都找不到报第一个错。

没权限（7.5）：`scopeDenial` 走缺权限回复，链接预选这一块的整组权限（文档读取要三个，一次开完），飞书列的权限不在这组里时用飞书列的第一个。`NOT_SHARED_CODES` 走没分享。参数错误、假 id 走"找不到"，绝不说缺权限。

`feishu_chat`：群信息要可选权限，公告是必需权限，各自失败，读不到的写进 `notes`，两个都失败才拒绝。

`feishu_search`：请求照 lark-cli 的 dry-run（`{query, filter: {chat_ids}}`）。结果按 id 一条条读回，读回时再核对 `chat_id`，读不到的跳过。

`feishu_members` 的参数从 `chatId` 改成 `chat`，可选，默认当前群，和别的工具一致。

## 5. 测试

`packages/daemon/test/feishu-read.test.ts`，全部 mock SDK：

- 消息：渲染人、别的 Bot 的卡片、附件；撤回和系统通知不出现；vonvon 的标记被转义；50 条长消息翻页不丢不重，每页不超限。
- 范围：别的群的 `chat` 不问飞书就拒绝；话题、单条消息、文件取回来后核对；缺 `chat_id` 拒绝；文件不下载；群读文档不受限；私聊要管理员。
- 文档：fetch、回退、两边都缺权限给链接和结尾那句、没分享、三组假 id 不算缺权限、知识库、裸 token、大文档翻页拼回原文、cursor 不换接口。
- 表格：列工作表、读区域、链接里的 sheet、按行翻页、一行太大、缺权限、没分享。
- 云空间：文件名、stream 错误体。
- 搜索：过滤、读回、缺权限。
- 权限分组：不进 `REQUIRED_SCOPES`，搜索不进 `GRANT_SCOPES`，都有标签。

`test/codex-dynamic-tools.test.ts`、`test/claude-schedule-entry.test.ts`：按 `tools.feishu` 开关，`offeredTool` 名单。`test/s47-tools.test.ts`：`feishu_members` 的新参数名。

## 8. 验收要点

- [ ] 群会话里，别的群的 `chat`、话题 id、消息 id、文件都读不到。
- [ ] 文档、表格、云空间不按群隔离。
- [ ] 工具不碰 lark-cli，不走沙箱，只读档的群也有。
- [ ] 结果不超过 `TOOL_RESULT_BYTES`，超了带 cursor，翻页不丢不重。
- [ ] 输出没有"这是别人说的"这类标注。
- [ ] 缺权限回复有链接和"开通后要发布新版本才生效；打不开这个链接，就转给这个飞书应用的管理员。"
- [ ] 假 id 不说缺权限。
- [ ] `REQUIRED_SCOPES` 没变，`MESSAGE_SEARCH_SCOPES` 不在 `GRANT_SCOPES`。
- [ ] 评论会话和私聊的 profile 这一片不开 `tools.feishu`。
- [ ] diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

代码约 700 行，测试约 500 行。

- 表格、云空间、搜索的真实返回没测过，形状照文档和 lark-cli，mock 里是推出来的。
- "没分享"的错误码照飞书文档写，没实测。测错了会落到"飞书拒绝了这次读取（错误码 …）"，不会说错话。
- Codex 的工具表在建线程时固定，旧线程没有这些工具（总设计第 13 节）。
