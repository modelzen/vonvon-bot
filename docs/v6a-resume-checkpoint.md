# V6a WIP 恢复交接

2026-10-12 用户要求持久化当前成果并停止全部主动执行。本交接是阶段检查点，不是版本验收或发布许可。

## Git 与恢复入口

功能分支为 `codex/v6a-provider-core`，PR117 保持未合入。`953eabdd51f5f0eb1a4ac351f5a1c421aa72717c` 已保存 outbound/PID 修正；`0acceb90f2fc634e95f9736a8a3f76d2e8290c5f` 保存独立 ProcessHost 的 12 文件 WIP 阶段。本交接所在提交另保存 Import fixture 修改。

全新 clone 后切换该分支，先阅读本文与 `docs/plan.md`、`docs/providers.md`，再按 AGENTS.md 安装本机依赖。不要复制其他机器的 node_modules 或构建产物。只有用户明确重新开始后才执行后续开发与验证。

## 已有证据及其边界

- Outbound 本地四份定向测试共 91 PASS，daemon typecheck/build 通过，有独立源码审查。HTTP/SSRF、真实服务和完整验收未因此闭环。
- Windows PID fixture 三处 producer 改为写完关闭后同目录 rename，强制发布对照及 Mac 定向检查通过，有准确源码复审。修正 head 的 Windows 原生验证未完成；历史 immediate cancellation、import interruption 与 ENOTEMPTY 原因未证实。
- ProcessHost 原冻结 caller/helper 组合 87 mock PASS；最后两文件管道义务修正 49 PASS，完整 daemon typecheck 通过，7b 准确 SHA 复审关闭该源码阻断。最初隔离副本因缺局部 SDK 的 typecheck 失败日志保留，同字节副本改用正确依赖解析位置后通过。新 host 未接入 daemon lifecycle。
- macOS C helper 已独立编译，真实 reader 对两个自建 fixture 做六次身份读取；原始 OS 微秒与 JSON 转换吻合，JS Number 的二进制舍入误差另有记录。七个 helper 和两个 fixture 自然 exit/close 0，没有发送信号。这仅是 reader 证据。
- 本提交的 `packages/daemon/test/import-core.test.ts` SHA-256 为 `31fef78987542373cd1b2ada12eb8651a5cea9b5f342f311dab741c9d924818c`。只有静态检查，未运行该修改的测试、未独立审查、未验证 Windows。允许 WIP 持久化不等于验收。

## 未完成与禁止推断

CI 依用户要求跳过，不重试，也不修改账户或 workflow。平台身份到信号的原子安全、POSIX orphan 恢复与严格 `killed: 1`、Windows Job 恢复、真实 daemon 崩溃 lane、旧实现迁移、native 打包/签名、完整 V6a 和准确 head Shipping 均未完成。保留严格预期，不采用 unsafe fallback。

PR121 的 `bf1c39ebfe20fea0e8de64f92fd0efbaf91a2e92` 仍有技术阻断且未批准，不得按它实现或接受风险。

## 本机详细证据

原 Mac 仓库为 `/Users/clay/develop/src/github.com/ClayCheung/vonvon-bot`。本地 `.audit/STOP-current.md` 与 `.audit/continuation-20261012/new-provider-plan/mac-execution-resume/` 保存停止收据、准确冻结快照、原始失败和检查日志。主要子目录为 `processhost-pipe-obligation-attempt1`、`processhost-pipe-typecheck-followup1`、`macos-identity-reader-attempt1`、`bounded-stop-20261012`。这些详细本地证据未随 Git 分发；没有原据时，不声称已完成新机器或新 head 的验证。

保留日常 Bridge、用户文件、原 QUARANTINED 证据及旧租约。重新开始时先核对 Git/源码归属和运行资源，再选择所需最小差异检查。Import 仍需测试与独立审查；任何架构、数据形状或验收变更按 AGENTS.md 交回原设计方及用户。
