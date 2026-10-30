# 发布提速的小实验

2026-10-30，owner 要求基于历史发布耗时落实优化。以 0.7.8 的 main 源码为基线；实验只读公网或使用隔离夹具，不进行真实公证、COS 写入或产品安装。

## 网络

同一个 [GitHub CLI 官方 ZIP](https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_macOS_arm64.zip)，两条路径均只取前 2 MiB，均返回 HTTP 206、2,097,152 字节，SHA-256 相同。

| 路径 | 时间 | 吞吐 |
|---|---:|---:|
| 直连 | 1.836 秒 | 1.14 MB/s |
| 自动继承既有系统 HTTP(S) 代理 | 0.864 秒 | 2.43 MB/s |

该样本约 2.13 倍，证明默认代理解析可用；不能外推完整 614 MB Windows 包、其他时段或 Apple 上传的固定收益。没有更改系统代理或 TLS。

## 调度与完整性

两段各 50 ms Mac 等待与一次 80 ms Windows 下载，原串行模拟约 183 ms，提前下载约 117 ms。异步屏障同时验证下载在 Mac helper 返回前开始，不仅依赖墙钟比较。恢复、取消和失败另有断言；真实进程组测试确认忽略 SIGTERM 的孙进程也退出。

公网 ZIP/DMG 测试记录最大同时流数为 2，完整 SHA-256 与响应头校验保留；一个失败也等另一流结束才返回。统一发布器测试验证 Mac/Windows 上传确实重叠、失败保留独立回执、篡改计划/配置/来源拒绝、已发布候选不重复写 manifest。

## Linux CI 并发

另取 4 个真实子进程测试文件（owned-process-term、codex-process-tree、provider/holder-process、provider/process-host），每轮独立临时 HOME/VONVON_HOME，CI=true；两轮均 61 例，56 通过、5 平台跳过、0 失败。1 worker 用时 24.713 秒，2 workers 12.088 秒，约 2.04 倍。Mac 小样本只证明这组测试可以重叠，双核 Linux 的稳定性由完整 CI 继续验证；保留最多 4 个的上限，Windows CI 仍单 worker。

真实验证：[完整 CI 运行](https://github.com/modelzen/vonvon-bot/actions/runs/40986572595)，源码 `b6bbad03bf3642386aec3bea31fbe5239d7472d0`，Linux 和自托管 macOS 都成功。Linux 完整 job 8 分 53 秒，测试步骤 7 分 06 秒；daemon 400 个文件通过、10 个文件跳过，耗时 376.92 秒。历史 0.7.8 的相同 daemon 文件数与跳过数耗时约 811 秒，完整 Linux job 17 分 28 秒；两轮并非同一台机器上的严格 A/B，负载可能影响耗时。没有削减测试或放宽超时。此手动性能验证不代替 PR 自己的 CI gate。

## 下一次发布

仍需在下一次获准发版观察完整 Windows 下载、四次 Apple 上传和端到端耗时。目标是减少关键路径中的独立传输与人工交接；本次不声称完成正式签名、公证、上传或真实客户端升级验收。
