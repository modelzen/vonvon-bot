# 查看 CI 触发条件与费用

> 2026-10-14 起，v1 只支持 macOS，CI 去掉了 Windows 任务，只剩 Linux 和自托管 Mac 两个平台。下文涉及 Windows 的触发条件和费用是历史记录。

## 何时运行

两个仓库的主线 CI 都由目标为 `main` 的 PR 创建、更新提交或重新打开触发，也可在 Actions 页面手动运行。vonvon-bot 还在 PR 添加标签时触发。每次 PR 事件都在 Linux 上运行范围分类、分类回归测试和改动空白检查。`full` 范围只有在 PR 带 `frozen` 标签或手动触发时才运行完整平台链；未冻结时 Linux 报告完整检查待运行并使必需检查失败，防止轻量运行被视为完整通过。纯文档 PR 即使带 `frozen` 标签也只运行轻量检查。没有普通分支 push、合入后的 main push 或定时 CI。同一 PR 的新运行取消旧运行，添加标签触发的运行也一样。已执行的云端时间仍计入使用量。

给 PR 添加任何标签，CI 都按 PR 当时的全部标签重新判断，检查名称始终是 `linux` 和 `macOS checks`。PR 已带 `frozen` 时，再加别的标签会取消正在跑的完整运行，从头再跑一遍完整平台链，多花一次运行时间。未冻结的 `full` PR 加别的标签，Linux 必需检查照常失败。去掉 `frozen` 之后再有任何标签事件，同一个 head 上通过的 `linux` 也会被新的失败结果盖住，重新打 `frozen` 就能恢复。添加 `frozen` 标签、带该标签的 PR 创建、更新提交或重新打开时，`full` 范围运行完整平台链。

2026-10-14 之前，其他标签事件用 `informational linux` 等单独的名称和并发组运行，为的是不打断正式运行。但它生成的检查组比正式运行新，盖住了已经通过的 `linux`，合入规则因此报 "Required status check linux is expected"，#289（调研归档）就遇到过。现在改成同名重跑。`linux` 任务不能加任务级的 `if:`：名称固定的任务被跳过时，GitHub 把它算作通过，未冻结的 PR 就能绕过必需检查。

| 改动或操作 | Notelet | vonvon-bot |
| --- | --- | --- |
| 纯文档 PR，包括带 `frozen` 标签 | Linux 范围与空白检查 | Linux 范围、分类回归与空白检查；Mac 跳过 |
| 纯静态网站 PR | Linux 范围、空白与部署语法检查 | 不适用 |
| 产品代码、依赖、CI 或未知路径 | 完整 Linux，成功后运行专用 Mac | 带 `frozen` 标签或手动触发：完整 Linux，成功后运行专用 Mac。未冻结 PR 只运行分类回归、范围与空白检查，Linux 必需检查失败并报告完整检查待运行 |
| 手动运行 main CI | 完整 Linux 与专用 Mac | 完整 Linux 与专用 Mac |
| fork PR | Linux；自托管 Mac 跳过 | 未冻结时只运行 Linux 轻量检查；冻结且为 `full` 范围时只运行完整 Linux，自托管 Mac 跳过 |

手动运行前确认 ref 受信任。两个平台检出的源提交都须与事件的 PR head SHA 或手动运行 SHA 一致。自托管 Mac 还要求 `ENABLE_SELF_HOSTED_MACOS_CI=true`，`ci-user` 保持图形登录且 runner 在线。云端 Linux 失败时，后续 Mac 不启动。Mac 离线时对应 job 排队等待，不能把它记为通过。

未冻结的 `full` PR 会完成轻量检查，但 Linux 必需检查随后失败，直到冻结 head 或手动运行产生完整证据。事件 JSON 无效、提交信息缺失或差异收集失败也使 Linux 检查失败，不会产生可用于合入的通过结果。

这里描述当前 main 的 `ci.yml`。旧桌面分支的 `desktop.yml` 是另一条工作流，仍有 Windows 原生检查和打包；其迁移记录见 [issue 58](https://github.com/modelzen/vonvon-bot/issues/58)。主线 Node 检查不能替代原生安装、交互与服务验收。

## 估算一次运行的费用

2026-10-11 核对的标准 runner 单价如下。免费额度未用完时，实际扣款可以为零。

| runner | 超出免费额度的单价 |
| --- | --- |
| GitHub 托管 Linux x64 | $0.006 每分钟 |
| GitHub 托管 Windows x64 | $0.010 每分钟 |
| 本机自托管 macOS | GitHub Actions 使用费 $0，电费与机器成本自理 |

GitHub 对每个 job 的部分分钟向上取整，然后计算费用。计算时使用各 job 的执行时长，不把排队和整个工作流的墙钟时间当作计费时长。

- Notelet 完整一次约为 `ceil(Linux 秒数 / 60) × $0.006`。
- vonvon-bot 完整一次约为 `ceil(Linux 秒数 / 60) × $0.006`，自托管 Mac 不计费。2026-10-14 之前还要加 `ceil(Windows 秒数 / 60) × $0.010`。
- 例如 Linux 用 5 分钟，名义费用为 `$0.030`。
- 文档的 Linux job 即使只用数秒，按 1 分钟估算也为 `$0.006`；跳过的 Mac 不产生云端计算费用。

重新运行和失败前已执行的部分也消耗额度。计算费估算不包括已有构建产物、超额缓存或 Packages 的存储费用。当前 main CI 没有新增 artifact 上传。

在组织 **Settings → Billing & licensing → Usage** 查看 gross、discount 和 net；`net` 才是扣除免费额度后的费用。账单可能晚于 Actions 运行记录更新，因此不能把一次执行时长估算当作已出账金额。

## 到 V11 的预算估算

这一节是 2026-10-12 的历史估算，当时还有 Windows 任务，V1 到 V11 的计划也已在 2026-10-14 停止执行。2026-10-12 按最近成功运行的实际时长估算。一次完整运行 Linux 约 5 分钟、Windows 约 10 分钟、Mac 约 2 分钟（自托管，不计费）。

| 项目 | 数值 |
| --- | --- |
| 一次完整运行的名义费用 | 5 × $0.006 + 10 × $0.010 ≈ $0.13 |
| 一次完整运行占用的免费分钟（Windows 按 2 倍计） | 5 + 20 = 25 分钟 |
| Team 套餐每月免费分钟 | 3000 分钟，约 120 次完整运行 |
| 剩余 PR 数（V5 到 V11 共 12 个，若 V5 拆分为 13 个，加两个工具 PR） | 约 14 个 |
| 按冻结 head 触发，每个 PR 估 3 次完整运行 | 约 42 次，名义 ≈ $5.5，占免费分钟约 1050 |
| 文档 PR，每次约 1 分钟 Linux | 60 次 ≈ $0.36 |
| Windows 超时（20 分钟上限）和重跑的余量，按两倍计 | 合计名义 ≈ $12 |

这次开发到 V11 的云端 CI 名义费用在 $12 左右，分摊到两个月以上时大部分落在每月 3000 免费分钟之内，净费用接近零。建议 spending limit 设为每月 $20。2026-10-12 的运行失败注释同时提到付款失败和 spending limit，所以先在组织 Billing 页面确认付款方式，再设上限。历史上每次 push 都跑完整运行时，V5 分支一个 PR 跑了 9 次，改为冻结 head 触发后每个 PR 降到 1 到 3 次。

价格可能变化，重算时查看 GitHub 的 [runner 单价与分钟取整规则](https://docs.github.com/en/billing/reference/actions-runner-pricing) 和 [免费额度、自托管及存储计费规则](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
