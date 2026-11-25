# Vonvon 灵感 Club (`club.vonvon.cc`)

面向国内用户的极轻配方宣传导航站：零 npm 外部依赖，仅依赖 Node 24+ 内置 `node:sqlite`、`node:http` 与 `node:crypto`，约 20–30 MB 内存，可直接部署在现有腾讯云服务器上。

## 设计边界

- **不托管配方内容**：不存 `.vonvon.zip`、不存 Skill 正文、不存提示词与工作区文档、不渲染第三方 HTML。
- **双路径上报、幂等不重复**：
  - `POST /api/publish`：创作者选择公开宣传并执行 `vonvon template pack --publish` 时即刻上报公开名片与飞书文档链接（`docUrl`）；
  - `POST /api/install`：用户通过 `vonvon template stage` 安装公开配方时匿名去重累计安装数，同 `(id, authorPublicKey, version)` 不重复覆写卡片。
- **防篡改与备案安全**：所有公开名片由作者本机 Ed25519 私钥签名，按 `(id, authorPublicKey)` 联合区分；首次出现的新作者公钥进入待信任池，管理员一键信任后该作者后续全部新配方与新版 0 秒自动展示。
- **卡片预览**：有缓存封面图时直接展示真封面，无封面时自动渲染方案 A（纯 CSS 仿真飞书微缩文档卡片）。

## 本地启动

```bash
CLUB_PORT=8787 \
CLUB_DATA_DIR=/tmp/vonvon-club-data \
CLUB_ADMIN_TOKEN=replace-with-strong-secret \
CLUB_PUBLIC_URL=http://127.0.0.1:8787 \
node services/club/src/main.mjs
```

配合主线 1 本地联调：

```bash
VONVON_CLUB_API_URL=http://127.0.0.1:8787 vonvon template pack <草稿目录> --out /tmp/demo.vonvon.zip --publish --json
VONVON_CLUB_API_URL=http://127.0.0.1:8787 vonvon template stage /tmp/demo.vonvon.zip --dest /tmp/demo-group --json
```

## 腾讯云服务器部署与 Nginx 反代

1. 将 `services/club/` 同步至服务器（Node 24+，无需 `npm install`），用 `systemd` 常驻运行，监听 `127.0.0.1:8787`。
2. 环境变量：
   - `CLUB_PORT=8787`
   - `CLUB_HOST=127.0.0.1`
   - `CLUB_DATA_DIR=/var/lib/vonvon-club`
   - `CLUB_ADMIN_TOKEN=<随机 32 字节密钥>`
   - `CLUB_PUBLIC_URL=https://club.vonvon.cc`
   - `CLUB_AUTO_TRUST_KEYS=<可选：逗号分隔的已信任作者公钥，如你自己本机的 author-key 公钥>`
3. Nginx 将 `club.vonvon.cc` HTTPS 流量反代至 `http://127.0.0.1:8787`，并透传 `X-Forwarded-For`。

## 管理员操作示例（也可交给配好 `lark-cli` 的 Vonvon Bot 协助预审）

```bash
# 查看待信任新作者及其飞书宣传文档链接与安装数
curl -H "Authorization: Bearer $CLUB_ADMIN_TOKEN" https://club.vonvon.cc/api/admin/pending

# 一键放行并信任该作者（以后该作者所有新配方与新版自动秒上）
curl -X POST https://club.vonvon.cc/api/admin/authors/trust \
  -H "Authorization: Bearer $CLUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"<作者公钥>","trusted":true,"note":"飞书文档核验通过"}'

# 为已上架配方补充飞书真实封面（可选：上传缩略图 Base64 或由本机 lark-cli 拉取）
curl -X POST https://club.vonvon.cc/api/admin/cover \
  -H "Authorization: Bearer $CLUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"modelzen/vonvon-assistant","authorPublicKey":"<作者公钥>","fetchFeishuCover":true}'

# 紧急下架并拉黑违规作者公钥
curl -X POST https://club.vonvon.cc/api/admin/authors/block \
  -H "Authorization: Bearer $CLUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"<作者公钥>","blocked":true,"note":"违规链接"}'
```
