# 发布版代码查阅的部署与维护

公网入口为 `https://code.vonvon.cc/mcp`，部署在官网腾讯云主机。首次验收复用配方环境的真实 VonVon 账号。该域名的独立账号进程在 `/release-code/oauth` 签发令牌。源码只通过这项已登录服务提供给获准的用户；没有 Git、目录浏览或下载入口。

## 主机

1. 确认主机能访问账号服务的 HTTPS 公钥并有足够磁盘、内存。安装 Linux 系统 ripgrep、Python 3.8+、Node 24 LTS、Nginx、SSH 和 systemd。域名指向这台主机，证书使用同名独立 lineage，webroot 为 `/var/www/vonvon-code-acme`。
2. 建立独立服务账号 `vonvon-release-code`（无登录 shell）及专用同步账号 `release-code-upload`（可用 shell 供 sshd 执行固定命令），共享读取组 `vonvon-release-code`。创建 `/srv/vonvon-release-code`，属主 `release-code-upload:vonvon-release-code`、权限 `2750`，位于网站静态目录之外。只有同步账号能更新此目录。MCP 只对其 SQLite 状态目录有写权限。
3. 根账号将仓库的 `scripts/release-code.py` 安装至 `/opt/vonvon-release-code/release-code.py`（root 所有，0644）。将 `services/release-code-mcp/` 安装至 `/opt/vonvon-release-code/service/`，按 lockfile 执行 `npm ci --omit=dev`。复制 `mcp.env.example` 到 `/etc/vonvon-release-code/mcp.env` 并填实际域名。按本机 Node 和 rg 路径调整 unit/env。
4. 将本目录的三个 systemd unit 安装到 `/etc/systemd/system/`，执行 `systemctl daemon-reload`、`systemctl enable --now vonvon-release-code.service vonvon-release-code-prune.timer`。配置独立的 Nginx vhost（示例见同目录），检查 `nginx -t` 再 reload。服务监听回环；Nginx 把 MCP 和 protected-resource metadata 转发到 8784，把同域 OAuth 和登录回调转发到 4346。HTTP 端口只服务独立证书的 ACME webroot。
5. 账号中心按 `services/recipe-web/release-code-oauth.md` 配置相同环境下的 issuer、精确 MCP resource 和 OAuth 注册。测试、正式账号和密钥各自隔离。代理不记录 OAuth 请求/响应、URL 查询、授权头或源码。源码服务不需要 GitHub、Supabase 管理或签名私钥。
6. 为 Mac 发布机创建专用 SSH 密钥，其公钥在同步账号的 authorized_keys 中固定接收器。该文件由管理员控制。示例行如下。SSH 配置中的别名 `release-code-upload-prod` 固定主机、用户名、专用私钥和已验证的 host key，并设 `IdentitiesOnly yes`。

```
restrict,command="/usr/bin/python3 /opt/vonvon-release-code/release-code.py receive --root /srv/vonvon-release-code" ssh-ed25519 PUBLIC_KEY
```

## 发布与恢复

用户从 Bot 返回的真实记录链接查看反馈。旧 `/feedback/` 地址跳转到全部反馈视图，由现有多维表格承载查看、进展和评论。

在发布机的 `~/.config/vonvon-release/release-code.json` 写入 `{"sshHost":"release-code-upload-prod"}`，后续沿用现有发布命令。也可用环境变量 `VONVON_RELEASE_CODE_SSH` 指定本次使用的 SSH 别名，该变量优先；设置为空串可暂停本次同步。未配置的发布机沿用原流程。正式 stable 提升成功、回执核验并写入 `release-handoff.json` 后自动同步，候选、测试和版本化上传阶段都不触发。已有公开发布可用同一条重试命令初始化。只有这台发布机需要读取开发仓库。

```sh
python3 scripts/release-code.py send --out /absolute/release-output --host release-code-upload-prod
```

原发布 worktree 已撤销时追加 `--repo /absolute/local-checkout`，该仓库必须包含回执指定的提交。导出器从提交读取普通文件（五个产品包的 src/test、daemon/native 中的源码，以及各包的 package.json、tsconfig.json），不读取未提交文件、Git 历史、软链、私钥文件或运维配置。发现含常见凭据形状或私钥标记的文本时整份排除。改变分享范围前复查允许清单。

接收器核对传输字节数、SHA-256、路径、文件类型、大小以及产品版本；完成后原子切换 `current`。同一版本和哈希可重复同步；迟到的旧发布不能覆盖新版。MCP 请求在开始时固定真实目录，已退役的目录至少保留十分钟，再由 timer 清理。传输中断继续使用原版本。重试成功后发布目录的 `release-code-receipt.json` 记录精确版本、提交与快照哈希。MCP 停止或上传失败都可独立修复，保持已发布的官网和安装包。

首次验证时，读取本机 `http://127.0.0.1:8784/healthz`；经 HTTPS 确认未认证的工具请求得到 401、认证后的文件版本与回执一致。源码部署只切换目录，无需重启；升级 MCP 服务代码时再重启 unit。业务统计按小时只累计账号、工具和调用次数。
