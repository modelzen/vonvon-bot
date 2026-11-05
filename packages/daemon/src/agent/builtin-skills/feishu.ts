import type { BuiltinSkill } from './package';

/**
 * product.md 3.5, 3.6 (s1b, owner 2026-11-02; dm-agent 9): `vonvon-feishu`, merged from `vonvon-feishu-message`. The first
 * half is how vonvon turns a reply into a Feishu message, moved out of the opening (`bridge-instructions.ts`) so a session
 * reads it when it wants a card, a picture, a file or layout. The opening keeps the one line on files (a model that did
 * not open this skill must still not upload as the owner). What it says is what `card/markdown-render.ts`,
 * `card/report-render.ts` and `card/file-refs.ts` do. The rest is how to use the Feishu tools (`agent/entry/feishu-tools.ts`).
 * A private chat reads further and can write through `feishu_api`, so its text differs where a group's would be wrong.
 */
const REPLY = `你这一轮的回复会被 vonvon 渲染成一张飞书消息卡片，卡片正文是飞书的 Markdown。普通问答照常写 Markdown 就行；下面是飞书里能显示什么、文件和图片怎么给。

## 能显示的写法
- **粗体**、*斜体*、~~删除线~~、\`行内代码\`、代码块、有序和无序列表、> 引用、[链接](https://…)。
- 标题用 \`#\`、\`##\`。
- 颜色：\`<font color='red'>文字</font>\`，常用 red、green、blue、grey、orange。
- 表格：写成普通的 Markdown 表格（表头一行、\`|---|\` 一行，再是各行），vonvon 会换成飞书的表格。一条回复最多 5 张，多出来的按原文字显示；格子里放不了图片，写在格子里的图片会挪到回复末尾。表格写在正常回复里，不要放进下面的 \`feishu-card\` 块。

## 把本地文件发给用户
- 写 [文件名](绝对路径)，路径里有空格就写 [文件名](<绝对路径>)。文件得真实存在。
- vonvon 会在这个位置放一个蓝色的入口，用户点了，vonvon 把原文件作为附件发出去。不需要你调用任何工具上传。
- 生成了文件、提到本地文件，或者用户说"把文件发给我""导出给我""给我下载"，都用这种写法。
- 不要为了交付文件去用飞书 CLI、IM 或云盘接口、导入在线文档，也不要去找机器人的凭证、排查发送权限、换身份反复试。
- 只有用户明确要"上传到云盘""建飞书在线文档""发到另一个会话"这类外部操作时，才用对应的工具或 skill。

## 图片和截图
- 用 ![说明](路径) 引用一张真实存在的图片：相对当前工作目录的路径、工作目录里的绝对路径，或者 http(s) 图片地址。vonvon 会上传，在飞书里显示出来。
- 截图要先真的存成文件，再引用它的路径。
- 没有真实图片就不写图片语法，不编占位（比如写了 ![管理台截图] 却没有这个文件）。找不到的图片会显示成"未能显示"加路径。

## 卡片
- 只有用户要卡片时才用（"用卡片回复""做成卡片""卡片形式""changelog 卡片""周报卡片"这类）。普通回答不用。
- 把要放进卡片的内容包进一个 \`\`\`feishu-card 代码块，块里写 Markdown，vonvon 把它单独发成一张卡片：
  - 第一行 \`# 标题\` 是卡片的标题栏；
  - 单独一行 \`---\` 是分隔线；
  - \`> 文字\` 是灰色的小字注脚；
  - 粗体、列表、链接照常写，图片同样用 ![说明](真实路径)。
- 不要手写飞书卡片的 JSON。卡片里不放表格（要表格就写在正常回复里）。

## 别的
- 不要输出 \`codex-followup\` 这类 Codex 客户端专用的指令，飞书里显示不出来；后续建议用普通文字写。`;

const READING = `## 读飞书里的内容
用户发来飞书链接，或者让你看群里、文档里的东西，用下面这些工具。身份都是 Bot 自己。工具不在你的工具列表里，是这条会话开得早，告诉用户发 \`/new\` 开新会话。

按链接选工具，给链接或 token 都行：

| 链接里有 | 工具 | 读什么 |
|---|---|---|
| \`/docx/\`、\`/docs/\`、\`/wiki/\` | \`feishu_doc\` | 文档和知识库页面，旧版文档也用它，返回文字 |
| \`/sheets/\` | \`feishu_sheet\` | 表格：不写 \`range\` 列出工作表，写了读那个区域 |
| \`/base/\` | \`feishu_base\` | 多维表格：数据表、字段、视图和记录，记录能按视图和条件筛选 |
| \`/slides/\` | \`feishu_slides\` | 幻灯片全文 |
| \`/mindnotes/\` | \`feishu_mindnote\` | 思维笔记，带层级的文字 |
| \`/board/\` | \`feishu_board\` | 画板上的文字和连线 |
| \`/minutes/\` | \`feishu_minutes\` | 妙记的信息和文字记录 |
| \`/file/\` | \`feishu_drive_file\` | 下载云空间文件，返回本机路径 |
| \`/folder/\` | \`feishu_folder\` | 文件夹里有什么；不写 \`folder\` 列 Bot 自己的根目录 |
| \`/wiki/space/\` | \`feishu_wiki\` | 知识库的目录；不写 \`wiki\` 列 Bot 能看到的知识库 |

还有两个跟着文档用：\`feishu_comments\` 读文档的评论和回复；\`feishu_doc_media\` 下载文档里的图片和附件，传 \`feishu_doc\` 结果里图片的 \`src\` 或附件的 \`token\`。
知识库页面可能是表格或别的类型，工具回复说该用哪个，就换哪个。结果太长时带游标，用 \`cursor\` 接着读。

消息：\`feishu_messages\` 读群或话题的消息，能按时间和游标翻页；\`feishu_message\` 读一条消息的全文，合并转发会展开；\`feishu_file\` 下载消息里的图片和文件；\`feishu_chat\` 读群名、描述和公告；\`feishu_members\` 查群成员；\`feishu_search\` 按关键词搜消息。`;

const REFUSALS = `## 读不到、改不了的时候
工具的回复就是写给用户看的，把它转告用户，话不要省：
- 缺权限：回复里有开通链接，还有开通后要发布新版本才生效、打不开链接就转给飞书应用的管理员，这几句都要带上。
- 没分享：回复写了在哪里搜 Bot、要给什么权限。Bot 只有阅读权限却要改时，回复会说要给编辑权限。`;

const EDITING = `\`feishu_doc_edit\` 改新版文档：追加、插入、替换，身份是 Bot 自己。先用 \`feishu_doc\` 读，块的 id 在结果里，改过文档后要重新读。Bot 要有这篇文档的编辑权限。`;

export const feishuSkill: BuiltinSkill = {
  name: 'vonvon-feishu',
  title: '飞书',
  description: "你的回复会被 vonvon 变成飞书消息。要用卡片回复、在回复里放图片或截图、把本地文件发给用户（发给我、导出、下载）、用标题、表格、分隔线、颜色排版时，或者要读飞书的群消息、文档、知识库、表格、多维表格、幻灯片、妙记、云空间文件，用户发来飞书链接时，先读本 skill。",
  body: `${REPLY}

${READING}

## 能读到哪里
消息、文件、公告和成员只有本群。文档、表格、多维表格和云空间不按群分，Bot 读得到的都能读。

## 改文档
${EDITING}只读档的群没有这个工具。
表格和多维表格在群里只能读；要改，请管理员到私聊里说。

${REFUSALS}`,
};

export const dmFeishuSkill: BuiltinSkill = {
  ...feishuSkill,
  description: "你的回复会被 vonvon 变成飞书消息。要用卡片回复、在回复里放图片或截图、把本地文件发给用户（发给我、导出、下载）、用标题、表格、分隔线、颜色排版时，或者要读飞书的群消息、文档、知识库、表格、多维表格、幻灯片、妙记、云空间文件，往飞书里写东西，用户发来飞书链接时，先读本 skill。",
  body: `${REPLY}

${READING}

## 能读到哪里
\`chat\` 可以写本机任何 Bot 所在的群，群的 id（\`oc_\` 开头）用 \`vonvon group list\` 查；不写就是这个私聊。这个 Bot 不在那个群时，工具换成在群里的 Bot 去读，也可以用参数 \`bot\` 指定。
文档、表格、多维表格和云空间不按群分，这个 Bot 读得到的都能读。读不到时回复里列出本机别的 Bot，用 \`bot\` 换一个。

## 改飞书里的内容
${EDITING}
别的写操作用 \`feishu_api\`：往多维表格加记录、改表格、建文档、查日历和审批这类专门工具做不到的事。先查飞书开放平台文档（https://open.feishu.cn/document/ 下的页面，链接加 \`.md\` 能读到文本），再照文档调。身份是 Bot 自己，它只发 JSON，上传文件的接口调不了。

${REFUSALS}`,
};
