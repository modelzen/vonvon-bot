# 双平台发布编排

## 做什么与范围

owner 要缩短每次发布的人工编排。固定一个版本和准确 main SHA，一次命令调度 Windows 并串行运行两个 Mac helper，保存状态供查询、恢复与官网回执交接。只改发布脚本、工作流和文档，不改产品版本或产品代码，不接管本次已开始的手工候选。

## 现有代码与实现

`release-mac.mjs` 负责版本门禁、签名、公证和产物；`assemble-split-release.mjs` 负责聚合验证；`publish-windows.mjs` 负责下载来源与公开验证；`release-cos-publish.mjs` 负责计划、版本化上传及独立的 stable 关口。新增 `release-all.mjs` 仅编排这些 helper：同一锁保护初始化和 dispatch 决策，先持久化请求 UUID，网络结果不明时不重复派发；两架构共享 stage，必须串行。保留 partial output 和原有公证恢复行为。

Windows workflow 增加固定源码/版本/请求输入；下载器分别绑定源码和 workflow SHA，保持仓库、工作流、成功状态、main ancestry 和 artifact 哈希校验。runner 预检同时读 repository 和 organization，并核对 runner group 仓库权限及全部标签。状态列出 CI、Windows 和 Apple 等待，以及已有步骤耗时。

## 测试与验收

Mac 仅跑脚本 mock/unit 测试：旧版本拒绝、输入不可变、组织继承 runner、真实并发初始化/构建、丢失响应不重复调度、Mac 串行、同一候选恢复、取消、Windows 失败不能混过、两平台公开回执不一致拒绝。现有 macOS/Windows helper 定向回归。不要发飞书消息，不运行真实构建、公证、CI 或 COS 写入。验收检查 diff 无真实身份、密钥或本机路径。

## 文档、风险与边界

用法与恢复在 `docs/release-orchestration.md`，README 链入；stable 保留 skill 的证据展示与 owner 本人最终确认，无新自动发布入口。涉及子进程、并发和发布门禁，需要独立审查。预计约 1,000 行；没有用户产品行为变化，不修改产品设计或 v1 功能完成度。
