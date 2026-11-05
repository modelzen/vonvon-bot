# dm-agent F6：幻灯片、思维笔记、画板、妙记、旧版文档的读取工具

## 1. 做什么

Bot 能用自己的身份读幻灯片、思维笔记、画板、妙记和旧版文档。群、私聊、云文档评论都能用，只读档也能用。依赖 F4（基线 `claude/dm-agent-design-3`，还在审查）。设计见 `dm-agent.md` 第 6.5、7.1、7.2、7.5 节。

## 2. 范围

做：

- 工具 `feishu_slides`、`feishu_mindnote`、`feishu_board`、`feishu_minutes`，代码在新文件 `D/feishu-read/canvases.ts`。
- `feishu_doc` 读旧版文档：`/docs/<token>` 链接、知识库节点 `obj_type: doc`、裸 token。
- `parseRef`、`KINDS` 认 `/slides/`、`/mindnotes/`、`/board/`、`/whiteboard/`、`/minutes/`、`/docs/`；知识库节点是这些类型时也能走。别的工具收到这些类型时，回一句用哪个工具。
- 五个权限组，并入 `FEISHU_TOOL_SCOPES`。

不做：

- 写操作。`feishu_doc_edit` 碰到旧版文档直接说改不了。
- 文件夹、知识库目录、文档评论、文档图片（F5）。
- `vonvon feishu` 命令（F2 照工具列表补）。
- 这几种内容的真实错误码：只加了 lark-cli 资料里写明的 `3410003`，其余等主会话实测后补。
- 画板图片和思维笔记图片的下载：结果里只有 token。

## 3. 现在的代码

- `D/feishu-read/documents.ts`：`KINDS` 把 `docs`、`slides`、`mindnotes` 当 `other`；`reading` 的 `want` 只能是一种类型；`wrongKind` 列工具。
- `D/feishu-read/denial.ts`：`AREAS` 按读什么列权限；找不到时的话按 area 选。
- `D/agent/entry/feishu-tools.ts`：`definitions` 决定两家的工具表，`feishuDocToolNames` 决定 `class: 'document'`。

## 4. 怎么改

### 接口（来自 lark-cli 资料和 SDK 1.71.1 的类型）

| 工具 | 接口 | 结果 |
|---|---|---|
| `feishu_slides` | `GET slides_ai/v1/xml_presentations/:id` | `data.xml_presentation.content`，XML 原样 |
| `feishu_mindnote` | `GET mindnote/v1/mindnotes/:id/nodes` | `data.nodes`，一次全给，没有翻页参数 |
| `feishu_board` | `GET board/v1/whiteboards/:id/nodes` | `data.nodes`，一次全给 |
| `feishu_minutes` | `GET minutes/v1/minutes/:token`；`minuteTranscript.get` | 信息；文字记录是文件流 |
| `feishu_doc` 旧版 | `GET doc/v2/:token/raw_content` | `data.content` |

四种内容的 `access_tokens` 都含 `bot`（`lark-cli schema`），`whiteboard +export` 和 `minutes +detail` 也支持 `--as bot`，没有只支持用户身份的。

### 结果

都是 `{ text, cursor? }`，游标是清洗后文本的偏移，每次重新问飞书一遍，用 `sliceText` 切。`feishu_minutes` 第一段多一个 `minute`（飞书给的原样，经 `cleanCell`），后面的段不再查信息。

- 幻灯片：XML 原样，带 id，私聊的通用工具改幻灯片时要用。
- 思维笔记：按 `parent_id` 排成树，兄弟按飞书给的顺序，一行一个节点，下面跟备注和图片 token。
- 画板：一行一个有文字的节点，从上到下、从左到右，子节点缩进；分区、便签、图片、表格带标记；Mermaid、PlantUML 给源码；只有形状的不出现。连线放在最后，写两端的文字和连线上的字。
- 妙记：文字记录要说话人和时间。流最多留 16 MB，超了截断并写明。读流也在 `ask` 的同一次调用里，60 秒为限。

`inTreeOrder` 用栈，不用递归；缺父节点或成环的节点放到顶层，不丢。缩进最多 32 层，树很深时文本不会成平方增长。

### 旧版文档

`reading` 的 `want` 可以是几种，`read` 拿到实际类型。`readDoc` 要 `docx` 和 `doc`。裸 token 按 docx、知识库节点、旧版文档的顺序试，云文档评论给的 `file_token` 就是裸的；都找不到时保留第一个回复。游标 `legacy:<偏移>`。

### 接线和权限

`definitions` 加四条，`feishuDocToolNames` 加四个名字，所以三个位置都有、`feishuReadToolNames`、`offeredTool` 跟着走。`AREAS` 加 `slides`、`mindnote`、`board`、`minutes`、`legacyDoc`。

## 5. 测试

`feishu-read.test.ts`：

- `parseRef` 认新链接。
- 旧版文档：链接、知识库节点、裸 token 回退、都找不到时的回复、缺权限、不能改、游标。
- 幻灯片：URL、分段拼回全文且不超限、坏游标不问飞书、内部标记转义、缺权限、没分享、知识库节点、类型不对时指向对的工具。
- 思维笔记：树、备注、图片、完成；缺父节点和成环不丢；两万层不爆；分段；`3410003`；缺权限。
- 画板：顺序、分区、便签、图片、表格、源码、连线、画板上的思维导图；缺权限。
- 妙记：信息和文字记录、请求参数、分段且信息只给一次、流切开多字节字符、文字记录被拒时给整组权限、没分享。
- 各位置：只读档的群、私聊、评论能读，非管理员的私聊不能；四个工具在文档这一列，两家都有。
- 权限组：每个新权限都有说明和影响。

## 8. 验收要点

- 只发 GET，没有写接口。
- 只用 `rawClient`，不碰 lark-cli，不借用户权限。
- 结果不超过 `TOOL_RESULT_BYTES`，分段拼回来不丢不重。
- 缺权限走 `refusalOf`，给这一组权限的链接和 `AFTER_GRANT`；已知的没分享错误码回 `notSharedReply`。
- 群、私聊、评论、只读档都能读；非管理员的私聊不能。
- `REQUIRED_SCOPES`、`GRANT_SCOPES` 没动。
- `feishu_doc_edit` 碰到旧版文档拒绝。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 300 行产品代码加 220 行测试。

- 全部是 mock。思维笔记元素里除 `text.content` 以外的字段、画板节点、文字记录的格式都没有真实响应可对。
- 这几种内容的"没分享""找不到"错误码多半不在 `denial.ts` 里，补之前回"飞书拒绝了这次读取（错误码 …）"；裸 token 是知识库页面时，要等"找不到"的错误码补上才能回退。
- `notSharedReply` 的话写的是"这篇文档"，幻灯片和妙记上也这样说。

## PR 描述草稿

**用户能看到的变化**

Bot 能读幻灯片、思维笔记、画板、妙记和旧版文档了，身份是 Bot 自己。把链接发给它，或者让它读知识库里这些类型的页面就行。群、私聊、云文档评论都能读，只读档的群也能读。缺权限时给预选好的开通链接，这几个权限不进第一次的一键开权限。`feishu_doc` 收到幻灯片这类链接时，回一句该用哪个工具。

**试用步骤**

1. 给测试 Bot 开 `slides:presentation:read`、`mindnote:node:read`、`board:whiteboard:node:read`、`minutes:minutes:readonly`、`minutes:minutes.transcript:export`、`docs:doc:readonly`，发布新版本。
2. 把幻灯片、思维笔记、画板、妙记、旧版文档各一份分享给 Bot，在只读档的群里贴链接，问里面写了什么。
3. 再贴一份没分享给 Bot 的，看回复。
4. 让它读一条很长的妙记，看分段能不能读完。

**跑过的命令和结果**

- `npm ci`、`npm run build`（全部包）：通过。
- `vitest run test/feishu-read.test.ts test/codex-dynamic-tools.test.ts test/claude-schedule-entry.test.ts test/comments.test.ts test/scopes.test.ts`（`packages/daemon`）：5 个文件 191 条通过。`test/web-admin-service.test.ts`：38 条通过。
- `vitest run test/diagnostics-panel.test.tsx`（`packages/ui`）：24 条通过。
- `tsc --noEmit -p .`（`packages/daemon`）、`npm run lint -w packages/protocol`：通过。

**和计划不一样的地方**

- `feishu_doc` 的裸 token 多试一次旧版文档接口：云文档评论给的 `file_token` 是裸的，不这样读不了旧版文档上的评论。不存在的裸 token 会多问飞书一次。
- 妙记文字记录用 SDK 的 `minuteTranscript.get`，它返回文件流，`rawClient.request` 拿不到。
- 去掉了 `RefKind` 的 `other`：所有链接类型都有了去处。
- `denial.ts` 里找不到时的判断改成 `DOCUMENT_AREAS`。

**还没验过的项**

真实飞书实测待主会话做：所有接口只跑过 mock。重点是响应结构（思维笔记元素里 `text.content` 以外的字段、画板节点、文字记录文本）和没分享、找不到时的错误码。没有在真实 Mac 上验的项：这一片没有桌面改动。

**独立审查结论**

待 Codex 审查。

Mac 检查次数：0。等 owner 的时长：0。等额度的时长：0。
