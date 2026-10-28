# Windows release build

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
