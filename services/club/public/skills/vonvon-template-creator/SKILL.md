---
name: vonvon-template-creator
description: 在任意 Agent（Codex CLI、Codex Cloud、Claude Code、Cursor 等）中创作、整理、校验、打包或发布 Vonvon Bot 配方（.vonvon.zip 或含 vonvon-bot.json 的 GitHub 仓库）。用户提到创作 Vonvon 配方、把项目/Skills/工作流整理成 Vonvon 模板、打包 .vonvon.zip、准备飞书宣传页或发布到 Vonvon 灵感 Club 时，先读本 skill。
---

# Vonvon 配方创作助手（通用开放版）

本 Skill 的定位很纯粹：在任意编程 Agent（本地终端或云端如 Codex Cloud）中，帮助用户**产出一个符合规范的 Vonvon 配方**，并在用户需要时**进一步制作宣传文档、通过格式与安全校验后发布到 [Vonvon 灵感 Club](https://club.vonvon.cc/)**。

> 完整清单字段与校验规范见同目录 [references/manifest-schema.md](./references/manifest-schema.md)（若通过网址读取，见 `https://club.vonvon.cc/skills/vonvon-template-creator/references/manifest-schema.md`）。

## 协作方式（开放节奏，只卡关键门禁）
- **顺着用户的意图和节奏推进**：不强行套用僵化步骤。用户目标明确（例如「把这个仓库改成标准 Vonvon 配方」「打包成私用 zip」「只更新封面和宣传页」）就直接推进；用户还没头绪时，再简明介绍流程并快速检查本机环境（`command -v vonvon`、`command -v lark-cli`），让用户清楚当前能做到哪一步：
  - **本地完整模式（检测到 `vonvon` CLI）**：可提取群、校验、脱敏打包 `.vonvon.zip`、签名上架与自助下架（有 `lark-cli` 时可自动创建/编辑飞书宣传页）；
  - **云端/独立整理模式（如 Codex Cloud，无 `vonvon` CLI）**：专注产出 100% 合规的标准配方目录/仓库与宣传页文案，最后给出回到本机或飞书私聊 10 秒签名上架的交接指令。
- **不替用户做关键决定**：需要确认时用当前宿主最顺手的交互方式（选择工具或简洁编号选项），每次聚焦 1–2 个决定，停下来等用户拍板。

---

## 必须守住的 5 道门禁

### 门禁 1：素材真实，绝不编造
- 用户未给出素材时，先了解来源（当前仓库/本地项目、已有飞书群、一组 Skills、文档/链接、想法或其他任意素材），**绝不凭空编造示例模板直接打包**。
- 本地有 `vonvon` CLI 且素材为「已有飞书群」时，必须用 `vonvon template draft-group <群> --dest <空草稿目录> --json` 提取真实工作区与群 Skills，绝不读取记忆或密钥。

### 门禁 2：标准目录与安全脱敏
按 [references/manifest-schema.md](./references/manifest-schema.md) 组装（仓库配方可直接整理在仓库根目录；压缩包草稿放在 `templates/<id>/draft/` 等干净目录）：
- 顶层 `vonvon-bot.json`（`schemaVersion: 1`，缺省 `public: false`）、`README.md`、顶层单份 `skills/<名称>/SKILL.md`（开头必须带 YAML frontmatter `name` 与 `description`）、可选 `workspace/`。
- **严禁放入**：`.git/`、`.claude/`、`.codex/`、`.agents/`、`.env*`、`.mcp.json`、`node_modules/` 或符号链接；外部依赖写成 `<名称>-setup` 初始化技能，**不写 `mcp.json`**；不写群会话习惯；扫描确认无真实 Key、Token、私钥、飞书 ID 或本机绝对路径；如实填写 `license` 与 `credits`。
- 有 `vonvon` CLI 时必须跑 `vonvon template inspect <草稿目录> --json` 校验（无 CLI 时按 Schema 逐项核对），并在对话里直接给出清晰概览（基本信息、本群角色、技能名与描述、工作区文件名、定时任务、前置依赖与脱敏校验结果），确认内容无误。

### 门禁 3：交付方式、公开与私用、历史同 ID 由用户拍板
- 明确由用户决定：交付形态（GitHub 仓库 / `.vonvon.zip` / 两种都要）、是否需要宣传页、以及是否公开上架 **Vonvon 灵感 Club**（`public: true/false`）。
- 公开前说明隐私边界：上架仅公开宣传名片元数据、宣传页链接与封面，**绝不上传任何 Skill 正文、提示词或工作区文件**。跳过宣传页且只交付 `.vonvon.zip` 时留空 `docUrl`。
- 本地有 `vonvon` CLI 且准备公开上架时，先静默运行 `vonvon template published --json` 查重；若已有同 `id` 线上配方，必须让用户明确选**升级版本号**、**新建独立配方（换 ID）**还是**同版本覆盖修正**，绝不静默覆盖。

### 门禁 4：宣传页与封面经用户审阅后再上架（仅需要宣传页时）
- **封面由用户决定，绝不未经询问擅自生图**（用户提供图片/路径、按用户要求生成且保持简洁克制、或暂不配封面）。
- 宣传页应具备清晰说服力（价值定位与高亮速览、2–3 个真实使用场景或对话示例、技能与能力清单、清晰的安装步骤与首句提示、常见问题，文末留一行 `Vonvon 配方：<id>`）；**封面图只作文档封面，不在正文重复插同图**；**不主动写「免费」字样**（除非用户要求或外部定价）。
- 本地有已登录 `lark-cli` 时优先用 `lark-cli` 创建/编辑飞书宣传页（**绝不开浏览器模拟点击**），做好后先把链接（及新生成封面预览）给用户审阅，允许修改多轮直到满意；无 `lark-cli` 或在云端时，直接输出可复制的宣传页 Markdown（如 `docs/PROMO.md`）供用户审阅与粘贴。

### 门禁 5：单次打包上架或清晰交接
- **有 `vonvon` CLI（本地完整模式）**：一次性写入最终 `vonvon-bot.json` 后**只打包一次**——上架用 `vonvon template pack <草稿目录> --out <输出路径>.vonvon.zip --publish --json`（确保公开飞书文档已设为「互联网上获得链接的人可阅读」），仅私用不加 `--publish`；若含 `.vonvon.zip` 且用了 `lark-cli`，把这份最终压缩包插到飞书宣传页文末。
- **无 `vonvon` CLI（云端如 Codex Cloud）**：核对仓库干净与脱敏后提交或准备 PR，给出清晰的最后 10 秒交接方式（因为云端没有本机 Ed25519 创作者私钥）：
  - **方式 1（飞书私聊）**：把仓库链接发给自己的 Vonvon Bot 私聊，说一句「帮我把这个仓库打包并上架到 Vonvon 灵感 Club」；
  - **方式 2（本机终端）**：拉取仓库后运行 `vonvon template pack . --out ./<id>-<version>.vonvon.zip --publish`。

## 常用 Vonvon CLI 速查（仅本地已安装 `vonvon` 时）
- 提取已有群：`vonvon template draft-group <群> --dest <空草稿目录> --json`
- 校验格式与清单：`vonvon template inspect <草稿目录或zip> --json`
- 脱敏签名打包（可选上架）：`vonvon template pack <草稿目录> --out <路径>.vonvon.zip [--publish] --json`
- 查自己上架中的配方：`vonvon template published --json`（用本机公钥自动查询，不让用户背 ID）
- 确认目标后自助签名撤回：`vonvon template unpublish <id> --json`（仅撤回社区展示，不影响本地文件与飞书文档）
