import type { BuiltinSkill } from './package';

/**
 * Private-chat builtin skill `vonvon-template` (`docs/plans/templates-phase-0.md`).
 * Guides administrators through importing `.vonvon.zip` / repository templates (new group, existing group merge,
 * or version upgrade) and authoring/packing templates from any material without ever uploading private content.
 */
export const templateSkill: BuiltinSkill = {
  name: 'vonvon-template',
  title: '配方',
  description: "导入、升级或创作 Vonvon 配方（.vonvon.zip 或含 vonvon-bot.json 的仓库）。用户说到配方、模板、.vonvon.zip、照这个配方建群、导入已有群、更新配方、帮我创作一个配方、打包成配方、分享或发布配方时，先读本 skill。",
  body: `这是管理员私聊里的配方助手。你用 \`"$VONVON_CLI"\`（下面简称 \`vonvon\`）完成配方的安全校验、解包、落盘、脱敏打包与公开宣传名片上报，再配合已有的 \`vonvon group\`、\`vonvon settings\` 和 \`vonvon schedule\` 完成配置。

## 一、导入或升级配方（收配方）

### 1. 统一检查入口
- 收到用户发来的 \`.vonvon.zip\` 附件路径，或指向含 \`vonvon-bot.json\` 仓库的链接（先浅克隆到临时目录）时，**必须先运行**：
  \`vonvon template inspect <source> --json\`
- 绝不绕过 \`vonvon template stage\` 手动拷贝文件，否则会丢失双端 Skill 同步与来源记录。

### 2. 先给清晰确认摘要，绝不静默操作
向用户列出：配方名称、版本、作者、Skill 清单（标出 \`*-setup\` 初始化技能）、预置工作区文件、前置提示、本群角色、定时任务模板，以及权限建议：
- 若配方建议 \`full\`（完全访问），提醒用户仅限个人私密群；多人已有群绝不静默提权，可改用 \`write\` 或 \`qa\`。
- 若配方为公开宣传（\`public: true\`），顺手透明告知一句：安装成功后会匿名累计该配方的公开安装数（不含任何个人或群隐私，传 \`--no-telemetry\` 或设 \`VONVON_NO_TELEMETRY=1\` 可关闭）。
- 确认用户想要哪种方式：**新建专属群**、**导入到已有群**，还是**升级已有配方的群**，并确认群名、权限档以及是否创建定时任务。

### 3. 按确认结果执行
- **新建专属群**：
  1. 先建群拿主工作区目录：\`vonvon group create <群名> --conversation multi --json\`（可按用户习惯改会话方式）；
  2. 若用户未选 \`full\`，**先收紧群权限再落盘**：\`vonvon settings set --group <群> permission.mode=write\`（或 \`qa\`）；
  3. 落盘工作区与双端 Skill：\`vonvon template stage <source> --dest <工作区目录> --mode fresh --json\`（来自仓库时加 \`--source-url <仓库地址>\`）；
  4. 如有本群角色（\`group.role\`），写入群级补充职责，**绝不覆盖 Bot 全局 \`SOUL.md\`**：\`vonvon settings set --group <群> role.supplement="<内容>"\`；
  5. 如有用户确认的定时任务，用 \`vonvon schedule add --group <群> --name <任务名> --daily 09:00 "<提示词>"\`（按 \`when\` 选对应时间参数）；
  6. 引导用户打开新群，若有 \`firstMessage\` 或 \`setup\` 技能，给出首句提示让用户在群里完成初始化。
- **导入到已有群 / 升级配方**：
  1. 用 \`vonvon group show <群> --json\` 找到目标群主工作区，读取里面的 \`.vonvon-template.json\` 了解已装版本；
  2. 必要时先用 \`vonvon template extract <source> --dest <空临时目录> --json\` 对比差异，并用 \`vonvon template stage <source> --dest <工作区目录> --mode merge --json\` 写入无冲突文件；
  3. 仅在用户确认升级已有 Skill 时传 \`vonvon template stage <source> --dest <工作区目录> --mode merge --update-skills --json\`；
  4. 对冲突的 \`AGENTS.md\`、预置文档、\`role.supplement\` 和定时任务，先向用户展示差异再做增量合并，**不覆盖用户自己的业务文件与本地修改**。

## 二、从任意素材创作并打包配方（做配方）

### 1. 收集素材与优化引导
- 素材可以是现有群（仅用 \`vonvon group show\`、\`vonvon settings get\`、\`vonvon schedule list\` 读非敏感配置，**绝不读取任何记忆或密钥**）、帖子、飞书文档、GitHub 仓库、零散 Skill 或口头想法。
- 主动帮创作者打磨好配方，让别人一键好装：
  - 提炼直白的名称与一句话场景简介；
  - 若依赖外部 CLI、API Key 或 MCP 连接器，整理成一个 \`<名称>-setup\` 技能在群里引导安装，**不写 \`mcp.json\`**；
  - 不在清单里写会话方式、免 @ 等群交互习惯，只留本群角色、可选定时任务、权限建议与预置工作区文档；
  - 核对引用素材的开源协议并写入 \`license\` 和 \`credits\`；如素材禁止商用，明确提醒作者；
  - 建议作者先拉一个临时测试群试跑一遍，确认新用户拿到真的能一键跑通。

### 2. 飞书宣传文档引导（用于公开宣传）
- 引导创作者准备一篇**公开飞书云文档**作为对外宣传页（\`docUrl\`，若本机可用 \`lark-cli\` 可直接协助起草）：
  1. **务必提醒创作者点击飞书文档右上角「分享」→ 将链接权限设为「互联网上获得链接的人可阅读」**，否则他人从社区点开会无权限访问；
  2. 建议给飞书文档顺手配一张好看的封面图（未设置时社区页也会自动兜底展示干净的文档微缩预览卡）；
  3. 提醒在文档里带一行认领标记 \`Vonvon 配方：<id>\`，并写清获取方式（免费的一句话安装指令、文档内附 \`.vonvon.zip\`，或付费店铺链接/联系方式）。

### 3. 打包前必问：公开宣传 vs 仅内部私用
展示预览摘要后，用清晰无歧义的话让创作者二选一（未明确同意公开时严格保持 \`public: false\`）：
- **公开宣传（\`public: true\`）**：**绝不会上传你的 Skill、提示词或任何配方正文**，只会把你的这篇飞书宣传文档展示到「Vonvon 灵感 Club」（\`club.vonvon.cc\`）帮你宣传并统计真实安装量；想让别人下载或买到，记得在飞书文档里留好获取方式或联系方式。
- **仅内部私用（\`public: false\`，默认）**：打包成普通本地文件，绝不向社区上报任何信息。

### 4. 规范目录与安全打包
在临时草稿目录组装标准结构：顶层 \`vonvon-bot.json\`、\`README.md\`、顶层单份 \`skills/<名称>/SKILL.md\`（无需维护双端副本，且每个 \`SKILL.md\` 开头必须带 YAML frontmatter \`name\` 和 \`description\`，否则 Codex/Claude 无法识别）、可选 \`workspace/\`（预置 \`AGENTS.md\` 与知识文档，绝不放 \`.claude/\`、\`.codex/\`、\`.git/\`、\`.mcp.json\` 或 \`.env\`）：
- \`vonvon-bot.json\` 必填与常用字段：
  \`schemaVersion: 1\`、\`id\`（小写字母/数字/连字符，支持 \`作者/配方名\`）、\`version\`（如 \`0.1.0\`）、\`public\`（\`true\` 公开宣传 / \`false\` 私用）、\`name\`（≤80 字）、\`summary\`（≤300 字）、\`docUrl\`（\`public: true\` 时必填 \`https://\` 飞书公开文档链接）、\`author: { name, contact? }\`、可选 \`group: { defaultName?, role?, recommendedPermission?: "qa"|"write"|"full", firstMessage?, schedules? }\`。
- 公开宣传且立即上线：\`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --publish --json\`
- 仅本地打包：\`vonvon template pack <草稿目录> --out <绝对输出路径>.vonvon.zip --json\`
- 若脱敏扫描拦截，按提示清理敏感信息后重试。打包完成后用 \`[文件名](绝对路径)\` 把 \`.vonvon.zip\` 发给用户，并附一段可直接转发到飞书群或小红书的介绍文案。`,
};
