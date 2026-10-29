# Windows Codex 权限修复与实测（2026-10-29）

基线：重新 fetch 后 main/dev 均为 `422f99eb6662739ff7d5bee2c69140c3a009c2ba`，产品 0.7.7。分支 `codex/fix-windows-codex-permissions`。初始交付不合入、不发布、不替换正式安装；owner 后续授权合入见文末。自动验证和 owner 验收分别记录。

## 需求与 owner 后续决定

修复 Windows 被误报为需要升级至已经安装版本的错误，同时验证实际沙箱，保留原生 feishu profile、附加根、配置保护和回显检查。

实测发现缺失配置路径保护的上游边界后，owner 明确要求“不要限制”：不因该缺口额外禁用工作区可写。最终保留两档，设置说明如实描述缺口；这不是 owner 已验收整个修复，也不代表缺口测试通过。

## 根因与实现

- 原 `codexConfinesReads()` 在非 Linux/macOS 平台固定 false，却共用 Linux 最低版本文案；UI 和真正 start/resume 都受到影响。
- Windows 不能使用 `/private/tmp`、`/private/var/tmp` 的 POSIX profile 路径；原生实际报配置路径无效。Windows 不再发送它们，也不替换成整个临时目录或用户目录。
- Windows 受限档要求单独的正式版最低版本 0.163.0。预发布、未知/过旧版本各自说明原因；macOS/Linux 规则保留。
- 用所选二进制的短命 exec-server `initialize` 检查 `environmentInfo.capabilities.windowsMxc`，再用显式 MXC app-server 验证配置接受和 `windowsSandbox/readiness`。单靠 ready 不证明 MXC 存在。
- 最终受限会话显式指定 `windows.sandbox=mxc`，不降到 legacy 实现或完全访问。MXC 不可用、未配置、需更新、探测失败分别说明。
- 版本缓存观察二进制变化；能力缓存含二进制、Codex home、配置/requirements 和 PATH 指纹，合并在途探测。同步消息路径只读缓存，start/resume 异步刷新后再执行；设置和环境诊断共用结论。
- 从所选 Codex 返回的默认 shell 确定 portable PowerShell 的专用目录，只给该目录读取 DLL 的权限。校验运行时标记，拒绝任意目录、凭据根和工作区祖先；不开放整个 cache 或 Codex 凭据目录。
- Windows 根去重、冲突和回显允许等价大小写/分隔符；额外根、不同盘符、网络扩大或 profile 不符仍拒绝。

## 实测环境与方法

Windows 11 Pro 25H2 ARM64，build 26200.9457；Node 24.22.1 x64（模拟），候选 Electron 44.4.5 ARM64。

通过正在运行的正式 Vonvon 的认证只读 RPC 核对，当时实际选中的是 app 内置 `codex-cli 0.165.0-alpha.1.2`，没有活动的托管 Codex manifest；没有把 PATH 的结果冒充它的版本。主要验证另用独立下载并校验官方包完整性的 0.163.0 ARM64，候选显式选中该版本。正式安装、Bot、群绑定、历史和凭据保持原样。

专用工作区含空格/中文、附加只读/可写根、外部哨兵及其他群/项目/私聊/记忆的假资料。使用生产 `CodexAppServerBackend`、参数构造、准入与回显检查，所有文件均为假夹具。记录文件哈希、实际落盘、专用 HTTP 探针服务端记录和原生工具结果。

确定性本地 Responses 替身使用官方 0.163.0 catalog 的 gpt-5.5 metadata，驱动真实 shell 和 custom apply_patch；模型替身不是模拟沙箱。另以已有认证运行真实 gpt-6.1-sol 的三档应用后端会话，没有登录或复制凭据。只统计本地命令访问探针的请求，不把模型 API、MCP 或浏览器网络算进去。

## 真实权限矩阵

| 验收项 | 只读 | 工作区可写 | 完全访问 |
| --- | --- | --- | --- |
| 读取主工作区 | 通过 | 通过 | 通过 |
| shell 与原生 apply_patch 修改主工作区 | 拒绝，符合预期 | 实际落盘，通过 | 实际落盘，通过 |
| 附加只读根写入 | 拒绝，符合预期 | 拒绝，符合预期 | 允许，符合预期 |
| 附加可写根 shell/patch 写入 | 拒绝，符合预期 | 实际落盘，通过 | 实际落盘，通过 |
| 外部哨兵读写、假群/项目/私聊/记忆读取 | 拒绝，哈希保持 | 拒绝，哈希保持 | 允许，只用假资料 |
| 命令访问专用网络探针 | 无请求，通过 | 有请求，通过 | 有请求，通过 |
| 工作区 junction 指向外部资料 | 拒绝读取 | 拒绝读取 | 允许，符合预期 |
| 命令创建通向外部哨兵的硬链接 | 拒绝 | 拒绝 | 允许，仅夹具 |
| 普通目录 symlink | 未测：宿主创建返回 EPERM | 同左 | 同左 |
| 已存在的原生配置保护 | 拒绝修改 | 重启恢复后已有路径拒绝修改 | 不加保护 |
| 原本缺失的原生配置路径 | 不能新建，通过 | **失败：能新建，已记录边界，owner 要求仍开放** | 允许，符合预期 |

三档新建、关闭实际进程后恢复同一原生会话均成功；同一会话从只读切到可写后下一次执行实际落盘。真实模型三档均发生实际工具执行：只读文件不存在且无命令网络请求；可写生成文件、外部哨兵不变且网络有请求；完全访问写入夹具内外并联网。确定性与真实模型测试结束后注册/未确认测试 provider PID 均为空。

## 自动化与界面

- 定向 daemon：198 通过、6 跳过；包括版本、权限表、多根/回显、安装根、Windows capability/cache、start/resume 和选择实际二进制的回归。跳过项为两条 Linux 平台专属断言、文件 symlink 权限不足、Linux resolver、POSIX PATH、nvm shebang；对应 Windows 路径、junction、真实 cmd 启动器均另测。
- UI permission-tiers：19 通过，覆盖三档可选、不可用原因、保留原选择和不扩大权限。
- 协议、client、UI、daemon、desktop 构建及全 workspace typecheck/lint 完成；最终复核以 PR 的准确提交记录为准。没有重复跑无关全量测试。
- 使用独立 VONVON_HOME、Electron userData、测试工作区启动 ARM64 unpacked 候选；未运行安装器、卸载器或正式发布脚本。原生窗口来源确认为该候选 app.asar。
- 浏览器实际选择三档、保存、重新打开，并与 JSON 落盘核对。模拟 Bot 停用，保存后伴随已有“Bot 没启用或没在运行”提示，不能据此宣称真实飞书端到端验收；未登录/启动假 Bot，未向真实飞书发消息。重启候选复核、最终产物与截图位置记录在交付证据中。

## 证据与未测项

本机独立 evidence 目录保留 `native-final-isolated/acceptance.json`、各档 start/resume events、文件哈希、`real-model/results.json`、自动化日志、UI 截图、候选构建记录，以及早期失败的探针。早期未知模型没有 apply_patch、code-mode 模型没有普通 tools 等 harness 失败均保留，不能计为权限通过。

未验：原生 x64、真实 macOS/Linux 内核沙箱、真实飞书 Bot/群链路、需要人工 UAC 的 legacy 初始化。legacy elevated 在生产 minimal-read profile 下实际拒绝并要求 `:root` 读取；没有为此扩大读取范围。unelevated 不满足读取隔离，不放行。缺失配置路径保护不是完成项。

owner 已在本 Windows 电脑验收候选提交 `855dad8fed076c8358f8c5699e3a296866aa6a1f`，并明确要求同步最新 dev、检查通过后合入 dev，再通知 owner 去 Mac 发布更新。正式发布仍由 owner 后续在 Mac 发起，不将 Windows 验收写成 Mac mini 验收。

## owner 验收后的合入复核

- 正常 merge 最新 dev `8f8ccc3d0e8d7989b57ff4f155e8271cd67e7e2a`，无冲突。同步前后本修复的 `packages/` diff 逐行一致。
- 独立复核又发现首启并发问题：readiness app-server 绕过既有 `connectGated`，与 utility 同时初始化空 CODEX_HOME 会竞争 SQLite。用真实 0.163.0 和生产 backend/utility 的三轮并发中一轮复现 utility exit 1，stderr 为 `failed to initialize sqlite state runtime`；该问题不是 dev 同步引入。
- readiness 探测改为复用既有首启闸，外层保留探测剩余 deadline。超时后关闭客户端，闸门稍后开放也不能再启动该客户端；不改变权限 profile 或降级策略。
- 先补首启等待和含闸门等待的超时回归，原代码失败，修复后探测/缓存测试 22 项通过。最终准确提交的独立复核、真实并发复验、自动化和 Linux/macOS CI 结果记录于 PR #580。

## 官方依据

- [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)：MXC、legacy 实现与兼容性。
- [Permissions](https://learn.chatgpt.com/docs/permissions)：原生 filesystem/network profile。
- [App server](https://learn.chatgpt.com/docs/app-server)：会话与 Windows sandbox 协议。
- Codex 官方 `rust-v0.163.0` 源码 `83086188ae0614bd882818ff1aa23f3194962012`：exec-server capability 的 native probe、readiness 的 shortcut、shell 发现和模型 catalog。文档支持与本机执行证据分开记录。
