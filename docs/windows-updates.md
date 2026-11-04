# Windows 应用内更新

Windows NSIS 安装版复用检查、下载、安装并重启及托盘界面。检查不自动下载，退出不自动安装；安装前停止经过验证的 daemon，并等待退出。

## 信任与构建

未购买 Windows Authenticode 证书。客户端内置 `packages/desktop/windows-update.json` 的 Ed25519 公钥，构建可通过外部 `VONVON_WINDOWS_UPDATE_CONFIG` 覆盖同格式 `{publicKey}`；私钥只在仓库外供本地发布工具签署清单，用户无需配置密钥或导入证书。没有有效公钥时不启用更新。

客户端先验证签名清单中的产品、版本、架构、安装包 URL、大小和 SHA-512，再从这份已验签数据生成 updater 元数据；下载后和安装前再次核验最终 EXE。更新清单签名不提供 Windows 系统信誉，首次允许运行不保证后续免提示。0.7.8 老用户需要手动覆盖安装一次支持新机制的版本。

## 差分下载与回退

Windows 自定义 Provider 显式设置 `isUseMultipleRangeRequest: false`，保留其余 runtime 配置。差分下载仍启用：有可用的旧安装包缓存时，更新器复制未变化的块，每个变化片段分别发送单段 HTTP Range 请求，避免下载源拒绝复杂多段 Range 或只返回第一段。请求次数会增加，实际节省取决于版本差异和缓存是否可用。

旧缓存缺失、差分请求失败或重建哈希不符时，继续由 NSIS 更新器回退整包下载。最终文件仍须符合签名清单的大小和 SHA-512，安装前再次核验；签名、架构和下载域名限制不变。

**生效边界：** 旧客户端升级到包含修复的版本时，运行的仍是旧更新器，可能继续回退全量。通常安装修复版后，后续升级才能受益；本次代码修改本身没有发布新版本。

## 公开对象与发布

- 版本化目录 `/bot/windows/<version>/` 保存不可覆盖的架构独立 EXE 和 blockmap；新产物不再提供 Windows ZIP。
- 架构独立的签名入口为 `https://dl.vonvon.cc/bot/windows/stable/<x64|arm64>/update.json`；原始 builder YAML 仅作为构建核验材料。
- 现有 `release-all.mjs`、`release-publish.mjs` 与 `publish-windows.mjs` 编排签名计划、版本化上传、公网摘要复核及 stable 提升；官网交接核对准确计划与签名 feed 回执。具体授权及最终确认遵守发布规则。

## 验证范围

自动化覆盖验签、篡改与架构拒绝、下载和安装分步、地址约束及安装未生效。原生云端安装报告覆盖安装/重装；独立 `codex/windows-upgrade-acceptance` 分支的工具以不同应用身份验证真实完整 EXE 的 A→B→C。fixture 不代表完整产品 UI、daemon、差分或 SmartScreen 已验收。Windows Codex 通过 PR 直接回传路径、当前用户范围、语言与进度、稍后/取消、真实 Bot 停止恢复及数据保留结果，记录准确源码 SHA。

`test/windows-updates.test.ts` 另用本地 40 KiB 夹具、签名清单和只支持单段 Range 的 HTTP 服务，经真实 `createWindowsUpdateDriver` / Provider / NSIS / 差分下载库验证重建、旧缓存发现、失败回退、最终大小及哈希拒绝、安装前再次校验。x64/arm64 是清单与文件路径两条测试分支；测试替换 Electron app/session 和网络 socket，并拦截安装调用，不能代表真实 Windows ARM64、Electron 网络分区、NSIS 安装或产品端到端验收。验收步骤见 [Windows 单段 Range 修复](plans/windows-single-range-updates.md)。
