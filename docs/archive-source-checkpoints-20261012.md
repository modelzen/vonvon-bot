# 历史源码归档检查点

2026-10-12，用户要求归档全部会话前保存所有可识别的项目源码。只读盘点覆盖本项目 `git worktree list` 中全部 64 棵 Mac worktree。19 棵树的 78 个源码、脚本和测试文件分别保存为下列 WIP 提交，全部普通 push 成功。没有合并到 main 或 V6a，没有改写历史。

这些检查点仅保存发现时的原始差异。本轮没有修复源码、运行测试或构建，也没有独立审查。平台、Windows 和 Shipping 验收不由归档提交成立。原会话及未提交改动的作者不能仅凭分支确定，均记为未知；下表路径和原分支供后续识别。

## 逐树 Git 索引

| 原工作树路径 | 原分支 | 保存分支 | 准确提交 SHA | push | 剩余 dirty |
| --- | --- | --- | --- | --- | --- |
| `/private/tmp/vonvon-v5-start-host-20261011` | `DETACHED` | `archive/checkpoint-20261012/vonvon-v5-start-host-20261011-5f8b8d43` | `cab8d56e8fd3c13732164febab8edafe323df64c` | 成功，非 force | `无` |
| `~/.codex/worktrees/atomic-tool-updates/vonvon-bridge` | `codex/atomic-tool-updates` | `codex/atomic-tool-updates` | `d2a4022b8346a4a71416db9b494d4531b4b412ac` | 成功，非 force | `?? node_modules` |
| `~/.codex/worktrees/macos-parity-native/vonvon-bridge` | `codex/macos-parity-native` | `codex/macos-parity-native` | `f8b6075bc1cf56a42b00dc02ddd9f31d2b4feb39` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v3-provider-migration-red` | `DETACHED` | `archive/checkpoint-20261012/v3-provider-migration-red-6fcc88a9` | `1486684d7f011066f2865dec481bbf9000ad35d7` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v3-provider-proof` | `DETACHED` | `archive/checkpoint-20261012/v3-provider-proof-a00d993e` | `401cd5e13766d4bd3fdf082c70e0e0e6c15f4929` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v3-unit-comments` | `DETACHED` | `archive/checkpoint-20261012/v3-unit-comments-fea22fdb` | `39f1d8950a0bb7d42f84cb69145c20bca48b5cb4` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v4-collaboration-repair` | `DETACHED` | `archive/checkpoint-20261012/v4-collaboration-repair-43e748f7` | `e2725a6e537cfc11ba7e0b817e6fab292fc8a6f4` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v4-windows-ci-repair` | `DETACHED` | `archive/checkpoint-20261012/v4-windows-ci-repair-43e748f7` | `7d51a2738c89f4623317f1cf904e01644b614175` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v4-windows-launch-923-diagnose` | `DETACHED` | `archive/checkpoint-20261012/v4-windows-launch-923-diagnose-92358ad2` | `24f7e7df344b5b7dd820c600cfa770b936977311` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v4-windows-launch-repair` | `DETACHED` | `archive/checkpoint-20261012/v4-windows-launch-repair-359d9c53` | `209392414db0b441f19cba9cada184d4de021446` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v4-windows-qualified-bootstrap-834` | `DETACHED` | `archive/checkpoint-20261012/v4-windows-qualified-bootstrap-834-834ade31` | `3eec9e726e69739af09339cfa29cf63e8a0ab49b` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v5-identity-tests` | `DETACHED` | `archive/checkpoint-20261012/v5-identity-tests-9cc916c2` | `1739235a40df324a3ec6b9545cc49df9187ea841` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v5-lifecycle-exit` | `DETACHED` | `archive/checkpoint-20261012/v5-lifecycle-exit-6276121d` | `d1f487a7f8ca029435cefa906dd6624b47158947` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v5-mac-faults` | `DETACHED` | `archive/checkpoint-20261012/v5-mac-faults-d59aee80` | `0fc8f2865c4a73989a43cffc49acb09cbbaef1bc` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v5-service-status` | `DETACHED` | `archive/checkpoint-20261012/v5-service-status-6276121d` | `20b4880766c2328f881c0d4e7ae58e27a0cb89c3` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v5-windows-registration` | `DETACHED` | `archive/checkpoint-20261012/v5-windows-registration-01573db4` | `2b01b6e917ee3b8d726ffb802a75c5454384f4a5` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bot-worktrees/v5-windows-status` | `DETACHED` | `archive/checkpoint-20261012/v5-windows-status-73c7b1a0` | `0c71c8373b4bff0f93cde7a801199b525d16110e` | 成功，非 force | `无` |
| `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/onboarding-controls` | `codex/desktop-onboarding-controls` | `codex/desktop-onboarding-controls` | `1b5f25389d8602b4a5548dea84337610e13e445f` | 成功，非 force | `?? node_modules` |
| `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/settings-parity` | `codex/settings-parity-desktop` | `codex/settings-parity-desktop` | `2f4e5fac64e8fd41c753a66871c3faeec2e84aa0` | 成功，非 force | `?? node_modules` |

`archive/checkpoint-20261012/` 分支保留 detached 树的原 HEAD 为父提交，不猜测它属于哪个旧功能分支。已有非 main 分支沿用原分支。可用每个提交的父提交及 `git show --stat <SHA>` 核对原差异。

## 保留且不入库的非源码

以下目录仍可能触发会话归档的 dirty 提示。它们未删除、未 stash、未提交。

- 根仓库 `supabase/.temp/cli-latest` 是已有 Supabase CLI 版本缓存；`supabase/.temp/linked-project.json` 是项目关联元数据，可能含私有信息。只核对路径和类别，未打印内容。

- `~/.codex/worktrees/atomic-tool-updates/vonvon-bridge/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/.codex/worktrees/machine-lifecycle/vonvon-bridge/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/.codex/worktrees/parity-collaboration-ui/vonvon-bridge/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/.codex/worktrees/parity-environment-lifecycle/vonvon-bridge/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/.codex/worktrees/parity-environment/vonvon-bridge/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/.codex/worktrees/parity-machine/vonvon-bridge/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/agent-list-reference/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/environment-reference/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/group-avatars/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/join-flow/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/onboarding-controls/node_modules` 是依赖目录或依赖链接，未当作源码。
- `~/develop/src/github.com/ClayCheung/vonvon-bridge-worktrees/settings-parity/node_modules` 是依赖目录或依赖链接，未当作源码。

未读取或入库 ignored 的 `.audit`、缓存、构建产物或私有运行 HOME。根仓库 main 未变更。V6a ProcessHost 原 12 文件已保存在 `0acceb90f2fc634e95f9736a8a3f76d2e8290c5f`；原 source 树已对齐 `9ff6a8e1ebeaddf4e7ef8fd7bc015650ac85e435`，不重复提交。

## 恢复入口

V6a 阶段状态见 [V6a WIP 恢复交接](v6a-resume-checkpoint.md)。本轮仅增加本索引，不改变其中的验收边界。PR121 `bf1c39ebfe20fea0e8de64f92fd0efbaf91a2e92` 仍按已有记录视为有技术阻断且未批准，本轮未查询或采用它。CI 继续跳过。

本机逐文件 SHA-256、原始补丁、源码副本和 push 记录位于根仓库 `.audit/continuation-20261012/new-provider-plan/mac-execution-resume/final-git-persistence-20261012/archive-checkpoints/`。详细本机材料不随 Git 分发。新 clone 可直接通过上表分支与 SHA 找回源码，不依赖原会话。

当前状态是停止。只有用户明确重新开始后，才核对相关分支与资源归属，安排相应验证。

## JP-VPS 远端保全摘要

以下是总控转交的 JP-VPS 已完成回报，本 Mac 会话未重新查询远端。远端已盘点全部 14 棵 worktree，并停止执行。

| 远端分支 | 准确提交 SHA | 保存范围与 push | 工作树状态 |
| --- | --- | --- | --- |
| `claude/v5-service-design` | `92518ee8ab0073f2f0b3e54ffb11cf615dfb8496` | 3 份 docs；原远端分支已删除，本次普通 push 重新创建 | 干净 |
| `archive/design-ownership-20261012` | `bdc0c13cef63134433802b19ab0978f56a3e04bd` | `AGENTS.md` 与 3 份 docs；从 detached `817452a` 保全；普通 push；不用于合并 | 干净 |

其余 11 棵历史树与当前 `claude/process-identity` 树均据远端回报为干净。后者 head 为 `bf1c39e`，对应未批准 PR121，不构成采用许可。

未入库目录 `/home/operator/vonvon/provider-redesign/` 据远端回报只有 #116 过程调研资料，定稿已合入 docs，没有未保存设计稿。远端提交仅保全未验证或未采用内容，未合入 main，未合入 PR121。原会话和逐树绝对路径未在本摘要提供，不能据此编造。
