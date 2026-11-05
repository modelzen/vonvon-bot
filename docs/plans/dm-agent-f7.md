# dm-agent F7：私聊的通用飞书工具 `feishu_api`

总设计 `docs/plans/dm-agent.md` 第 7.6 节，产品行为见 `docs/product.md` 3.5"查飞书上下文"。`D/` 指 `packages/daemon/src/`。

## 1. 做什么

管理员私聊 Bot 时，Agent 能用 Bot 自己的身份调飞书开放平台的任何接口：往多维表格加记录、建新文档、查日历和审批。缺权限时给预选好的开通链接。群和云文档评论没有这个工具。

依赖 D2、D3（#710、#712）、F3、F4，都在基线里。C1 还没合入，见第 4 节"这一轮的检查"。

## 2. 范围

做：

- 工具 `feishu_api({ method, path, params?, body?, bot? })`，两家 Provider 都接上。
- `SessionProfile.tools.feishuApi`，只有 `dm` 行打开。
- 路径和方法的检查、飞书错误的回复、结果截断、二进制落盘。
- 修掉 SDK 把 `Authorization: Bearer` 打进 daemon 输出的问题。

不做：

- `vonvon feishu` 命令和跨 Bot：F2。`bot` 参数留着，现在只接受当前 Bot。
- Skill：C3。这里只写工具说明。
- 上传文件的接口：`body` 只发 JSON，要 multipart 另开一片。
- 真实飞书实测：由 Claude 主会话做。

## 3. 现在的代码

- `D/agent/entry/feishu-tools.ts`：工具定义。`feishu_doc_edit` 不在 `definitions` 里，单独常量 `FEISHU_DOC_EDIT`，按 `tools.feishuEdit` 列出，这一片照它做。
- `D/agent/entry/registry.ts`：`call` 按 `tool.class` 选检查函数；`tools()` 里不是 `read`、`document`、`memory`、`schedule` 的类只在 `p2p` 列出；`ctx.commit` 的 guard 调过以后，超时和这一轮结束都不再打断调用。
- `D/agent/codex-appserver/dynamic-tools.ts`：`feishuToolSpecs(tools)` 决定 Codex 的工具表，`offeredTool` 是能回调的名单。
- `D/agent/claude-agent/thread.ts`：`entry.tools()` 按 cfg 过滤后注册给 MCP，`backend.ts` 的 start 和 resume 两处填 cfg。
- `D/bot/handle-message.ts` `profileOf`：算 `tools`。`project.dm` 是私聊项目行的标记。
- `D/feishu-read/denial.ts`：`refusalOf` 按 `ReadArea` 回话。每个 area 有固定的权限组，`feishu_api` 没有。
- SDK `Client.request`：`.catch(e => { this.logger.error(e); throw e; })`，打的是整个 AxiosError。类型化方法走 `formatErrors`，不带请求头，只有 `rawClient.request` 这条路漏。默认 logger 是 `console.log`。

## 4. 怎么改

**工具（`D/agent/entry/feishu-tools.ts`）。** 新常量 `FEISHU_API`，`apiInput`，`apiDescription`，`apiTool(reader)`。`class: 'feishu-api'`，`places: ['p2p']`。`run` 里再核对一次位置，走 `ctx.commit`：任何方法都可能改东西，guard 紧贴在请求之前。`feishuToolSpecs` 加 `feishuApi`。

**这一轮的检查（`D/agent/entry/registry.ts`）。** 新类 `feishu-api` 进 `gated`，`authorizeFeishuApi` 查入口活着、这一轮还在，再调 `dmCallTurn(auth)`：人或定时任务，且 `requesterOpenId` 是管理员。C1 合入时，`dmCallTurn` 换成设计 6.3 的 `dmTurn`，一行的事。私聊定时任务的 `requesterOpenId` 由 C2 填创建人（设计 6.3）。拒绝文字单独一份，原来的都在说"改设置"。

**调用（新文件 `D/feishu-read/api.ts`，`reader.api`）。**

1. `thisBot`：`bot` 不是当前 Bot 就拒绝。
2. `checkedPath`：以 `/open-apis/` 开头；不能有空白、非 ASCII、反斜杠、`?`、`#`；解码一次后按 `/` 和 `\` 切段，不能有 `.`、`..`，第二段不能是 `auth`（不分大小写，空段不算）。
3. `beforeSend()`，也就是 commit guard。
4. `rawClient.request`：`responseType: 'arraybuffer'`，`maxContentLength: MAX_FILE_BYTES`，`$return_headers: true`，`paramsSerializer` 写成 `a=1&a=2`（SDK 自己的调用也是这样）。
5. 总时限 60 秒，到了 `abort`。commit 之后 registry 的 70 秒不再打断，所以这里要自己限。
6. 成功：`content-disposition` 是 attachment，或类型不是文本，就存文件，回 `{ path, name, bytes, contentType }`；否则文本。没有类型时看字节里有没有 NUL。文本里 `code` 非 0 按失败算。
7. 文本过 `cleanText`（和别的读取工具同一道边界），`sliceText` 按 `RESULT_BUDGET` 切，切了就在最前面写一行说明。说明放前面，免得显示结果的那一层再切掉尾巴。

**错误（`D/feishu-read/denial.ts` 的 `apiRefusalOf`）。**

| 情况 | 回复 |
|---|---|
| `scopeDenial` 带权限名 | 第 7.5 节的句子，链接预选飞书列出的第一个（列出的有一个就行） |
| `scopeDenial` 没有权限名 | 说缺权限，加飞书原话，没有链接 |
| `NOT_SHARED_CODES` | `notSharedReply`，GET 要阅读，别的方法要编辑，加飞书原话 |
| 其他 | `飞书返回了错误：HTTP 状态和飞书原话`，最多 8 KB |
| 没有回应、超时 | GET 说稍后再试；别的方法说不知道生效没有，先查再决定 |

**接线。** `session-profile.ts` 加 `feishuApi`；`profileOf` 里 `schedule && Boolean(project?.dm)`；`dynamic-tools.ts` 的 `offeredTool` 加名字；`thread.ts`、`backend.ts` 加 `feishuApiTools`。Codex 旧线程的工具表不变，没有这个工具，要 `/new`（设计 7.3）。

**日志（`D/bot/bridge-channel.ts`）。** `sdkLogger` 传给 `createLarkChannel`，它转给 rawClient、事件分发和 WSClient。输出位置和默认 logger 一样；Error 只留名字和消息，别的值 `inspect` 成文字后遮掉 `Bearer xxx`。本机假服务器复现过：默认 logger 把 `request._header` 里的 `Authorization: Bearer t-...` 打到 stdout。

## 5. 测试

新文件 `packages/daemon/test/feishu-api.test.ts`：

- 位置：私聊能用，参数原样到飞书；群和评论不列出，调用回 `unknown-tool`；工具本身也拒绝非 `p2p`。
- 这一轮：管理员的定时任务能用；创建人不再是管理员、非管理员、bot 轮、唤醒轮被拒，文字不提设置；结束的轮和认不出的轮被拒。
- 路径：完整 URL、`//host`、别的根、`..` 及其编码、反斜杠及其编码、`/open-apis/auth/` 的各种写法、`?`、`#`、空格、中文、坏的 `%` 都不发请求。`/open-apis/authen/` 和带 `%21` 的表格路径能过。
- 方法：小写和 HEAD、OPTIONS 回 `bad-args`。`body` 是数组回 `bad-args`。
- 错误：缺权限两种形状都带链接和 `AFTER_GRANT`；没有权限名时给原话；没分享分阅读和编辑；其他错误是 `refused` 不是 `failed`；非 JSON 的 502；长错误被限长；GET 和 POST 没回应时的话不同；60 秒时限会 abort。
- 结果：原文不变（大整数不丢精度）；隐藏块标记被洗掉；空响应；长 JSON、转义后变长的文本、中文的截断都在 `TOOL_RESULT_BYTES` 以内；图片和 attachment 落到 `inboundDir`；文件名去掉目录；Office 类型不当文本；没有类型时看字节。
- 真实 SDK 加本机假服务器：令牌、JSON body、重复参数到得了；错误体读得出；二进制不坏；超过 50 MB 被拒；失败时 console 上没有令牌（对照组用原始错误能看到令牌，证明测试有效）；`createBridgeChannel` 用的是 `sdkLogger`。

改的现有测试：`codex-dynamic-tools`（工具表、`offeredTool`）、`claude-schedule-entry`（start 和 resume 都按 profile 列出，群里不列）、`dm-turn`（私聊的 profile 带 `feishuApi`）。群的 profile 由 `schedule-profile` 的 `toEqual` 保证没有它。

## 8. 验收要点

- [ ] 群和云文档评论的工具表里没有 `feishu_api`，两家 Provider 都一样。
- [ ] 调用时位置不是 `p2p`、这一轮不是管理员或管理员的私聊定时任务，都被拒。
- [ ] `/open-apis/auth/`、完整 URL、`..` 被拒，host 只能是这个 Bot 的租户。
- [ ] 缺权限的回复有第 7.5 节的全部内容。
- [ ] 飞书的其他错误原样给 Agent，不是 `failed`。
- [ ] 结果不超过 `TOOL_RESULT_BYTES`，截断时有说明。
- [ ] 二进制存到 `feishu_file` 同一个目录，有大小上限。
- [ ] SDK 的日志里没有 `Bearer` 令牌。
- [ ] 工具说明不写 Agent 该不该改、要不要先确认。
- [ ] diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 720 行，其中测试约 400 行，这一片的计划约 130 行。

- **内存：** 响应整个读进内存，最多 50 MB，一个会话同时最多 4 个调用。换来的是不用写流的限速和错误处理；下载大文件本来也有专门工具。
- **改到共享代码：** `registry.ts` 的改动和 C1 重叠，F5、F6 改 `feishu-tools.ts`，都只是加行。
- **`bridge-channel.ts` 的 logger** 影响所有 SDK 日志。输出位置不变，形式从多行变成一行文字。

## PR 描述草稿

**标题：** Private chat's generic Feishu tool (dm-agent F7)

**用户能看到的变化**

- 管理员私聊 Bot 时，Agent 能用 Bot 的身份调飞书开放平台的任何接口：加多维表格记录、建文档、查日历和审批。Bot 有权限就能做，缺权限时回预选好的开通链接。
- 群和云文档评论没有这个工具。
- daemon 的输出里不再有 SDK 打出来的 `Authorization: Bearer` 令牌。这个问题基线上就有，所有用 `rawClient.request` 的读取工具失败时都会打。

**试用步骤**

1. 管理员私聊 Bot，发 `/new` 开新会话（Codex 的旧线程没有这个工具）。
2. 说"查一下这个 Bot 能看到哪些日历"或"往这个多维表格加一条记录"。没开权限时，回复里有预选好的链接和"开通后要发布新版本"。
3. 开通、发布后再说一次，这次能做成。
4. 在群里说同样的话：Agent 没有这个工具。

**跑过的命令和结果**

见本节末尾"命令和结果"。

**和计划不一样的地方**

都是纯技术取舍：

- 响应用 `arraybuffer` 整个读进内存，不用流。
- `body` 只收 JSON 对象。SDK 的 `Client.request` 用 `Object.assign({}, data)` 处理 body，数组会变成对象，所以 schema 直接拒绝。
- `path` 里不许有 `?`、`#`，查询参数写进 `params`。
- `feishu_api` 新开一个工具类 `feishu-api`，没有借用 `document`，因为检查函数和出错文字都不一样。
- 飞书列出多个权限时，链接只预选第一个，和现有的 `scopesToGrant` 一样。
- 拒绝 `/open-apis/auth/` 不分大小写，也挡编码和空段的写法。`/open-apis/authen/` 不拦，设计只写了 `auth`。
- 修日志的办法是给 channel 传 `sdkLogger`，所有 SDK 日志都经过它。

**还没验过的项**

- 真实飞书实测，待 Claude 主会话做：真实接口的响应头（文本和二进制的判断）、错误码、缺权限的链接能不能打开。
- 私聊定时任务能调用，要等 C2 把创建人填进 `requesterOpenId`；这一片只用合成的 facts 测过。
- 真实 macOS 和 Windows 上没跑过。

**独立审查结论**

待 Codex 审查。
