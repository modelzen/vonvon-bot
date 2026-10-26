# 当前 macOS App 体积与缩减空间

测量日期：2026-10-25。基线是 Vonvon Bot 0.7.13 arm64 App，源码提交 `6f5589b793c73ecfcded6b02cf704a03814b7040`。随后按 owner 要求完成 0.7.14 的 Claude 按需托管安装修改，最终产物与验证见末节；未替换 owner 运行中的 App。

后续澄清：用户明确指出 Claude 应由用户选择后托管安装。查历史发现，2026-10-23 提交 `e74d45a5` 将桌面 SDK 及原生运行时改为内置，同时修改了 product.md 3.11；独立 Claude Code CLI 的托管安装仍然存在。所以下文内置 257.22 MB 是当前产物事实，不能据此把内置当作用户本轮认可的产品要求。依照本轮澄清，优先方向应是恢复 SDK 按需托管安装，再裁剪其他资源。

## 实测基线

当前运行位置：`/Users/<u>/Downloads/Vonvon-Bot-provider-detection-6f5589b7-20261025/mac-arm64/Vonvon Bot.app`。

| 口径 | 实测值 | 说明 |
| --- | ---: | --- |
| App 内普通文件逻辑长度 | 623,762,330 bytes / 623.76 MB / 594.87 MiB | 逐文件 lstat，不跟随符号链接 |
| 普通文件分配块合计 | 642,682,880 bytes / 642.68 MB | st_blocks × 512；不是 APFS 独占物理空间测量 |
| 本次生成 ZIP | 268,407,940 bytes / 268.41 MB | ditto ZIP 实测，不是正式 DMG 发布包 |
| 普通文件数 | 6,966 | 符号链接不重复计数 |

MB 使用十进制。用户配置、聊天记录、缓存和另外安装的 CLI 不在上述 App 统计内。当前目录没有本版本正式 DMG，因此不以旧 DMG 代替。

`/Applications/Vonvon Bot.app` 是另一份旧的 0.7.0 universal App，普通文件合计 644.92 MB。它与当前版的依赖和架构不同，不适合据此判断最近功能造成的增量。

## 构成

| 部分 | MB | 占比 | 主要内容 |
| --- | ---: | ---: | --- |
| Electron 框架及辅助进程 | 299.96 | 48.09% | Chromium、Node 运行能力、图形/媒体库、语言资源 |
| Claude Agent SDK 及其内置依赖 | 257.22 | 41.24% | 其中原生 claude 可执行文件 240.66 MB |
| 其余 daemon 代码与依赖 | 41.58 | 6.67% | 飞书 SDK、语音解码、zod、内部 client/protocol 等 |
| npm | 12.26 | 1.96% | 后端安装能力及 npm 自身依赖 |
| app.asar 与外置网页目录 | 8.31 | 1.33% | 桌面脚本、图标、两份网页构建产物 |
| 其他 | 4.44 | 0.71% | 签名清单、App 图标、入口和元数据 |
| 合计 | 623.76 | 100% | |

Electron 和内置 Claude 合计 89.33%。前端已经相当小，单纯换组件库、压缩 CSS 或精简 React 代码不会显著改变总量。

Electron Framework 的 298.25 MB 内，主二进制 201.69 MB，资源目录 76.39 MB，库目录 18.85 MB，其他约 1.32 MB。语言资源共 50.37 MB。

其余 daemon 中，按目录含各自嵌套依赖统计：飞书 SDK 15.09 MB，ogg-opus-decoder 12.90 MB，zod 5.40 MB，内部 client 所在树 3.34 MB，daemon cli.js 2.59 MB。目录间通过符号链接共享的依赖不再重复计数。

## 其他可选裁剪（本次未实施）

以下是候选文件的实测长度，尚未生成裁剪版并完成验收；节省量不包含重新签名后清单体积变化。

| 优化 | 候选节省 | 证据与实施约束 |
| --- | ---: | --- |
| Electron 只保留中英文语言资源 | 48.04 MB | 按 en、en_GB、zh_CN、zh_TW 保留计算；减少其他语言的 Chromium 本地化，须确认语言支持范围并检查回退 |
| 网页构建产物只留一份 | 2.93 MB | app.asar/ui 和 Resources/ui/dist 逐文件内容一致；桌面和 daemon 当前各自使用一份，需统一资源路径后再删 |
| 排除 npm 文档和手册 | 2.67 MB | Resources/npm/docs 与 man 的文件合计；保留安装功能、依赖和许可证 |
| 飞书 SDK 只保留实际加载的构建格式 | 5.49 MB | 同时包含 lib 与 es；当前 main 指向 lib/index.js，需验证所有入口没有依赖 es |
| 移除未使用的 Opus ML 增强资源和独立浏览器产物 | 12.31 MB | opusToPcm 只设置 sampleRate、forceStereo；上游仅在 speechQualityEnhancement 为 lace/nolace 时动态加载 ML 分支；必须回归真实 Ogg Opus 解码、错误输入和资源释放 |
| 裁剪运行时不加载的 TypeScript 源码 | zod/src 为 3.08 MB | 其他包也有源文件，但不能按 src 名字一刀切；部分包的 JS/WASM 运行入口就在 src 内 |

前三项文件算术合计约 53.63 MB；再加飞书、Opus 与 zod 的候选裁剪，总量约 74.51 MB。这些收益尚未经裁剪构建验证，不计入本次结果。

当前脚本已实现 compact staging、同源依赖复用、排除声明文件和 sourcemap；本次 App 的 daemon 树中 `.d.ts` 和 `.map` 均为 0。不能把旧 0.7.0 的 16.89 MB 飞书类型声明或旧 sourcemap 再算成当前版收益。

实施位置主要是 `packages/desktop/electron-builder.yml`、`packages/desktop/build.mjs`、`scripts/stage-daemon.mjs`。要在打包阶段裁剪，并重新签名验证；不修改已安装的签名 App。

## 体积更大的改变

### Claude 改为按需安装

当前 SDK 随桌面 App 内置，是 build.mjs 显式加入 staged dependencies 的行为，并检查匹配的原生运行时存在。整个 SDK 及其专属依赖约 257.22 MB，其中 240.66 MB 是二进制；对我们自己的 JavaScript 做 minify 无法明显缩小它。

由基线扣除 SDK 树的初步文件算术为 366.54 MB；实际 0.7.14 产物为 365.22 MB，差异还包含签名资源清单与依赖图变化。首次使用 Claude 需要联网下载，使用后的总磁盘占用未必减少，只是由用户决定是否安装到 App 外的托管目录。

另一种方案是复用用户已有 Claude 安装，但需要验证 SDK 与运行时版本兼容，不能直接认定所有用户都已安装。

### 更换 Electron 外壳

Tauri 在 macOS 使用系统 WKWebView，可以避免随 App 携带 Chromium。官方资料见 [Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/)。

但 Vonvon 当前 daemon 和 npm 使用 `ELECTRON_RUN_AS_NODE=1`，Electron 也提供后端执行环境。因此不能直接把 300 MB 从包体中扣掉：改壳后还需提供 Node 或迁移后台运行方式，并重做 preload/IPC、托盘、窗口、CLI 注册、更新和签名适配，验证 WebKit 兼容性。适合独立架构评估，不作为首轮小改。

## 容易误判的方向

- 当前版已经是 arm64，不存在再删除 Intel slice 的同等收益。未来正式分发可继续按 arm64/x64 分包；旧 universal 的大小不能作为当前版可裁剪额度。
- ZIP/DMG 压缩减少下载体积，解压后的 App 仍然相同。当前 ZIP 268.41 MB 已说明这一差别。
- 当前已启用 asar；它主要合并文件，不是把两个大运行时压成小程序的方案。Electron 的 ASAR 文件访问及子进程限制见 [官方文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives)。
- 本地 electron-builder 26.15.3 schema 支持 `electronLanguages`；其 compression 说明还明确指出 maximum 通常没有明显体积差异却会增加构建时间。配置参考 [electron-builder](https://www.electron.build/docs/configuration/)，当前官网默认展示 v27，具体参数以项目锁定的 v26 schema 为准。
- 不优先删除图形回退、媒体、ICU 或崩溃处理组件；它们有运行时职责，需要专门的兼容性验证。

## 复核方法与证据

1. 从运行进程命令定位 App；读 Info.plist 确认 0.7.13，用 file 确认 Electron Framework 为 arm64。
2. 对 App 运行 os.walk(followlinks=False) 与 lstat，只累计普通文件长度和 st_blocks，避免 framework 符号链接重复计数。
3. 解析 app.asar 文件头，逐文件比较其中 ui 与 Resources/ui/dist，确认全部 2,926,234 bytes 相同。
4. 对照 `6f5589b7` 的打包脚本与 audio.ts，以及 App 内 npm 包的 package.json 和解码器源码。
5. 执行 `ditto -c -k --sequesterRsrc --keepParent <App> <临时ZIP>`，成功退出后读取产物字节数。

原始本机清单：`/tmp/vonvon-app-size-20261025.json`；压缩实验：`/tmp/vonvon-app-size-20261025.Sz7x77/Vonvon-Bot-0.7.13-arm64-audit.zip`。临时文件不是长期发布产物；本报告保留关键可复算数据。

## 0.7.14 实施结果

以 `dev` 的 `d72c2c3f005a907a052d8ffbd7267441920937ad` 为初始基线，随后同步 `a74d5226` 的工具页改动，最终产物源码为 `e57df0617625b985ca8358e88e074419b67a7fe3`。移除桌面 SDK staging、universal Claude 下载和内置标记，恢复用户主动安装、更新和卸载。build、afterPack、universal 验证均拒绝夹带 Claude SDK、原生平台包和 Claude Code。Electron、npm、语言资源、现有语音功能保留。

| 口径 | 0.7.14 arm64 实测 | 相对 0.7.13 |
| --- | ---: | ---: |
| 普通文件逻辑长度 | 365,217,790 bytes / 365.22 MB | 减少 258.54 MB / 41.45% |
| 普通文件分配块合计 | 376,446,976 bytes / 376.45 MB | 非 APFS 独占空间口径 |
| ditto ZIP | 156,539,813 bytes / 156.54 MB | 减少 111.87 MB / 41.68% |
| 普通文件数 | 4,274 | 减少 2,692 |

新包构成：Electron 299.96 MB，daemon 41.58 MB，npm 12.26 MB，app.asar 与外置 UI 8.32 MB，其他 3.11 MB；Claude 为 0。签名产物在本机 `Downloads/Vonvon-Bot-managed-Claude-0.7.14-20261025/`，不是已发布版本。

真实安装在本轮隔离用户目录进行，使用 App 自带 npm 和 Electron Node 模式。SDK 与 arm64 原生包均为固定版本 0.3.296；安装后 backends 为 280.50 MB，npm 下载缓存约 143.32 MB，二者均在 App 外。卸载不清公共 npm 缓存，保留后续安装复用；不能把 App 缩小等同于启用 Claude 后总占用同比下降。

验证记录：

- 完整 build、typecheck、lint 通过；后端定向 63/63、UI 全部 565/565、桌面全部 237/237、打包/版本检查 50/50 通过。
- 实际 arm64 package:dir 执行 afterPack 检查，签名后 `codesign --verify --deep --strict` 通过，签名 App 窗口成功启动。
- App 移到源码树外，以隔离 HOME、VONVON_HOME、桌面 userData 和最小 PATH 启动；选择 Claude 后保持未安装，磁盘无托管 SDK。点击安装才触发 bundled npm 下载。
- Codex 内置浏览器操作完成安装、更新固定版本、手动重启后台（PID 更换、原端口恢复），重新检测保留 0.3.296；卸载后 UI 恢复“安装 SDK”，磁盘中 SDK 和原生包均不存在，lockfile 保留。刷新及再次选择 Claude 不重装。
- 真实离线 npm 依赖图测试另验证共享依赖、另一个后端及账号文件保留；独立 gpt-6-astra 复审通过。更新/重装后需手动重启后台生效，UI 持久说明；不自动中断任务。
- 本轮没有注册 Bot、连接真实 Claude 账号或发送飞书消息。未跑正式 universal 打包与物理 Intel；本地签名不是公证或发布，owner 验收尚待进行。隔离 App 和 daemon 已停止，owner 使用中的 App 未替换。
