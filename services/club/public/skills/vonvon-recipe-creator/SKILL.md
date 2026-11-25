---
name: vonvon-recipe-creator
description: 在任意 Agent（Codex CLI、Codex Cloud、Claude Code、Cursor 等）中创作、整理、校验、打包或发布 Vonvon Bot 配方（.vonvon.zip 或含 vonvon-bot.json 的 GitHub 仓库）。用户提到创作 Vonvon 配方、把项目/Skills/工作流整理成 Vonvon 模板、打包 .vonvon.zip、准备飞书宣传页或发布到 Vonvon 灵感 Club 时，先读本 skill。
---

# Vonvon 配方创作助手（通用 Agent 版）

本 Skill 帮助你在任意编程 Agent 环境（本地终端 Agent 或云端沙箱 Agent 如 Codex Cloud）中，把一个项目、一组 Skills、一份教程或一个场景点子，整理成符合 Vonvon Bot 标准的**配方**（`vonvon-bot.json` + `skills/` + 可选 `workspace/` + 飞书宣传页），并在环境支持时完成脱敏打包与上架 [Vonvon 灵感 Club](https://club.vonvon.cc/)。

> 完整清单字段与校验规范见同目录 [references/manifest-schema.md](./references/manifest-schema.md)（若通过网址读取，见 `https://club.vonvon.cc/skills/vonvon-recipe-creator/references/manifest-schema.md`）。

## 交互原则
- **主动分步引导，绝不代替用户做决定**：每一阶段交代清楚进度与选项，停下来等用户确认后再推进。
- **严禁凭空编造示例场景**：如果用户只说了「帮我创作一个配方」但还没给素材，绝不自己编一个日报/会议清单模板直接生成；先问用户素材来源。
- **优先使用当前宿主最顺手的提问方式**：若宿主有交互式选项工具，优先发可选项（并留开放输入）；否则输出简洁编号选项并停下等待回复。
- **绝不未经询问擅自生成封面图**，也**绝不静默覆盖用户已发布过的同 ID 历史配方**。

---

## 开场：环境自检与 3 步路线图（开始创作时先做）

先静默检测当前运行环境能力（1 秒完成）：
- 检查 `command -v vonvon`（本地是否已安装 Vonvon CLI）
- 检查 `command -v lark-cli` 及其登录状态（仅本地有 `lark-cli` 时可自动创建飞书宣传页）

然后用 **4 行以内**告诉用户整体步骤与当前环境模式，让创作者心里有底：
- **全程 3 步（约 2–3 分钟）**：① 确定素材来源 → ② 整理草稿、展示完整概览并一次敲定交付/宣传/封面（与版本） → ③ 生成成品并完成上架或交接。
- **环境模式一句话说明**：
  - **本地完整模式（检测到 `vonvon` CLI）**：可直接做安全校验、脱敏打包 `.vonvon.zip`、用本机创作者密钥 Ed25519 签名上架到 `club.vonvon.cc`（若有 `lark-cli` 还可全自动建飞书宣传页）；
  - **云端/独立整理模式（如 Codex Cloud，未检测到 `vonvon` CLI）**：专注把仓库或素材整理成 100% 合规的标准 Vonvon 配方目录/PR + 可直接粘贴的飞书宣传页文案；最后给出一句复制即用的指令，回到本机终端或飞书 Bot 私聊 10 秒完成签名上架。

---

## 第 1/3 步：确定素材来源

若用户首条消息已给出素材（例如当前仓库、目录、文档、链接或想法），说明路线图后直接进入第 2 步。否则询问素材来源（明确说明不限于以下几类，任何素材都可以）：
1. **当前代码仓库 / 本地项目目录**：提炼项目里的工作流、规则和 Skills；
2. **已有飞书群（仅本地有 `vonvon` CLI 时可用）**：通过 `vonvon group list --json` 选群并用 `vonvon template draft-group` 提取真实群配置与 Skills；
3. **一组顺手的 Skills、教程、文档或链接**：整理为可一键安装的规范配方；
4. **直接说一个工作流想法**：一起梳理角色、Skills 和定时任务；
5. **其他任意素材**：零散笔记、截图、脚本或提示词片段。

---

## 第 2/3 步：整理草稿、展示完整概览并敲定发布选项

### 2.1 按标准结构组装草稿
将草稿整理到清晰的输出目录（GitHub 仓库配方可直接整理在仓库根目录；压缩包草稿放在工作目录 `recipes/<id>/draft/` 等干净目录）：
- **已有飞书群且有 `vonvon` CLI**：必须直接运行 `vonvon template draft-group <群> --dest <空草稿目录> --json`，绝不手动编造 Skill。
- **其他来源**：按 [references/manifest-schema.md](./references/manifest-schema.md) 生成：
  - `vonvon-bot.json`（`schemaVersion: 1`，缺省 `public: false`）
  - `README.md`（配方介绍与安装方式）
  - `skills/<skill-name>/SKILL.md`（每个 `SKILL.md` 顶部必须带 YAML frontmatter `name` 与 `description`；如依赖外部 CLI/API Key/MCP，写成一个 `<name>-setup` 初始化技能，**绝不写 `mcp.json` / `.mcp.json`**）
  - 可选 `workspace/`（预置给新群的 `AGENTS.md`、模板文档等）
- **安全与脱敏红线（强制自检）**：
  - 绝不放入 `.git/`、`.claude/`、`.codex/`、`.agents/`、`.env*`、`.mcp.json`、`node_modules/` 或任何符号链接；
  - 扫描全部文件，确保不含真实 API Key、Token、私钥、`cli_*`/`oc_*`/`ou_*` 飞书 ID 或本机绝对路径（`/Users/...`、`/home/...`）；
  - 不在清单里写群交互习惯（免 @、多话题/单会话模式）；引用第三方素材时如实写入 `license` 与 `credits`。

### 2.2 校验与历史同 ID 检测
- **有 `vonvon` CLI 时**：
  1. 运行 `vonvon template inspect <草稿目录> --json` 校验结构和清单；
  2. 静默运行 `vonvon template published --json` 检查本机是否已发布过同 `id`（或同名）的线上配方。
- **无 `vonvon` CLI（如 Codex Cloud）时**：按 [references/manifest-schema.md](./references/manifest-schema.md) 逐项校验 JSON 字段、正则、frontmatter 与敏感信息。

### 2.3 输出完整配方概览
不要只丢文件路径，直接向用户列出 6 块清晰概览：
1. **基本信息**：名称、`id`、版本、作者、简介、权限建议与原因、安装后首句提示（`firstMessage`）；若检测到线上已有同 ID 历史配方，**醒目标出当前线上版本与安装数**；
2. **本群角色设定**：核心摘要或「无（沿用工作区 `AGENTS.md`）」；
3. **技能列表（共 N 个）**：逐项列出技能名 + 一句话描述（标出 `[setup]`）；
4. **工作区文件（共 N 个）**：逐项列出相对路径文件名与用途（超 15 个按目录分组）；
5. **定时任务（共 N 个）**：逐项列出任务名、触发周期与核心内容（无则写「0 个」）；
6. **前置依赖与脱敏检查结果**：外部工具要求、校验告警数（0 项或具体项）与草稿目录路径。

### 2.4 一次敲定交付、宣传页、封面与版本方式
向用户一次确认以下选择（不要拆成多轮零碎提问）：
1. **交付方式**：
   - `GitHub 仓库`（在云端 Agent / 开源项目里默认推荐）
   - `打包成 .vonvon.zip`（本地有 `vonvon` CLI 时单文件可直发）
   - `两种都要`
2. **宣传页与 Vonvon 灵感 Club**（说明公开上架仅上报 `docUrl`、标题、简介、标签、Skill 名称列表和封面，**绝不上传任何 Skill 正文、提示词或工作区文件**）：
   - `生成公开飞书宣传页，并发布到 Vonvon 灵感 Club（推荐）`（`public: true`）
   - `只准备飞书宣传页自己分享（不上社区）`（`public: false`）
   - `跳过宣传页，只留配方目录/包`（`public: false`，若只打 `.vonvon.zip` 则留空 `docUrl`）
3. **宣传页封面图（建议配一张；跳过宣传页则忽略，绝不未经询问擅自生图）**：
   - `用户提供图片或本机图片路径（推荐）`
   - `由 Agent 按配方主题/用户描述生成一张`
   - `暂不配封面图`（社区自动展示配方简介微缩卡片）
4. **历史同 ID 配方处理（仅当检测到线上已有同 ID 配方时必问，绝不静默覆盖）**：
   - `升级发布新版本（推荐，如 v0.1.0 → v0.2.0）`
   - `新建独立配方（换新 ID 与名称）`
   - `同版本覆盖修正（保留原版本号）`

---

## 第 3/3 步：完成成品输出与上架（按环境分流）

先按用户第 2 步确认结果一次性写好最终版 `vonvon-bot.json`（版本号、新 ID、`public`、可选 `docUrl`）。

### 分支 A：本地有 `vonvon` CLI（完整闭环）
1. **需要飞书宣传页时**：
   - 若本机 `lark-cli` 已登录：严格按用户选定的封面方式处理封面（用用户图 / 按要求生成 / 跳过），建飞书文档写入配方介绍、安装方式和一行 `Vonvon 配方：<id>`；需要上架社区时设为「互联网上获得链接的人可阅读」；拿链接写进 `docUrl`。
   - 若未装/未登录 `lark-cli`：不要卡住流程，直接输出可复制的宣传页 Markdown（以及用户选择生成/提供的封面图），指引用户 10 秒建飞书文档并设为互联网可读后把链接发回。
2. **只打包一次**：
   - 发布到社区：`vonvon template pack <草稿目录> --out <输出路径>.vonvon.zip --publish --json`
   - 仅私下分享：`vonvon template pack <草稿目录> --out <输出路径>.vonvon.zip --json`
   - 若交付含 `.vonvon.zip` 且用了 `lark-cli`，把这份最终压缩包作为附件插入飞书文档。
3. 交付成品路径、飞书宣传页链接和（若公开）`https://club.vonvon.cc/`。

### 分支 B：云端 / 无 `vonvon` CLI（如 Codex Cloud）
1. 在仓库或工作目录落盘完整规范的配方文件（`vonvon-bot.json`、`README.md`、`skills/*/SKILL.md`、可选 `workspace/`），可顺手在仓库根目录或 `docs/PROMO.md` 附一份可直接粘贴到飞书文档的宣传页正文（含一行 `Vonvon 配方：<id>`）。
2. 如在 Git 仓库中，帮用户核对 `git status` / `git diff`（必要时提交或准备 PR），确保没有混入任何敏感信息。
3. 给出清晰的**最后 10 秒上架交接指引**（因为云端容器没有本机创作者 Ed25519 私钥，需回到本机完成最后一步签名）：
   - **方式 1（最省事 · 飞书私聊）**：把仓库链接（和新建好的公开飞书宣传页链接）发给你的 Vonvon Bot 私聊，说一句「**帮我把这个仓库打包并上架到 Vonvon 灵感 Club**」；
   - **方式 2（本机终端一行命令）**：拉取该仓库后运行 `vonvon template pack . --out ./<id>-<version>.vonvon.zip --publish`。

---

## 查看或自助下架已发布配方（仅本地有 `vonvon` CLI）
- 查自己发过的配方：`vonvon template published --json`（自动用本机公钥查询，不需要用户记 ID）
- 确认目标后自助签名撤回：`vonvon template unpublish <id> --json`（仅撤回社区展示卡片，本地文件与飞书文档不受影响）
