# Windows 安装、下载与应用内升级方案

日期：2026-10-30。Vonvon 代码基线：本地 `origin/main` 的 `86e3349a`，产品版本 0.7.8；逐项核对了该提交的源码。引用会话《检查 Windows 应用内升级》（`01a18a15-bc2a-7039-837a-452cb539f030`）已通过 read_thread 读取。旧的 Windows 安装、重装研究已读，本轮补充用户最新要求和竞品做法。

状态：调研和建议。只新增本报告与索引；没有生成密钥、修改产品、构建安装包、变更现有安装或公开下载。下列交互为建议，不代表当前已经可用。

## 建议

继续使用 Electron 与完整 NSIS EXE 安装包，Windows 不采购代码签名证书；使用自己生成的密钥验证应用更新。官网主要显示一个 Windows 下载按钮，首次安装有简短向导、允许改路径，之后在应用里检查、下载、安装并重启。停止新增 Windows ZIP；已公开的旧 ZIP 链接保留。

用户已经接受：不付费购买证书，首次安装和以后升级可能需要确认 Windows 安全提示。不能把它解释成 Windows 一定会允许安装，或所有版本只需信任一次。

## 当前实现与问题

- `packages/desktop/electron-builder.yml:52-69`：Windows 构建 NSIS 与 ZIP；`oneClick:true`、`perMachine:false`。一键安装不询问路径是当前配置的正常结果，不是安装失败，也不能据此判断为便携版。
- `packages/desktop/src/windows-updates.ts:38-55,76,95-107`：当前应用需有效 Authenticode 签名及匹配发布者才启用更新，下载后和安装前还检查 EXE 的 Authenticode。0.7.8 未签名包因而无法使用应用内更新。这属于当前项目策略。
- `packages/ui/src/management/UpdatePanel.tsx:58-66`：已经有检查、下载、安装并重启及失败重试阶段，可沿用。
- `packages/desktop/src/main.ts:230-249`：安装前已有经过身份核实的 daemon 停止与清理，不应因改签名方案而丢掉这段处理。
- `scripts/publish-windows.mjs:46-51`：发布器只接受 `signed:false,updatesEnabled:false`，不发布 feed。`scripts/package-windows.mjs` 和 `scripts/build-windows.ps1` 也把“未签名、禁止更新”写成门禁，需要一起修改。
- x64 构建产物用 `latest.yml`，ARM64 用 `latest-arm64.yml`；当前客户端固定同一个 generic URL、未显式按架构选择 channel。启用前必须分架构接通，不能直接上传两份 feed 就算完成。
- Windows feed 的安装目标是 EXE，不是用户下载页上的 ZIP。`.blockmap`、更新清单和签名属于更新器内部文件，不应作为用户要选择的下载类型。

本轮没有重跑 Windows 安装或跨版本更新。引用会话中提到的既有 0.7.8 安装报告，覆盖的是安装、覆盖安装、卸载与重装，不能代替跨版本应用内更新验收。

## 同类产品核对

| 产品与依据 | 首次安装 / 产物 | 后续升级 | 可借鉴之处 |
| --- | --- | --- | --- |
| [Clash Verge Rev 2.5.8 Windows 配置](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/tauri.windows.conf.json)、[安装模板](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/packages/windows/installer.nsi) | NSIS EXE；语言选择、目录页；按机器安装。发布有 x64/ARM64 及内置 WebView2 的额外变体 | [更新配置](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src-tauri/tauri.conf.json)内置公钥，Windows 使用 passive 模式 | 首次向导、后续只展示安装进度可以并存。它的管理员范围和 WebView2 变体与 Vonvon 需求不同 |
| [CC Switch 4.0.21 发布流程](https://github.com/farion1231/cc-switch/blob/v4.0.21/.github/workflows/release.yml)、[更新配置](https://github.com/farion1231/cc-switch/blob/v4.0.21/src-tauri/tauri.conf.json) | Windows 只构建 MSI 安装包和 Portable ZIP，不发布多余 NSIS 包；[MSI 模板](https://github.com/farion1231/cc-switch/blob/v4.0.21/src-tauri/wix/per-user-main.wxs)为 perUser / limited | MSI 与 `.sig` 用于 updater；Portable ZIP 明确不参与 updater；应用内置公钥 | ZIP 是另一种使用方式，不是自动升级必需文件。只提供一种主安装包就够了 |

上述两个项目使用 Tauri。参考的是发行方式和信任机制；Vonvon 可以在 Electron 内实现相同目标，无需换框架。未下载或运行竞品安装器，页面及权限结论来自固定版本源码，未对其 Windows Authenticode 实际签名状态下结论。

[Tauri 官方更新文档](https://tauri.app/plugin/updater/)将更新公私钥及验签作为更新机制，并提供 Windows passive 进度窗口模式。[electron-builder v26 自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)支持 Windows NSIS，明确 macOS 的 ZIP 另有更新用途；不能因为停止 Windows ZIP 就同时删除 Mac 更新 ZIP。

## 免费密钥要不要做

建议做。它用于应用判断“这个更新确实由我们发布”，不依赖购买 Windows 代码签名证书。

- 开发者生成一对公私钥，公钥随应用内置；私钥由受控的发布签名步骤使用并安全备份，不进入仓库、应用或 CDN。
- 发布时对更新清单签名，签名绑定产品、通道、版本、目标架构、下载 URL、大小和安装包摘要。应用只接受内置公钥验证成功的清单，下载后按该清单核对 EXE，安装前再次核对。
- 验签后的版本、架构和摘要要贯穿下载与安装；不能只校验一份清单，随后让 updater 重新读取另一份未验证清单并据此安装。若使用差分下载，也必须核对最终重建 EXE。
- 保留 HTTPS、下载域名和路径限制；拒绝缺签名、错误签名、文件篡改、错误架构及不允许的降级。校验失败时保留当前版本并显示可重试错误。
- 密钥生成和验签没有证书年费；现有构建、存储和流量开销仍按原渠道计。用户不用生成密钥、导入证书或配置任何凭据。
- 这能应对只篡改 CDN 文件和清单而拿不到私钥的攻击，不能抵御私钥或签名流程本身失守。首次安装仍需要用户从可信官网获取。

这与 Windows 的 Authenticode、SmartScreen 信誉是两层机制。自建更新签名不会把 Windows 的“未知发布者”变为“已验证发布者”，也不应该让用户把自签根证书导入系统。

当前锁定 electron-updater 6.8.11，安装依赖中没有 `updateManifestPublicKey` 实现。上游[新版签名清单文档](https://www.electron.build/docs/features/signed-update-manifests/)存在原生方案，但不能把新版配置直接照搬到当前依赖。实施时优先采用经验证的稳定支持；如果当前稳定依赖没有该功能，就增加范围明确的验签层。不要为了获取该功能而默认迁移到 7.x alpha，也不要把 `signed` 改成 true 冒充 Windows 已签名。

[微软 SmartScreen 说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)说明未签名文件的新版本不能继承签名发布者信誉，企业策略可能禁止继续，Smart App Control 也可能直接阻断。因此交付承诺应是“受系统允许时可在应用内完成升级，必要时确认安全提示”，不能承诺“以后永远不弹窗”或“所有电脑点信任都能装”。正常当前用户安装通常无需管理员权限；SmartScreen 提示与 UAC 提权是不同事情。

## 预期产品形态

### 官网

Windows 卡片只突出“下载 Windows 版”，下载完整 Setup EXE。保留 x64、ARM64 原生产物；浏览器可靠识别架构时选对应包，否则主推标明 Intel / AMD 的 x64，ARM64 放到“其他版本”中，避免误称已经百分之百自动识别。更新器根据已安装版本架构选包，不让用户每次选择。

停止新增 Windows ZIP，并调整对应构建、清单校验、发布检查、官网链接和说明；历史链接不删除。首屏不展示 blockmap、更新清单、签名、MSI/EXE/ZIP 等技术选项。没有需求时不额外增加 MSI、Store、在线小安装器或全用户安装版本。

### 首次安装

1. 官网下载 EXE，打开；出现安全提示时由用户确认。
2. 简短中文向导显示默认安装位置（当前用户的本地应用目录），允许更改；点击“安装”。
3. 显示进度，完成后启动应用，创建开始菜单 / 桌面入口。

保持当前用户安装；允许改到当前用户可写的目录。受保护的系统目录要提示不可用，不能悄悄切成管理员 / 全用户安装。安装路径与用户数据目录是两件事，改路径不搬动或删除 Bot 数据。后续更新沿用原路径。

[NSIS 配置文档](https://www.electron.build/v26/docs/api/app-builder-lib.interface.nsisoptions/)支持向导与目录修改。但 `oneClick:false`、`perMachine:false` 默认会产生安装范围选择页；要额外固定当前用户并隐藏这页，不能只改两个布尔值就宣称实现上述流程。沿用现有安装兼容 hook，保留旧卸载记录修复及用户数据保护。

### 日常更新

建议默认自动检查并轻量提示，下载由用户点击；不自动退出正在使用的应用。

`发现新版本（版本号、更新摘要） → 下载更新（百分比） → 已验证，安装并重启 / 稍后 → 必要的系统安全确认 → 安装进度 → 重新打开新版`

安装过程不再询问目录、安装范围或要求找文件。点安装前明确会短暂中断 Bot 的后台连接；已有运行任务时显示其状态，让用户决定等待或继续，不能默默终止。点击“稍后”继续使用；失败能重试或打开官网手动下载。重启后比较实际版本，确认升级成功才清掉预期版本状态；若用户取消系统提示，保留数据并在下次启动说明更新未完成。只重启 Vonvon，不要求或自动重启 Windows。

### 老用户迁移

0.7.8 客户端在请求更新源之前就拒绝未签名包，因此仅更改服务器无法激活。现有用户需要从官网手动覆盖安装一次带有新公钥与更新逻辑的版本；不先卸载，不清空配置。新用户首次安装该版本后，后续版本即可使用应用内升级。Mac 和 Windows 下次对外发布仍须遵守统一产品版本号。

## 实施范围与验收

建议按“安装器和下载页收敛”“更新验签与发布 feed”“跨版本实测”三部分推进。先完成前两部分的候选包，再以 Windows x64、ARM64 两个架构各跑 A → B → C；第二跳验证后续连续升级也成立。

必要验收：默认 / 自选路径、空格和中文路径、已有孤立卸载记录；Bot 数据与配置保留、旧 daemon 正常停止、新版恢复连接；联网失败与下载重试；篡改清单和安装包均拒绝安装；错误架构拒绝；安全提示取消；关闭 / 重开后的下载和安装状态；版本未生效时恢复入口。已有安装验收和 mock 单元测试不能代替这些测试。

## 核实记录与限制

本轮由当前代理对照 Vonvon 固定源码、竞品固定发行标签和官方框架文档逐项核对；没有独立代理复查，也没有真实 Windows 升级执行。原 checkout 较旧，核对与报告落在独立 worktree，未把旧 checkout 的 macOS-only 更新逻辑用于 Windows 结论。官网在线页面读取失败，因此没有把本地尚未提交的网站改动当作当前线上页面事实。
