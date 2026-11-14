# 账号与配方里程碑

2026-11-14。沿用 Vonvon 账号、Supabase Auth 与自有社区，首版不做飞书登录。会员、租赁与账号下多设备托管不在本轮范围；产品行为仍以 [PRD](prd.md) 为准。

本页是执行索引。**实现、自动化测试、真实端到端验收分别记录；达到验收门槛才关闭 M。** 本批尚未合入 `dev`、提升 `main` 或公开发布。

## 当前里程碑

| M | 交付 | 当前状态 | 关闭门槛 |
| --- | --- | --- | --- |
| M1 | 账号与登录 | 账号与原生登录已有集成切片；真实 GitHub 网页登录已通 | 真实桌面登录、取消、退出、重登与权益恢复；只展示环境已启用的提供方 |
| M2 | 配方资源、版本与权益 | 完整配置、文件、Logo、授权和码已有实现；真实托管 HTTP/Storage 已部分验证 | 最终部署环境的内容隔离、版本、限额、Logo 沙箱及备份恢复 |
| M3 | 本地创作与发布 | 私聊/云草稿/Main/UI 已实现；真实私聊保存完整私人草稿到修订 1 | 同一草稿改到修订 2，经 App 发布、出新版和撤下；取消/旧确认不误发布 |
| M4 | 领取、安装与更新 | 网页真实登录领取已通；原入群、安装与更新有切片及本地回归 | 真实第二账号获取后在专用 Bot/群安装；更新、忽略、冲突与恢复均核对落盘 |
| M5 | 公网与整批交付 | 部署包、服务器/域名检查与入口验收正在并行 | 公网飞书入口、登录回程、整批检查及 owner 验收；之后按规则合入 `dev` |

## 切片与依赖

| 片 | 职责与依赖 | 实现/证据 | 下一步 |
| --- | --- | --- | --- |
| M1.1 | 业务账号与身份映射；无前置 | [PR 763](https://github.com/modelzen/vonvon-bot/pull/763) 已合功能集成分支；SQL 验迁移、停用与并发 | 随最终身份联调核对归属 |
| M1.2 | 原生会话、中转、头像、账号入口；依赖 M1.1 | [PR 764](https://github.com/modelzen/vonvon-bot/pull/764)–[767](https://github.com/modelzen/vonvon-bot/pull/767) 已合；SDK/IPC 与合成上游回归 | 按[原生计划](../../plans/accounts-native-login.md)做真实 Electron 全流程 |
| M1.3 | 固定版本网页登录续领；依赖 M1.1、M2.1/2.2 | 本地 `1296ad49`；55 个普通、2 个 PostgreSQL rich 回归及独立审查通过；真实 GitHub/Supabase 浏览器领取已通，[记录](login-return.md) | 与 M5.2 一起验公网及飞书入口 |
| M2.1 | 不可变版本、领取权、码与回执；依赖 M1.1 | [PR 761](https://github.com/modelzen/vonvon-bot/pull/761)、[777](https://github.com/modelzen/vonvon-bot/pull/777) 已合；SQL/HTTP 验并发、重试及错版本 | 公网两账号核对发码/兑换记录 |
| M2.2 | rich-v2 契约与跨代兼容；无运行前置 | [PR 779](https://github.com/modelzen/vonvon-bot/pull/779)、[780](https://github.com/modelzen/vonvon-bot/pull/780) 已合；契约/构建回归 | 最终客户端/服务端组合检查 |
| M2.3 | 私有资产、Logo、完整云端交付；依赖 M1.1、M2.2 | [PR 778](https://github.com/modelzen/vonvon-bot/pull/778)、[782](https://github.com/modelzen/vonvon-bot/pull/782)、[783](https://github.com/modelzen/vonvon-bot/pull/783) 已合；本地另有沙箱/边界修复；真实 staging HTTP/Storage 有验收 | M5.1 实际 Linux 服务单元下验沙箱，补恢复演练 |
| M3.1 | 云草稿登记、确认与恢复；依赖 M1.1 | [PR 769](https://github.com/modelzen/vonvon-bot/pull/769) 已合；并发、取消与回执回归 | 供 M3.3 串联 |
| M3.2 | 本机取源、私聊与同稿编辑；依赖 M3.1、M2.2 | [PR 773](https://github.com/modelzen/vonvon-bot/pull/773)、[781](https://github.com/modelzen/vonvon-bot/pull/781) 及本地 rich 修复；真实关联、卡片/回调和私人草稿有检查点 | 继续原草稿改稿，核对同 UUID 修订增长，不重放旧卡 |
| M3.3 | App 审核、发布与版本管理；依赖 M1.2、M2.3、M3.2 | [PR 770](https://github.com/modelzen/vonvon-bot/pull/770)、[775](https://github.com/modelzen/vonvon-bot/pull/775) 及本地 rich Main/UI；托管 API 发布走过 | 真实 Bot 草稿审核→发布→出新版→撤下，验证取消与旧版 |
| M4.1 | 设备范围内安装授权/恢复；依赖 M1.1、M2.1 | [PR 768](https://github.com/modelzen/vonvon-bot/pull/768) 已合；SQL 仲裁与证明回归 | 最终真实账号/设备交接 |
| M4.2 | daemon/Main 安装、原入群与旧群兼容；依赖 M1.2、M4.1 | [PR 771](https://github.com/modelzen/vonvon-bot/pull/771)、[772](https://github.com/modelzen/vonvon-bot/pull/772)、[774](https://github.com/modelzen/vonvon-bot/pull/774)、[776](https://github.com/modelzen/vonvon-bot/pull/776) 已合 | 以 M3.3 的真实版本测建群、Bot 已在群中及失败恢复 |
| M4.3 | 完整配置、setup、任务与更新/忽略；依赖 M2.2/2.3、M4.2 | 本地 delivery 已整合 rich runtime/UI、任务时区与来源选择修复；新增提交仍需整理进远端集成分支 | 双 Bot 隔离、任务默认暂停、setup 确认、新版忽略与冲突 |
| M5.1 | 部署包与隔离单元；依赖 M2.3，可与 M3/M4 并行 | 已有腾讯云 staging 方案/helper；本轮适配最终 Web 包和认证配置中 | 固定源码/包哈希后部署，验证单元策略及已有服务基线 |
| M5.2 | 公网域名、TLS、登录回程与飞书打开；依赖 M1.3、M5.1 | 本机真实浏览器通过；飞书消息已发/读回；公网/内置 WebView 未验 | 公网点击→登录→同版续领，核对取消与重开 |
| M5.3 | 整批回归、验收与 `dev` 集成；依赖 M1–M4、M5.2 | 最终整批验收未完成 | 整理补丁审查证据，统一跑必要 CI，owner 验收后合入 |

## 并行调度

- 当前关键路径是 M5.1 的部署包/单元与域名准备并行，汇合后做 M5.2；M1.3 的本机回归已经完成。
- M3.2→M3.3 的真实改稿/发布可与服务器准备并行；M4 的审查、场景准备和不占 Bot 的回归可同时推进。
- 同一组真实 Bot、测试群、daemon/Main journal 只交给一名验收者。M3.3 确定发布回执后，再用同版串到 M4.2/4.3。浏览器、桌面打包与服务器变更由集成负责人调度。
- 各片明确文件/模块 owner，先固定接口。实现者本地测试后，由不同模型独立审查。片 PR 进入功能集成分支时不逐片跑重 CI，最后按累积差异统一检查。合入功能集成分支、合入 `dev` 和公开发布分别报告。

本地 rich 补丁多于远端已合切片，不能按 PR 数量估算完成百分比。每次更新记录确切源码、测试类型及剩余门槛。
