# 在另一台设备上继续桌面开发

本轮桌面源码以 `codex/session-simplify-reference` 的 `627e68c` 为基线。
`codex/device-handoff` 在此基础上增加交接说明和历史源码补丁归档。
它包含先前各层 PR 的桌面改动，当前不需要逐个合并 PR。

配套 Core 仓库为 `modelzen/feishu-codex-bridge`，交接分支同样为
`codex/device-handoff`。其运行源码基线是 `codex/m1-desktop-capabilities`
的 `ef4f9d6`。桌面仓库已保存对应的 Core 包及精确依赖锁。
只改桌面界面时可以直接使用这份内置 Core。

## 下载并启动

准备 Git 和 Node.js 24，推荐使用运行时锁定的 24.14.1 版本。
在准备存放项目的目录执行以下命令。

```sh
git clone --branch codex/device-handoff https://github.com/modelzen/vonvon-bot.git
git clone --branch codex/device-handoff https://github.com/modelzen/feishu-codex-bridge.git
cd vonvon-bot
npm ci
npm run prepare:runtime
npm run typecheck
npm run build
npm start
```

运行时准备脚本按本机平台选择 macOS arm64 或 Windows x64。
目前不支持 Intel Mac、Windows arm64 或 Linux 的这条运行时准备路径。
首次准备需要下载锁定版本的 Node 并安装 Core 生产依赖。
账号授权、机器人配置和本机数据不会随 Git 克隆同步。

## 交给新设备上的 Codex

在 Codex 中打开 `vonvon-bot` 目录，发送以下说明。

> 继续开发 Vonvon Bot 桌面端。先读 docs/handoff/2026-10-09/CONTINUE.md。
> 以当前 codex/device-handoff 分支创建独立开发分支，先启动桌面端并检查现有页面。
> 需要修改运行核心时，同步处理旁边 feishu-codex-bridge 仓库，更新桌面内置 Core。
> 当前方向是向原版 Bridge 对齐 Agent 设置、导航、群内设置和工具图标，统一页面宽度。
> 已去除无效的历史管理按钮，分享 Codex 已移到用量页，当前会话下拉框已改为静态信息。
> 后续弱化会话管理，但保留剩余操作对应的会话目标。
> docs/handoff/2026-10-09 中的补丁只用于历史恢复，不要直接全部应用到当前版本。
> 等我提出试用发现的问题后，再继续实现具体改进。

## 历史草稿与验证

归档清单见本目录的 `manifest.json`，恢复方法见 `README.md`。
补丁逐份通过临时 Git 索引回放验证，回放结果与采集的源码树一致。
原工作树及其未提交改动保留原样。

大部分旧草稿已由后续实现覆盖或取代。
`atomic-tool-updates.patch` 中的取消安装进程保护是尚未进入当前桌面源码的历史改动。
如要采用，先单独评估并验证取消安装行为。

交接前当前桌面源码通过了类型检查和构建。
本次归档未改应用运行行为，没有重新做完整原生界面验收。
历史草稿的回放验证不代表其功能、测试或发布验收已经通过。
