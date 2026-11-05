# dm-agent F5：文件夹、知识库目录、文档评论、文档图片

## 1. 做什么

Bot 能用自己的身份看云空间文件夹和知识库的目录，读文档的评论和回复，下载文档里的图片和附件。群、私聊、云文档评论都能用，只读档也能用。依赖 F1（#705）、F3（#709）、F4（在审）。设计见 `dm-agent.md` 第 6.5、7.1、7.2、7.5 节。

## 2. 范围

做：

- 四个工具 `feishu_folder`、`feishu_wiki`、`feishu_comments`、`feishu_doc_media`，代码在新文件 `D/feishu-read/drive.ts`。
- `parseRef` 认 `/drive/folder/<token>`、`/wiki/space/<id>`、`/wiki/settings/<id>`。
- 四个权限组 `DRIVE_LIST_SCOPES`、`WIKI_READ_SCOPES`、`COMMENT_READ_SCOPES`、`DOC_MEDIA_SCOPES`，并入 `FEISHU_TOOL_SCOPES`。

不做：

- 写操作。
- 幻灯片、思维笔记、画板、妙记、旧版文档（F6）。
- `vonvon feishu` 命令（F2 照工具列表补）。
- 多维表格记录里附件的下载：要带 `extra`，不在这一片。
- 真实飞书实测（主会话做）。

## 3. 现在的代码

- `D/feishu-read/base.ts`：`pageOf` 按 `<跳过几条>:<page_token>` 翻页，这一片复用，只读记录的那句"太大"改成参数。
- `D/feishu-read/documents.ts`：`parseRef` 把 `/wiki/space/1` 认成节点 token `space`；`wikiNode` 只回对象；`readDriveFile` 的存文件逻辑抽成 `saveDownload`，两个下载工具共用。
- `D/feishu-read/denial.ts`：`AREAS`、`refusalOf`。
- `D/agent/entry/feishu-tools.ts`：`definitions`、`feishuDocToolNames`、`createFeishuTools`。两家 Provider 的工具表都从这里来。

## 4. 怎么改

### 工具

| 工具 | 输入 | 接口 |
|---|---|---|
| `feishu_folder` | `{ folder?, limit?, cursor? }` | `GET drive/v1/files`，页大小 100。不写 folder 不带 `folder_token`，是 Bot 的根目录，飞书一次全给，放不下时游标只跳过 |
| `feishu_wiki` | `{ wiki?, limit?, cursor? }` | 不写列 `GET wiki/v2/spaces`。全数字或 `/wiki/space/` 是知识库，列第一层。其余先 `getNode` 找知识库，再带 `parent_node_token` 列子页面。页大小 50 |
| `feishu_comments` | `{ doc, type?, comment?, solved?, limit?, cursor? }` | `GET drive/v1/files/:token/comments`，给 `comment` 时 `.../comments/:id/replies`。`user_id_type: open_id`，页大小 100 |
| `feishu_doc_media` | `{ token, name? }` | `drive.v1.media.download` |

结果都是 `{ items, cursor? }`，每行取有用的字段改成短名，时间转成本机时区的文字，再过 `pageOf` 里的 `cleanCell`。

`feishu_comments` 的 `file_type`：链接看路径，知识库页面看节点的 `obj_type`，裸 token 看 `type`，没写当 `docx`，飞书说找不到时按知识库节点再查一次（和 `reading` 一样）。思维笔记没有评论，直接拒绝。

评论一行：`{ id, quote?, whole, solved, replies, moreReplies? }`。回复一行：`{ id, sender, senderId, time, text, images? }`。`text` 把 `text_run`、`docs_link`、`person` 拼成文字。人名用 `resolveNames`，缺 `contact:user.base:readonly` 或 5 秒没回时保持 open_id。

`feishu_doc_media` 的 token 来自 `feishu_doc` 结果的 `<img token>`、`<source token>`，工具说明写清。给链接时拒绝，并说 token 在哪。存的目录和大小上限走 `saveDownload`，和 `feishu_drive_file` 一样：群用这个群的目录，私聊和评论用全局收件目录。

### 权限和拒绝

- 查节点走 `wikiNode`，area 是 `doc`，权限是 `wiki:wiki:readonly`，不是 `wiki:node:retrieve`：飞书这个接口只认前者和 `wiki:node:read`。
- `refusalOf`：文件夹和知识库的"没分享""找不到"用自己的话。
- 飞书的错误码表先不加：F5 的接口没有实测，码补在主会话实测之后。

### 接线

`definitions` 加四条，`feishuDocToolNames` 加四个名字，`createFeishuTools` 加四行。`class: 'document'`，所以评论走 `authorizeFeishu`，不走沙箱，只读档也能读。

## 5. 测试

`feishu-read.test.ts`：

- `parseRef`：文件夹、`/wiki/space/`、`/wiki/settings/`。
- 文件夹：URL 和参数、翻页、根目录、一页放不下时跳过接着读、别的链接指向对的工具。
- 知识库：列知识库，按链接和 id 列第一层且不查节点，页面下的子页面，快捷方式跟到原处，缺权限的链接，没开放和找不到的文字。
- 评论：字段和文字、有名字和没名字、`solved`、回复接口、各种链接的 `file_type`、`type`、知识库页面、裸 token 回退、没有评论的类型、内部标记转义、缺权限、没分享。
- 图片：下载和保存、指定名字、群目录和评论目录、拒绝链接、大小上限、流里的错误。
- 群（只读档）、私聊、评论都能读；非管理员的私聊不能。
- 权限组：`docs:document.comment:read` 是第二个已在 `GRANT_SCOPES` 里的。

## 8. 验收要点

- 只发 GET，没有写接口。
- 只用 `rawClient`，不碰 lark-cli，不借用户权限。
- 结果不超过 `TOOL_RESULT_BYTES`，放不下时游标不丢不重。
- 缺权限走 `refusalOf`；没分享回对应的话。
- 下载的目录和大小上限和 `feishu_drive_file` 一样。
- 群、私聊、评论、只读档都能读；非管理员的私聊不能。
- `REQUIRED_SCOPES`、`GRANT_SCOPES` 没动。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 190 行产品代码加 250 行测试。

- 风险：全部是 mock，接口的参数和响应按 lark-cli 的 schema 和 skill 写，真实验证由主会话做。
- 风险：机器人身份下根目录、`wiki/v2/spaces` 能看到什么，要实测。
- 风险：`feishu_comments` 对裸 token 猜 `docx`，猜错时飞书回什么码不知道，可能不是"找不到"，那样不会回退到知识库节点。

## PR 描述草稿

**用户能看到的变化**

Bot 多了四个读取工具，身份是 Bot 自己，群、私聊、云文档评论都能用，只读档也能用：

- `feishu_folder`：看云空间文件夹里有什么；不给文件夹时列 Bot 的根目录。
- `feishu_wiki`：列知识库，列一个知识库或页面下面的目录。
- `feishu_comments`：读文档的评论和回复，人名能解析就显示人名。
- `feishu_doc_media`：下载文档里的图片和附件，返回本机路径。

**试用步骤**

开通 `space:document:retrieve`、`wiki:space:retrieve`、`wiki:node:retrieve`、`docs:document.comment:read`、`docs:document.media:download`，发布新版本，再私聊或在群里说：

1. "看看这个文件夹里有什么"，给 `/drive/folder/` 链接。
2. "这个知识库有哪些页面"，给 `/wiki/space/` 链接，再问某个页面下面有什么。
3. "这篇文档的评论都说了什么"。
4. "把这篇文档里第一张图下载下来看看"。

没开权限时，工具回缺什么和预选好的链接。

**跑过的命令和结果**

- `npm ci`、`npm run build`：通过。
- `npx tsc --noEmit`（`packages/daemon`）：通过。
- `npx vitest run`（`packages/daemon`）`test/feishu-read.test.ts test/codex-dynamic-tools.test.ts test/comments.test.ts test/scopes.test.ts test/discoverability.test.ts`：195 通过；`test/web-admin-service.test.ts` 同一轮通过。
- `npm run lint`（`packages/protocol`）：通过。`packages/daemon` 没有 lint 脚本。
- 全量测试没跑，交给集成 PR 的 CI。

**和计划不一样的地方**

- 这一片是实现者自己写的计划，设计表里只写了 `drive/v1/files/:token/comments`。纯技术的取舍：
  - `feishu_wiki` 只有一个 `wiki` 参数，全数字是知识库 id，其余是页面。
  - 从页面链接列目录要先查节点，这一步要 `wiki:wiki:readonly` 或 `wiki:node:read`，不是 `wiki:node:retrieve`，所以走已有的 `doc` 区域，缺权限时给文档读取那组。
  - `base.ts` 的 `pageOf` 改成导出，太大时的话改成参数；`readDriveFile` 的存文件逻辑抽成 `saveDownload`。
  - `feishu_comments` 多了 `solved` 过滤，默认都读。评论的人名用已有的 `resolveNames`，这是计划外加的，缺 `contact:user.base:readonly` 时保持 open_id。
  - `/wiki/settings/<id>` 也按知识库认，lark-cli 的说明里这是取 space_id 的办法之一。

**还没验过的项**

全部是 mock，真实飞书实测待主会话做：机器人身份下根目录和 `wiki/v2/spaces` 看到什么、各接口没分享和找不到的错误码、`docs_ai` 的结果里是不是 `<img token>` 和 `<source token>`、评论图片的 token 能不能用 `medias/download` 下载、知识库"没开放"那句话的做法对不对。

**独立审查结论**

待 Codex 审查。

**Mac 检查次数 / 等 owner 的时长 / 等额度的时长**

0 / 0 / 0。
