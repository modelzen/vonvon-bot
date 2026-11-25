# Vonvon 配方清单与目录规范（Schema v1）

本文档与 `vonvon-bot` 主仓库 `packages/daemon/src/template/schema.ts` 保持严格一致。

## 1. 推荐目录结构

标准布局（`standard`）和仓库根布局（`repo-root`）均受支持，推荐使用标准布局：

```text
<recipe-dir>/
├── vonvon-bot.json          # 必填：配方清单
├── README.md                # 推荐：人类可读介绍与安装指引
├── skills/                  # 推荐：顶层统一放一套 Skill，安装时自动同步到双端
│   ├── my-setup/
│   │   └── SKILL.md         # 开头必须带 YAML frontmatter (name, description)
│   └── my-workflow/
│       └── SKILL.md
└── workspace/               # 可选：铺设到目标群主工作区的文件
    └── AGENTS.md
```

### 禁止进入配方的内容
- 顶层或嵌套的 `.git/`、`.github/`、`.claude/`、`.codex/`、`.agents/`、`.cursor/`、`.vscode/`、`.idea/`、`node_modules/`
- `.mcp.json`、`mcp.json`、`.env`、`.env.*`、`.npmrc`、`.yarnrc`、`.vonvon-template.json`
- 任何符号链接（symlink）
- 任何真实密钥/Token、私人飞书 ID（`cli_*` / `oc_*` / `ou_*`）或开发者本机绝对路径

## 2. `vonvon-bot.json` 字段说明

```json
{
  "schemaVersion": 1,
  "id": "author-or-slug",
  "version": "0.1.0",
  "public": false,
  "name": "配方中文名称",
  "summary": "一句话说明这个配方解决什么问题（1-300 字）",
  "tags": ["效率", "日报"],
  "docUrl": "https://my.feishu.cn/docx/...",
  "repository": "https://github.com/owner/repo",
  "installHint": "可选：给使用者的简短安装提示",
  "license": "MIT",
  "credits": [
    { "name": "参考来源", "url": "https://example.com", "license": "MIT" }
  ],
  "author": {
    "name": "创作者名称",
    "url": "https://github.com/owner",
    "contact": "可选联系方式或品牌名"
  },
  "pricing": { "kind": "free" },
  "prerequisites": [
    "可选：前置依赖说明，例如需安装 gh CLI"
  ],
  "group": {
    "defaultName": "建议的新群名称",
    "role": "可选：写入群级 role.supplement 的补充角色设定（绝不覆盖全局 SOUL.md）",
    "recommendedPermission": "write",
    "permissionNote": "为什么建议该权限档位",
    "firstMessage": "安装完成后建议在群里发的第一句话，例如：开始初始化",
    "schedules": [
      {
        "name": "每日简报",
        "when": { "kind": "daily", "time": "09:00" },
        "prompt": "定时任务执行提示词",
        "enabledByDefault": true
      }
    ]
  }
}
```

### 字段约束速查
- **`schemaVersion`**：固定为 `1`。
- **`id`**：必填，正则 `^[a-z0-9][a-z0-9-]{0,62}(?:\/[a-z0-9][a-z0-9-]{0,62})?$`（仅允许小写字母、数字、连字符，支持单段或 `author/slug` 两段）。
- **`version`**：必填，推荐语义化版本（如 `0.1.0`；更新线上已发布配方时应递增，服务端拒绝旧版本降级覆盖）。
- **`public`**：布尔值，缺省严格视为 `false`。仅当用户明确同意上架到 `https://club.vonvon.cc/` 时设为 `true`，且必须提供合法 `https://` 的 `docUrl`（或 `repository`）。
- **`name`**：1–80 字；**`summary`**：1–300 字；**`tags`**：最多 12 个，每个 1–32 字。
- **`group.recommendedPermission`**：仅限 `"qa"` | `"write"` | `"full"`。
- **`group.schedules[].when`**：支持 4 种结构：
  - `{ "kind": "daily", "time": "HH:mm" }`
  - `{ "kind": "weekly", "days": [1,2,3,4,5], "time": "HH:mm" }`（`1`=周一 … `7`=周日）
  - `{ "kind": "every", "minutes": 30 }`（`5`–`1440`）
  - `{ "kind": "cron", "expr": "0 9 * * 1-5" }`
- **`author.publicKey` 与 `promoSignature`**：由 `vonvon template pack` 在本机使用 Ed25519 私钥自动注入与签名，手工起草时**无需填写**。

## 3. `SKILL.md` Frontmatter 规范

`skills/<skill-name>/SKILL.md` 必须以 YAML frontmatter 开头：

```markdown
---
name: my-workflow
description: 一句话清晰说明什么时候触发本技能以及它做什么（不超过 300 字，单行）。
---

正文步骤……
```

## 4. 公开上架隐私边界

当 `public: true` 且执行 `vonvon template pack --publish` 时，客户端**仅**向 `https://club.vonvon.cc/api/publish` 发送经过 Ed25519 签名的公开名片元数据（`id`、`version`、`name`、`summary`、`tags`、`skillNames`、`docUrl`、`repository`、`author`、`pricing`、`acquisition`）及可选封面图。**绝不上传**任何 `SKILL.md` 正文、角色提示词、定时任务或工作区文件。
