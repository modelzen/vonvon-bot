# Linux 服务端安装

Mac、Windows 从 [官网下载页](https://vonvon.bot/get/) 下载安装包。Linux 只装服务端，支持 glibc 的 x64、arm64；安装目录是 `~/.local/share/vonvon-bot/server`，数据目录是 `~/.vonvon-bot`。

## 安装命令与发布边界

普通用户从官网下载页复制完整 Linux 安装命令。维护者可在本仓库生成下一次官网交接使用的完整命令：

```sh
node scripts/install-command.mjs
```

输出从 `sh <<'VONVON_INSTALL'` 到末尾的 `VONVON_INSTALL`，整段复制到 Linux 终端即可。生成命令只读本地文件，不联网、不安装。实际执行时会同时从国内、海外源获取完整 `install.sh`，校验 HTTP 状态、末行和 shell 语法后才执行。不要把这段命令简化成先从一个域名获取引导脚本，否则最开始仍可能等在不可达的线路上。

`release-all collect` 同时把这段内容放进 `release-handoff.json` 的 `server.installCommand`，并保存为 `OUT/linux-install-command.sh`。官网复制按钮使用整个字符串，保留换行；本机证据路径不放进网页。

这些是新源码的行为，不表示它已在生产发布。现有 0.9.1 的安装脚本和包内更新器仍只使用国内源；复制旧包、旧脚本到 R2 不会给它们增加自动切换能力。新安装脚本须经过正常发布流程上线；已安装的 0.9.1 服务端须先升级到包含双源更新器的新版本，之后的更新才会自动选择线路。不要用开发分支脚本覆盖现有正式版脚本来绕过发布。

## 自动选择下载源

- 国内源：`https://dl.vonvon.cc/bot/server`，由国内 CDN 提供下载，COS 保存原始文件。
- 海外源：`https://vonvon-linux-download.amber2clay.workers.dev/bot/server`，只提供 Linux 包及相关清单、脚本，文件保存在 R2。

安装和更新时，并行请求两个源的小文件，不靠 IP 判断国内或海外。如果国内源已返回有效内容，就优先使用国内；海外先返回时，只给国内约 300 毫秒的等待窗口，然后开始从可用源下载。完整安装包只从选中的一个源下载，不会同时下载两份大文件。

下载途中显示进度。连接失败、约 15 秒持续没有数据，或者文件大小、SHA-512 不符时，自动从另一个源重新下载。持续有进展的慢下载没有固定总时长限制；切换源会从零开始，不拼接不同源的部分文件。两个源都失败时会退出并清理临时下载，保留已安装版本。

镜像仅改变传输地址。发布清单仍保持国内规范地址和原始签名，更新器必须验证签名、防回退记录和完整安装包。安装脚本保留现有规则：可用 OpenSSL 3 或更高版本时验证签名；没有时明确提示依赖 HTTPS，并继续核对完整文件大小和 SHA-512。首次获取安装脚本本身的信任来自上述两个明确配置的 HTTPS 源。

## 验证

本地回归包括国内源无响应、海外源可用、国内短窗口优先、损坏清单和包、下载中断、两个源都失败，以及终止命令时取消子下载并清理临时文件：

```sh
node --test scripts/install-bootstrap.test.mjs scripts/install.test.mjs scripts/install-smoke.test.mjs
npx vitest run packages/daemon/test/standalone-mirrors.test.ts packages/daemon/test/standalone-update-check.test.ts packages/daemon/test/standalone-update-apply.test.ts
```

这些测试使用隔离目录和本地假源。国内、海外真实线路的可达性及速度需要另做下载验收；本地回归不代表生产脚本、官网或服务端包已经发布。
