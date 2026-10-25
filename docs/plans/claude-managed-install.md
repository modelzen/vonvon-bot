# Claude 恢复用户选择后的托管安装

## 做什么

owner 2026-10-25 明确要求 Claude 不打进 App；用户选择后托管安装。执行 product.md 3.11。本次以 dev 为基线，保留 Provider 检测失败与未安装的区别。

## 范围与现在的代码

移除 desktop/build.mjs 的 SDK staging、universal 双架构 Claude 下载和原生文件例外；移除 backend-loader/admin/protocol 的 bundled 标记及 ProviderSetup 的内置组件分支。保留现有 npm 托管安装器、固定 SDK 版本、可取消安装、更新、卸载，以及独立 Claude Code CLI 管理。compact 依赖去重和现有字体、语言、语音资源不变。

## 怎么改

1. 桌面只暂存 daemon 的生产依赖，SDK 留在 devDependencies，dist 保留动态 import。
2. build、afterPack 和 universal 验证共同检查：元数据不能声明内置 Claude，资源树不能携带 SDK、平台运行包或 Claude Code 包。旧 staging 也拒绝打包。
3. catalog 与界面恢复缺失时安装入口，用户点击后才进入原安装队列。读取状态、刷新与启动不安装。
4. 更新和卸载仍限制到用户托管目录；显式卸载使用 npm 回收原生运行包及独占依赖，保留共享依赖、其他后端和登录数据。保留加载错误分类和实际版本解析。
5. universal 所有 Mach-O 恢复双架构验证，不降低签名与 entitlements 门槛。
6. SDK 的模块由运行进程缓存；管理页明确提示更新或重装后手动重启后台服务以加载新版本，不自动中断运行任务。

## 测试

- 当前 dev 必败：存在本地 SDK 开发依赖时，桌面 stage 和 App 不含 Claude；旧 stage 中的嵌套 SDK/原生包必须拒绝。
- 当前 dev 必败：Provider 不再使用 bundled 字段绕过 SDK 安装或禁用管理操作。
- 回归：缺失 SDK 的读取/重新检测不安装；明确点击才调用安装；安装、更新固定版本、卸载后恢复缺失；检测异常只提供重新检测。
- 回归：签名、双架构、产品版本和第三方声明检查保持有效。
- 真实离线 npm 依赖树：卸载回收 hoisted 原生/独占依赖，保留另一后端及共享依赖、账号文件和 lockfile；失败及子进程结束顺序不破坏串行队列。

## Mac 自测

完整构建、typecheck、打包/后端/Provider 定向测试。对实际 arm64 App 统计体积、检查无 Claude 文件；移出仓库后在隔离 HOME/VONVON_HOME/userData 启动，使用 Codex 自带浏览器检查未安装与明确安装交互。托管 SDK 安装/更新/卸载只作用于本轮临时目录；不注册 Bot、不发飞书消息、不更换 owner 运行的 App。签名使用已有身份。

## 文档与验收

更新 product.md 3.11、迁移说明、DISTRIBUTION.md、v1-plan.md 和体积报告。验收要点：基础 App 不含 Claude；用户主动安装后才增加托管组件；已有用户数据及登录不受改动影响；检测失败不伪装为未安装；提交不含真实 id、密钥或本机绝对路径。

## 风险和行数

涉及打包、动态依赖解析和安装入口，预计 800 行以内。用户此前仅依赖内置 SDK 时，更新后需要主动安装；不自动后台迁移下载。独立 CLI 安装与 SDK 安装继续明确区分。真实账号调用和物理 Intel 验收单独记录，不由模拟测试代替。
