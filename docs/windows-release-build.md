# Windows release build

## 0.7.6 起的包名、构建与官网入口

Windows x64 生成两个用户包：

| 用途 | 文件名 | 官网按钮 |
| --- | --- | --- |
| 当前用户一键安装，添加开始菜单和桌面快捷方式 | `Vonvon-Bot-Setup-<version>-x64.exe` | 下载安装版（推荐） |
| 解压后运行 `Vonvon Bot.exe` | `Vonvon-Bot-<version>-windows-x64.zip` | 下载免安装版 ZIP |

另生成 EXE `.blockmap`、`latest.yml`、`windows-release-inventory.json`，共五个 Actions 交接文件，不增加官网按钮。未签名版本的 latest.yml 只留作证据，不切 stable。

全站四个用户下载入口：macOS Apple 芯片 DMG、macOS Intel DMG、Windows Setup EXE、Windows ZIP。Mac 更新用 ZIP 和清单按既有流程生成，供更新器使用；Linux 暂不提供。两平台必须使用同一个新版本，禁止覆盖已发布的 0.7.5。

Mac 顺序：owner 验收候选 → 获准 dev 合入 main → 在准确 main SHA 运行 Windows 工作流 → Mac 下载成功 run 并上传 Windows 文件 → 按既有流程构建、公证和发布同版本两架构 Mac 包 → 消费回执更新官网并部署。

```sh
gh workflow run windows-release.yml --repo modelzen/vonvon-bot --ref main
```

本地 Windows：`npm ci`、`npm run build`，从 `packages/desktop` 执行 `npx --no-install electron-builder --config electron-builder.yml --win nsis zip --x64 --publish never`。输出 `packages/desktop/dist/package/`。用 `node scripts/windows-runtime-smoke.mjs /absolute/application-directory` 分别验证 ZIP 解压目录和 EXE 实际安装目录，不能只执行 `--version`。

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

The job installs the lockfile with `npm ci`, builds the workspace and desktop stage, runs typechecking, Windows daemon tests, desktop tests, and package validator tests, then asks electron-builder for unsigned x64 NSIS and ZIP targets with `--publish never`. It checks that the unpacked application and the application extracted from the ZIP are x64 PE files with identical bytes, that their Windows FileVersion matches the product version, and that Windows reports no Authenticode signature on the applications or installer. The NSIS bootstrapper may itself be x86. It checks that the staged Windows update configuration is empty and verifies `latest.yml` against the installer bytes, then writes `windows-release-inventory.json` with the source SHA, product version, unsigned and update state, and each artifact's filename, byte size, SHA-256, and SHA-512.

The uploaded GitHub artifact is named `windows-unsigned-<version>-<first 12 SHA characters>`. It contains the installer, ZIP, installer blockmap, `latest.yml`, and inventory. The job has read-only repository permission and no COS credentials or publication step. The unsigned build has Windows automatic updates disabled; `latest.yml` is retained as build evidence and must not be promoted to the stable update feed. A separate publication process may copy the versioned installer, ZIP, and blockmap after verifying the source run and hashes.

To reproduce the package verification after a local Windows build, extract the ZIP and run:

```powershell
node scripts/package-windows.mjs packages/desktop/dist/package <40-character-source-sha> "packages/desktop/dist/package/win-unpacked/Vonvon Bot.exe" "<extracted-zip>/Vonvon Bot.exe"
```

The script refuses missing artifacts, stale or conflicting updater metadata, a non-x64 application executable, or an existing inventory. Use a clean output directory for each attempt.
