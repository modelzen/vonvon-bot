# Codex 安装来源、更新与模型刷新

## 做什么与范围

owner 2026-10-30 要求先实现 Codex，Claude 留待后续参考。解决用户升级 CLI 后被旧托管程序遮挡、无法找到更新及模型刷新入口的问题。覆盖 macOS、Windows；不更新外部安装，不改认证、路由或 Claude SDK，不发布版本。

## 现有代码

`locate.ts` 原来先选托管再查 PATH / App；`managed-install.ts` 固定 0.156.1 并写旧指针，`environment/service.ts` 已有安装最新版的新代际流程。模型从原生 `model/list` 读取；读取和执行需要使用同一程序。utility 原来只比较路径，无法发现原地升级。

## 怎么改

- `refreshCodexResolution` 异步探测，四路并发、三秒单项超时，按上下文及指纹合并在途请求。显式路径优先；自动选满足最低版本的较新程序，同一版本优先正式版（App 自带 CLI 可能带预发布后缀）。同步 resolver 不启动子进程。探测 App、Homebrew、nvm、Windows PATH/PATHEXT、npm 与官方用户目录。失败候选不替代成功候选。
- setup / doctor / 模型查询 / start / resume 使用同一选择；start / resume 将确定路径传给权限参数读取与进程创建，避免 supervisor 和 Bot 子进程缓存不同。
- 旧安装 API 转发 `EnvironmentService`，沿用代际目录、校验、原子指针与取消；保留旧入口的可信 npm 要求。已发布成功不被迟到取消覆盖。已暴露目录保留，避免误删并发进程可能读取的程序。
- utility 创建前记录指纹；换版后新请求用新进程，旧进程等在途请求结束才关闭。Bot 已有空闲释放机制使当前任务完成后释放旧线程，下轮按原 session ID 用新版本恢复。
- Provider 显示实际来源、路径、版本及更新说明；托管可更新，外部引导原安装方式。模型失败刷新保留旧列表并标过期，过期不能作为完成准备的依据。Claude 原机制不变。

## 测试

覆盖旧 / 新托管与外部版本竞争、正式版与预发布、显式覆盖、原地升级、失败超时重试、并发合并、平台路径；共享安装入口、取消及迟到取消；utility 在途请求与活跃线程换版；Provider 成功与失败刷新、更新入口及外部不重复安装。Windows CI 和发布构建专项清单同步补充回归。

## 自测与验收

隔离 HOME / VONVON_HOME 启动内建网页端，用协议 fixture 检查管理页和模型刷新。真实本机 CLI / App 只读版本，不使用 owner 的 Bot、数据或安装。自动化和页面证据随 PR 记录；Windows 真机、真实账号新增模型推理仍单独说明，不能用 fixture 代替。

## 文档、风险和验收要点

产品约定见 `docs/product.md` 3.11；后续 Claude 参考见本轮 research。重点审查取消、并发切换与错误恢复；确认无任务被强制关闭、无真实账号或密钥入 diff。实现大小控制在 1500 行以内。
