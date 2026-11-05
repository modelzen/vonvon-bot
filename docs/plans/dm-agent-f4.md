# dm-agent F4：多维表格读取工具

## 1. 做什么

Bot 能用自己的身份读飞书多维表格：列出数据表、字段和视图，读记录，可以按视图和条件筛选、翻页。群、私聊、云文档评论都能用，只读档也能用。依赖 F1（#705）、F3（#709）。设计见 `dm-agent.md` 第 6.5、7.1、7.2、7.4、7.5 节。

## 2. 范围

做：

- `feishu_base` 工具，代码在新文件 `D/feishu-read/base.ts`。
- `parseRef` 认 `/base/<token>`、`/bitable/<token>` 和链接里的 `table`、`view`；知识库节点 `obj_type` 是 `bitable` 时也能走。
- `BITABLE_READ_SCOPES = ['bitable:app:readonly']`，并入 `FEISHU_TOOL_SCOPES`。
- 改掉设计、产品文档和 `DEFAULT_COMMENT_INSTRUCTIONS` 里"多维表格读不到"的话。

不做：

- 写多维表格（下一批）。
- 记录里的附件下载：结果里只有飞书给的 `file_token`、`tmp_url`。
- 幻灯片、妙记等其他内容。
- `vonvon feishu` 命令（F2 照工具列表补）。
- 多维表格的错误码：先按 `denial.ts` 现有的，真实错误码等主会话实测后补。

## 3. 现在的代码

- `D/feishu-read/documents.ts`：`KINDS` 把 `base`、`bitable` 当 `other`；`reading` 处理链接、裸 token 和知识库节点，`want` 直接和节点的 `obj_type` 比；`cleanCell` 只洗值，不洗键。
- `D/feishu-read/denial.ts`：`AREAS` 按读什么列权限和影响。
- `D/agent/entry/feishu-tools.ts`：`definitions` 决定两家的工具表；`feishuDocToolNames` 决定 `class: 'document'`，也就是三个位置都有。

## 4. 怎么改

### 工具

输入 `{ base, what?, table?, view?, fields?, filter?, limit?, cursor? }`。`table`、`view` 不写时用链接里的。`what` 不写时，有 table 读记录，没有就列数据表。

| what | 接口 |
|---|---|
| `tables` | `GET bitable/v1/apps/:app/tables` |
| `fields` | `GET .../tables/:table/fields`，有 view 带 `view_id` |
| `views` | `GET .../tables/:table/views` |
| `records` | `POST .../tables/:table/records/search`，body 里放 `view_id`、`field_names`、`filter` |

只用 `search` 读记录，不用历史的列记录接口：一个路径同时支持视图和筛选。飞书在有 `filter` 时忽略 `view_id`，工具描述写明。

`filter` 是 `{ conjunction?, conditions: [{ field, operator, value? }] }`，映射成飞书的 `field_name`，`value` 不写时发空数组。`operator` 只开放基础的 10 个，不开放 `like`、`in`。

返回 `{ items, total?, cursor? }`，`items` 是飞书给的原样，经 `cleanCell`。不同字段类型的单元格结构不一样，而且没有真实响应可对，所以不做映射；字段名是用户写的文字，`cleanCell` 把键也洗了。

### 翻页

一次调用问飞书一页，页大小固定 100。这一页放不下（超过 `RESULT_BUDGET` 或 `limit`）时，游标是 `<跳过几条>:<page_token>`，下一次重取这一页接着读；翻到飞书的下一页是 `0:<page_token>`。页大小不跟 `limit` 走，这样换 `limit` 后跳过的位置还是对的。单条就超过预算时拒绝，让 Agent 用 `fields` 少读几列。

### 接线和权限

`definitions` 加一条，`feishuDocToolNames` 加名字，`createFeishuTools` 加一行。两家的工具表、`offeredTool`、`feishuReadToolNames` 都从这里来，不用另改。`class: 'document'` 所以评论走 `authorizeFeishu`，读取不走沙箱，只读档也能读。

`AREAS` 加 `base`，`scopes.ts`、`SCOPE_LABELS`、`FEISHU_TOOL_SCOPE_EFFECTS` 各加一项。

### 指令

`DEFAULT_COMMENT_INSTRUCTIONS` 写上 `feishu_base`，F3 的默认加进 `OLD_DEFAULTS`，没改过的文件跟着换新。

## 5. 测试

`feishu-read.test.ts`：

- `parseRef`：`/base/` 带 `table`、`view`；`/bitable/`；知识库链接带 `table`。
- 四种 `what` 的 URL、方法和参数；链接里的 table、view，参数优先；链接有 table 时仍能列数据表。
- filter 和 fields 的 body；`isEmpty` 发空数组。
- 不问飞书就拒绝：缺 table、非 records 带 fields、坏 cursor、表格链接、非法 operator。
- 翻页：飞书下一页；一页放不下时不丢不重，跨两页；`limit`；单条太大。
- 字段名和单元格里的内部标记都转义。
- 知识库节点是 bitable 能读；是别的类型指向对的工具。
- 缺权限给 `bitable:app:readonly` 的链接和 `AFTER_GRANT`；`91403` 回没分享。
- 只读档的群、私聊、评论能读；非管理员的私聊不能。
- 评论会话的工具列表跟 `feishuDocToolNames`（已有用例）。

`comments.test.ts`：F3 的默认换新，默认里有 `feishu_base`，没有"读不到"。

## 8. 验收要点

- 只发 GET 和 `records/search`，没有写接口。
- 只用 `rawClient`，不碰 lark-cli，不借用户权限。
- 结果不超过 `TOOL_RESULT_BYTES`，一页放不下时游标不丢不重。
- 缺权限走 `refusalOf`，给 `bitable:app:readonly`；没分享回 `notSharedReply`。
- 群、私聊、评论、只读档都能读；非管理员的私聊不能。
- 评论会话能列出 `feishu_base`，列不出 `feishu_messages` 等。
- `feishu_doc_edit` 碰到多维表格仍然拒绝，默认指令写明能读不能改。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 130 行产品代码加 170 行测试。

- 风险：全部是 mock，接口的参数名和响应结构按飞书文档写，真实验证在开 PR 后由主会话做。
- 风险：多维表格的"没分享""找不到"错误码还不在 `denial.ts` 里，补之前会回"飞书拒绝了这次读取（错误码 …）"；裸 token 是知识库页面时，要等"找不到"的错误码补上才能回退到节点查询。带 `/wiki/` 的链接不受影响。
