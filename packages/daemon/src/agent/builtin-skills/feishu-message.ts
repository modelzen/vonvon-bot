import type { BuiltinSkill } from './package';

/**
 * product.md 3.6 (s1b, owner 2026-11-02): how vonvon turns a reply into a Feishu message, moved out of the opening
 * (`bridge-instructions.ts`) so a session reads it when it wants a card, a picture, a file or layout. The opening keeps
 * the one line on files (a model that did not open this skill must still not upload as the owner). What it says is what
 * `card/markdown-render.ts`, `card/report-render.ts` and `card/file-refs.ts` do.
 */
export const feishuMessageSkill: BuiltinSkill = {
  name: 'vonvon-feishu-message',
  title: '飞书消息格式',
  description: "你的回复会被 vonvon 变成飞书消息。要用卡片回复（卡片、做成卡片、changelog/周报/日报卡片）、在回复里放图片或截图、把本地文件发给用户（发给我、导出、下载、给我文件）、或者要用标题、表格、分隔线、颜色这类排版时，先读本 skill，里面写了飞书里能显示哪些写法。",
  body: `你这一轮的回复会被 vonvon 渲染成一张飞书消息卡片，卡片正文是飞书的 Markdown。普通问答照常写 Markdown 就行；下面是飞书里能显示什么、文件和图片怎么给。

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
- 不要输出 \`codex-followup\` 这类 Codex 客户端专用的指令，飞书里显示不出来；后续建议用普通文字写。`,
};
