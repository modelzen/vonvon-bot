# dm-agent F3：改文档工具和云文档评论

## 1. 做什么

Bot 能用自己的身份改飞书新版文档。云文档评论不再靠 lark-cli：评论 @bot，它用 vonvon 的飞书工具读和改这篇文档，飞书记的修改人是 Bot。依赖 F1（#705）。设计见 `dm-agent.md` 第 2、6.5、7.1、7.2、7.4、7.5 节。

## 2. 范围

做：

- `feishu_doc_edit`：追加、插入、替换选中内容，只改 docx。
- 档位：`tools.feishuEdit` 按会话的档算，只读档不给；调用时再看一次当前的档。
- 评论会话：打开 `tools.feishu`、`tools.feishuEdit`，位置 `{ kind: 'doc', docId }`，`authorizeFeishu`，只放文档这一列的工具。
- `DEFAULT_COMMENT_INSTRUCTIONS` 和云文档评论卡片的提示，不再提 lark-cli。
- Claude 和 Codex 两家。

不做：

- 改表格和多维表格（下一批）。
- 跨 Bot 改文档、`vonvon feishu` 命令（F2 的读取路由；改文档不进命令行）。
- `vonvon-feishu` Skill 里写这个工具（C3）。
- `docs/product.md`：3.5 和第 563 行附近已经写了评论能读和改。

## 3. 现在的代码

- `D/agent/entry/feishu-tools.ts`：读取工具，`class: 'read'`、`places: ['group', 'p2p']`，评论会话一个都没有。
- `D/feishu-read/documents.ts`：`parseRef`、`reading` 处理链接、裸 token 和知识库节点。`shared.ts` 的 `ask` 把失败变成 `FeishuReadRefused`。
- `D/agent/entry/registry.ts`：`call` 的 `gated` 分支带授权、`ctx.commit`。`read` 类不看这一轮。
- `D/bot/handle-message.ts`：`profileOf`、`onComment`、`resolveDocThread`。评论的回合没有 `openTurn`，`grant.turn` 一直是空的。
- `D/bot/comments.ts`：`loadCommentInstructions` 第一次用时把默认指令写进 master 文件，以后原样读。
- `D/agent/session-profile.ts` 的 `resolveSessionProfile` 逐字段抄 `tools`。

## 4. 怎么改

### 工具

输入 `{ doc, action: 'append' | 'insert' | 'replace', content, block?, pattern? }`，content 是 Markdown，不许空（这个工具不删东西）。都是 `PUT /open-apis/docs_ai/v1/documents/:id`，`format: 'markdown'`、`revision_id: -1`：

| action | body |
|---|---|
| append | `command: 'block_insert_after', block_id: '-1'` |
| insert | `command: 'block_insert_after', block_id: block` |
| replace + pattern | `command: 'str_replace', pattern` |
| replace + block | `command: 'block_replace', block_id: block` |

命令名和 `-1` 来自 lark-cli 1.0.98 `docs +update --dry-run` 和它的参考文档。

结果只看 `data.result`：

- `success`：返回 `updatedBlocks`、`newBlocks`。
- `partial_success`：工具成功，带 `note` 和 `warnings`，要 Agent 读一下再说。
- `failed` 且 warnings 里有 `degrade_code=4030004`：`readOnlyReply`。
- 别的 `failed`：`飞书没有改成这篇文档：<飞书的话>`，不说成成功，也不说成没权限。
- 没有 result 或不认识的值：说飞书没说改成了，先读再决定。

`code` 非 0 走 `refusalOf`，新的 area `docEdit`：`3380004` 按没分享，缺权限给 `DOC_EDIT_SCOPES` 的链接。

没等到飞书回话（超时、网络错）时不知道改没改成，盲目重试会追加两次。`ask` 给这两种失败标 `kind: 'no-answer'`，`editDoc` 换成"先用 feishu_doc 读一下，再决定要不要重试"。

### 授权和位置

`AgentTool.class` 加 `document`：`feishu_doc`、`feishu_sheet`、`feishu_drive_file`、`feishu_doc_edit`，三个位置都列。`feishu_doc_edit` 带 `writes: true`。

- 改文档，以及评论会话里的所有 `document` 类，走 `authorizeFeishu`：入口活着、这一轮还在。群和私聊的读照 F1，不看这一轮。
- `feishu_doc_edit` 用 `ctx.commit`：提交点就在 PUT 之前。之后这一轮结束也不会回"没有动"，因为 PUT 已经发出去了。
- 档位在 `mayEdit`：评论没有档；私聊要管理员的回合；群调 `groupTier(chatId)` 现读，只读档和没绑定都拒绝。
- `onComment` 在跑之前 `entries.openTurn`，发起人是评论人，`finally` 里关。

### 两家

`SessionProfile.tools` 加 `feishuEdit`、`documentsOnly`。Claude 按 `entry.tools()` 列，位置自己挡，只加一条 `feishuEditTools` 的过滤。Codex 的 `vonvonNamespace` 按两个字段选，`offeredTool` 加上这个工具。老 Codex 线程没有这个工具，调不到，也不报错；默认指令写了工具不在时请用户新开一条评论。档位降了的老线程调到时由 `mayEdit` 拒绝。

### 指令

`DEFAULT_COMMENT_INSTRUCTIONS` 按 7.4 改。master 文件是第一次用时种的，没改过的人手上是旧默认的一份拷贝，不处理就一直是 lark-cli。所以按 sha256 认出和旧默认完全相同的文件，换成新默认；设置页读的时候也按新默认显示。改过的，差一个字也不动。

## 5. 测试

- `feishu-read.test.ts`：四种 body；参数缺、多不问飞书；空 content；`4030004`（字符串和对象）；`3380004`；别的 `failed` 带回飞书的话且不提权限；没有 result；`partial_success`；缺权限的链接；没回话；知识库和裸 token 重试；表格、多维表格不碰；只读档、调用时再看；私聊要管理员；评论能用、不看档；评论只有文档这一列、这一轮结束后拒绝；PUT 途中这一轮结束不报"没有动"。
- `comments.test.ts`：没提 lark-cli；旧默认换新，改过的不动。
- `schedule-profile.test.ts`：三档的 `tools`；docx 评论有改，sheet 评论没有。
- `comment-settings-runtime.test.ts`：评论开了回合，发起人是评论人。
- `codex-dynamic-tools.test.ts`、`claude-schedule-entry.test.ts`：两家按 profile 列工具，评论只有文档这一列。
- `comment-settings-card.test.ts`：卡片说分享给 Bot，不提 lark-cli。

## 8. 验收要点

- 这几种结果都不能说成成功：`failed`、没有 result、没回话。
- `4030004` 回编辑权限，`3380004` 回没分享，缺权限走 `refusalOf`，不混。
- 只读档的群看不到这个工具（Claude、新 Codex 线程），调到了也被拒，读不受影响。
- 评论会话列不出 `feishu_messages`、`feishu_chat`、`feishu_members`、`feishu_search`，调用也被拒。
- 工具只用 `rawClient`，不碰 lark-cli，不借用户权限。
- `DEFAULT_COMMENT_INSTRUCTIONS` 里"不要删被评论的原文"还在，不超过 1000 字。用户改过的指令不动。
- 群和私聊的读取行为和 F1 一样。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 400 行产品代码加 300 行测试。

- 风险：`feishu_doc` 现在发 `data: {}`，返回里有没有块 id 要真实飞书确认；没有的话 `insert` 和按块替换找不到块，要在读取时加 `export_block_id`。这一片全部是 mock，真实验证在开 PR 后由主会话做。
- 风险：`str_replace` 把文档里每一处匹配都换掉，工具描述写明了，`updatedBlocks` 带回去。
