# Windows release build

## 0.7.7 候选起：本机与 runner 共用构建验收

Windows x64（Intel / AMD）与 ARM64 各生成两个用户包：

| 用途 | 文件名 | 官网按钮 |
| --- | --- | --- |
| 当前用户一键安装，添加开始菜单和桌面快捷方式 | `Vonvon-Bot-Setup-<version>-<arch>.exe` | 对应架构安装版（推荐） |
| 解压后运行 `Vonvon Bot.exe` | `Vonvon-Bot-<version>-windows-<arch>.zip` | 其他下载：ZIP |

另生成 EXE `.blockmap`、各架构 feed、清单与安装验收报告。未签名版本的 feed 只留作证据，不切 stable。0.7.7 是候选版本，实际发布由 Mac 核对版本占用后进行。

macOS 两个 DMG、Windows 两种架构各两个下载共六项，release-all 的交接清单要求齐全。官网可把 ZIP 收到“其他下载”。两平台必须使用同一个新版本，禁止覆盖已发布版本。

要求 Windows、PowerShell 7 与 Node.js **24.22.1**。在干净的准确源码提交上，本机与 GitHub native runner 都执行同一条命令（以下输出目录必须为源码树外新的专用目录）：

```powershell
./scripts/build-windows.ps1 -Architecture arm64 -Out C:\dedicated\release-arm64 -SourceSha FULL_SHA -InstallDependencies
# x64 使用相同命令，仅改变 Architecture 和输出目录。
```

脚本锁定依赖和 Electron 版本，按 win32 目标架构下载并校验官方 runtime，构建、typecheck、定向测试、NSIS/ZIP 打包、PE 与实际 process.arch 校验。实际 Setup 必须通过全新安装、覆盖安装、卸载重装、0.7.5 孤立记录重装；每次检查后台认证状态、UI 服务和退出。13 项 NSIS 错误路径回归仍执行。

验收用本次创建的 TEMP/vva-* 目录及隔离 VONVON_HOME。拒绝真实已有安装和 HKLM 安装；操作前备份本产品两键、快捷方式和安装器缓存，结束后恢复。安装及卸载均明确 /currentuser 与 /D，发现并发安装则停止并保留现场。报告只证明隔离数据的保留，不声称测试了 owner 默认数据。

本地可加 `-PauseForUi`：首次真实安装完成后写 `acceptance/ui-ready.json`，供当前 Codex 以其中的隔离目录观察桌面初始界面；关闭本次 App 后写 `ui-continue.json`（passed:true）继续。runner 不把后台 UI 服务检查冒充人工桌面观察。

工作流分别在 windows-2025 x64 和 windows-11-arm ARM64 原生运行。汇总任务校验两个报告的 OS 架构、源码 SHA、安装包 SHA 和全部必需场景，缺任何一份都不能产出最终成功交接 artifact。本机 ARM 上运行 x64 只记为仿真，不能代替 x64 native 报告。

Mac 在批准的源码进入 main 后使用既有 `scripts/release-all.mjs` 流程即可。它固定 SHA/version/request UUID 调用同一个 Windows 工作流，消费汇总 artifact；也可手动用 `gh workflow run windows-release.yml --repo modelzen/vonvon-bot --ref main` 构建该 main 快照。Windows 构建不带 COS 凭据，也不发布。

“原样构建”指同一源码、Node、lockfile、官方 Electron 和验收脚本；NSIS 时间戳等可能使两轮包哈希不同，每轮必须重新绑定最终字节与报告。Mac 发布仍执行签名、公证和 stable 的原有门禁。

一键安装减少应用向导步骤；浏览器和 Windows 的未签名提示仍取决于有效签名，不指导用户关闭安全功能。安装占用以 Electron 为主，owner 接受正常体积。

针对 0.7.5：旧卸载器的更新模式会先把文件移动到更长的临时目录，同样可能失败。新安装器只对文件版本 0.7.5.0 的当前用户安装重试旧卸载器的普通卸载模式，并保留快捷方式；其他失败仍中止。0.7.5 没有启用卸载删除应用数据，本次不传删除数据参数；不能单凭兼容参数 `/KEEP_APP_DATA` 声称旧卸载器具有额外数据保护。

0.7.6 后续修复：若旧注册记录仍在，但注册的卸载器与旧应用 EXE 均已不存在，当前用户安装允许继续。不能把实际卸载器的非零退出码、旧程序仍在或畸形记录当作孤立记录跳过。Windows 工作流在打包后运行 `scripts/windows-installer-smoke.mjs`，使用刚下载的 NSIS 编译器和插件验证这类恢复及拒绝路径；本地可传入 `<makensis.exe> <electron-builder NSIS include 目录> <x86-unicode 插件目录>` 执行同样检查。真实重装仍由 Mac 构建的新版本完成 owner 验收。

## Mac 发布下载文件

云端构建完成后，Mac 上执行下面一条命令下载该 run 的产物、核验来源和哈希、上传版本化对象，并完整下载验证公网字节：

```sh
node scripts/publish-windows.mjs --run-id RUN_ID --out /absolute/persistent-evidence --cos-config /absolute/windows-cos.json
```

凭据通过外部配置所指定的环境变量注入。配置只允许 bucket、region、prefix（必须为 `bot/windows/`）、publicBaseURL（必须为 `https://dl.vonvon.cc/bot/windows/`）、secretIdEnv、secretKeyEnv、可选 securityTokenEnv 和 sdkModule。SDK 使用仓库 `scripts/cos-sdk` 的锁文件安装在仓库外，可复用本机已核对的 SDK 工具目录。不要将凭据提供给 GitHub 构建或贴入聊天。

`--download-only` 仅下载和验证，不读取 COS 配置。输出目录必须专用于这个 run，重复执行只复用相同 artifact；已有版本化对象只有在公网字节和响应头完全匹配时才复用，不能覆盖。失败不生成成功 receipt，保留证据供重试。产物若需要重建，应使用新的版本号，避免将不同字节发布为同一版本。

成功后 `windows-publish-receipt.json` 包含 Windows 版本、源码 SHA、安装包与 ZIP 的大小、SHA-256 和公开 URL。用它填入官网独立 Windows 发布配置，运行官网测试和部署预演后按现有 deploy 脚本上线，并核对网页入口。当前未签名发行只供手动下载安装；`latest.yml` 留作构建证据，不上传为 stable 更新源。网站须如实说明未签名和应用内更新不可用。

The `Windows release build` GitHub Actions workflow builds the exact dispatched commit on the hosted `windows-2025` runner. It also runs for pushes to `codex/windows-release-automation` so the workflow can be checked before it reaches the default branch. Routine builds need no local Windows VM.

The two native jobs invoke the shared build-windows.ps1 entry point with x64 or arm64. It checks the payload PE machine and actual runtime architecture, ZIP identity, FileVersion and unsigned state, disabled Windows updates and updater metadata. Each final installer hash is bound to a real install/uninstall/reinstall report. The collect job accepts only matching source/version and both native reports before producing the combined windows-release-inventory.json.

The uploaded GitHub artifact is named `windows-unsigned-<version>-<first 12 SHA characters>`. It contains the installer, ZIP, installer blockmap, `latest.yml`, and inventory. The job has read-only repository permission and no COS credentials or publication step. The unsigned build has Windows automatic updates disabled; `latest.yml` is retained as build evidence and must not be promoted to the stable update feed. A separate publication process may copy the versioned installer, ZIP, and blockmap after verifying the source run and hashes.

To reproduce the package verification after a local Windows build, extract the ZIP and run:

```powershell
node scripts/package-windows.mjs packages/desktop/dist/package <40-character-source-sha> "packages/desktop/dist/package/win-unpacked/Vonvon Bot.exe" "<extracted-zip>/Vonvon Bot.exe"
```

The script refuses missing artifacts, stale or conflicting updater metadata, a non-x64 application executable, or an existing inventory. Use a clean output directory for each attempt.
