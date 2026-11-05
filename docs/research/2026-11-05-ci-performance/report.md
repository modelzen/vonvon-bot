# CI 耗时与 worker 配置实测（2026-11-05）

## 结论与实施范围

只将 Windows CI 的 daemon 测试 worker 上限从 1 调整为 2，并用 `availableParallelism()` 保留单 CPU 环境的上限。Windows 本地、Linux 和 macOS 配置保持原行为。保留所有测试清单、断言、文件隔离和超时；不新增收费 runner。

同源码 Windows 专项两次候选均成功，相对单 worker 基线减少 47.7%–48.9% 耗时。Linux 的四 worker 候选有两项失败，拒绝采纳。上述百分比只针对 daemon 专项，不能外推为整轮 CI 提速比例。

## 历史样本与计时方法

从 `modelzen/vonvon-bot` 的 `ci.yml` 收集最近 100 条运行，范围为北京时间 2026-11-04 12:56:35 至 2026-11-05 22:13:09。快照包含 15 success、43 failure、41 cancelled、1 未完成。43 条 failure 中 42 条未执行平台作业，不等于 43 次产品测试失败。

15 条成功记录按 scope 日志拆分为 9 full、4 affected、2 docs。下表只比较 9 条 full，以平台 job 的 `completed_at - started_at` 计时；平台并行，不能相加。依赖安装和检查步骤分别按 step 时间计算。文档两次全程为 25/26 秒。

| full 平台（各 9 个样本） | job 中位秒数 | npm ci 中位秒数 | scoped checks 中位秒数 |
| --- | ---: | ---: | ---: |
| Linux | 1002 | 17 | 964 |
| Windows | 1055 | 39 | 991 |
| macOS | 458 | 34 | 369 |

历史全量例子：[41978340652](https://github.com/modelzen/vonvon-bot/actions/runs/41978340652)、[42038508401](https://github.com/modelzen/vonvon-bot/actions/runs/42038508401)。两例的 Windows daemon Vitest 为 695.63/699.07 秒；Linux 为 466.86/654.20 秒；macOS 为 253.44/253.99 秒。主要瓶颈是 daemon 测试，安装依赖占比较小。

`created_at → updated_at` 包括排队、取消和重跑。例如 [42036510442](https://github.com/modelzen/vonvon-bot/actions/runs/42036510442) 的累计 2526 秒包含三轮，末轮只重跑 Linux 和 gate。不能把它当作单轮 42 分钟执行。另有单次 scope 启动前约 304 秒的等待。

Bridge 最近三次成功的 Cross-platform CI 全程为 130/93/197 秒；Site 的 Actions 列表为空，本次没有可比较的 Site CI 历史。实施集中在 Bot。

## 固定源码对照实验

- 源码：`43cbd167ee396c33decf6818ebb681dc01f4ff4e`，实验定义提交 `cc4715aa`。
- [实验运行 42043587157](https://github.com/modelzen/vonvon-bot/actions/runs/42043587157)。实验 workflow 仅在独立实验分支上使用，不纳入本配置 PR。
- 所有 runner 报告 2 CPUs、Node v24.22.2；Windows 为 `windows-2025` x64、Linux 为 `ubuntu-latest` x64。
- 先 `npm ci` 和构建全部包，然后测量 daemon Vitest 命令总墙钟；候选只追加 `--maxWorkers`，测试选择不变。
- Windows 清单直接从该 SHA 的 `createPlan('full', packages)` 取得；Linux 跑 daemon 全部测试。各组是独立的新 runner，不能完全排除主机性能差异，因此 Windows 候选独立复跑一次，并与历史基线交叉检查。

| 组 | workers | 命令墙钟秒数 | 测试结果 |
| --- | ---: | ---: | --- |
| Windows 基线 | 1 | 686.917 | 22 文件通过；278 passed / 8 skipped |
| Windows 候选 | 2 | 351.147 | 22 文件通过；278 passed / 8 skipped |
| Windows 候选复跑 | 2 | 359.305 | 22 文件通过；278 passed / 8 skipped |
| Linux 基线 | 2 | 636.240 | 508 文件通过 / 12 skipped；8247 passed / 152 skipped |
| Linux 候选（拒绝） | 4 | 434.485 | 2 文件失败 / 506 passed / 12 skipped；2 tests failed |

Windows 两次减少 335.771/327.612 秒（48.88%/47.69%），无新增跳过。基线与历史 Windows 专项 695.63/699.07 秒接近。每组的 `benchmark-result.json`、完整测试日志在实验 artifacts 中，记录参数、源码、Node、CPU、退出码、signal 和统计。

Linux 四 worker 失败：`daemon-cli` 生命周期测试超过 20 秒；`secrets-get` 的非阻塞测试用时 1188.71 ms，违反 `<1000 ms` 断言。不能用放宽断言或超时来宣称优化成功；保留双核 Linux 原值。

## CI 总耗时的边界

Windows 专项节省约 5 分半，但整轮还取决于 Linux。9 个 full 中排除多轮重跑的 8 个单轮样本，假设 Windows 任意提速、其他平台完成时刻不变，整轮节省的上限中位数也只有约 69.5 秒；部分样本上限约 5 分半。因此正式 PR 仍执行准确 head 的原有全部选中检查，最终记录见 PR 的 checks；不把专项提速百分比宣传为 gate 提速百分比。

## 独立核实记录

- gpt-6-astra 独立复算历史 scope 分组、job/step 计时、重跑边界，并独立读取五组 artifacts：支持仅采纳 Windows 2 workers；拒绝 Linux 4 workers。
- gpt-6-sol 多角度检查 Windows 专项的临时目录、模块 registry、PID、命名管道、Job 对象和 afterEach 清理：未发现可成立的 P1/P2 并发冲突。正式配置仍需在最终 SHA 上通过完整 Windows CI。
