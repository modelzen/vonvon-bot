# 账号与配方里程碑

2026-11-14。沿用 Vonvon 账号、Supabase Auth 与自有社区，首版不做飞书登录。会员、租赁与账号下多设备托管不在本轮范围；产品行为仍以 [PRD](prd.md) 为准。

本页是执行索引。**实现、自动化测试、真实端到端验收分别记录；达到验收门槛才关闭 M。** 当前产品候选为 `1ebe22f225be85b88c10ffcccc67b0cb917387ee`，已部署到隔离公网测试站 `https://recipes-staging.vonvon.cc`。本批尚未合入 `dev`、提升 `main` 或发布正式产品。

最新工作回到 M3 的体验恢复。owner 已拒绝签名 Preview v5 的草稿、搜索及来源选择交互，不能按旧自动化结果交验。紧凑搜索和移除手动创作的本地组件检查已完成；App 直接保存发布信息、概览内编辑和私聊内容选择正在实现。具体状态见[实现状态](implementation-status.md)。下表中的 v3/v4 证据保留其当时边界，不代表新流程已通过。

## 当前里程碑

| M | 交付 | 当前状态 | 关闭门槛 |
| --- | --- | --- | --- |
| M1 | 账号与登录 | 公网真实 GitHub 登录已通；v3 处理钥匙串本人授权后，正常显示、账号恢复、设置入口、退出重登及已获取配置读取已验 | 继续按原生计划核对尚未完成的取消等场景；只展示环境已启用的提供方 |
| M2 | 配方资源、版本与权益 | 完整配置、文件、Logo、授权和码已有实现；真实托管 HTTP/Storage 已部分验证 | 最终部署环境的内容隔离、版本、限额、Logo 沙箱及备份恢复 |
| M3 | 本地创作与发布 | 签名 v4 与配对测试设备使用真实 GitHub 作者，飞书确认后保存同一 rich 草稿修订 1；首次上传时限冲突已修复并更新 staging；fresh App 公共字段聊天续编入口正在补齐 | 真实纯文本改同稿、App 发布、出新版和撤下；取消/旧确认不误发布 |
| M4 | 领取、安装与更新 | 公网真实登录领取已通；v3 已获取详情、分享复制及添加到群聊的既有 Bot 选择器入口已验，空 Bot 时不能下一步 | 真实第二账号获取后在专用 Bot/群完成安装；更新、忽略、冲突与恢复均核对落盘 |
| M5 | 公网与整批交付 | M5.1 隔离部署及沙箱已通过；M5.2 匿名飞书开链→登录回原版连续链已通；首次新码兑换为此前独立证据；M5.3 未完成 | 完成整批检查及 owner 验收；之后按规则合入 `dev` |

## 切片与依赖

| 片 | 职责与依赖 | 实现/证据 | 下一步 |
| --- | --- | --- | --- |
| M1.1 | 业务账号与身份映射；无前置 | [PR 763](https://github.com/modelzen/vonvon-bot/pull/763) 已合功能集成分支；SQL 验迁移、停用与并发 | 随最终身份联调核对归属 |
| M1.2 | 原生会话、中转、头像、账号入口；依赖 M1.1 | [PR 764](https://github.com/modelzen/vonvon-bot/pull/764)–[767](https://github.com/modelzen/vonvon-bot/pull/767) 已合；SDK/IPC 与合成上游回归；v2/v3 真实原生 GitHub 登录与 Web 同账号库已验。v3 已通过账号恢复、设置账号页、退出重登与权益读取 | 按[原生计划](../../plans/accounts-native-login.md)补齐未完成场景，不等同于真实创作/安装全链通过 |
| M1.3 | 固定版本网页登录续领；依赖 M1.1、M2.1/2.2 | `1296ad49` 续领修复有 55 个普通、2 个 PostgreSQL rich 回归及独立审查；当前 `1ebe22f2` 公网真实 GitHub 登录回同版、账号库重开已通，[记录](login-return.md) | 在后续创作/安装验收中继续复用该公网入口 |
| M2.1 | 不可变版本、领取权、码与回执；依赖 M1.1 | [PR 761](https://github.com/modelzen/vonvon-bot/pull/761)、[777](https://github.com/modelzen/vonvon-bot/pull/777) 已合；SQL/HTTP 验并发、重试及错版本 | 公网两账号核对发码/兑换记录 |
| M2.2 | rich-v2 契约与跨代兼容；无运行前置 | [PR 779](https://github.com/modelzen/vonvon-bot/pull/779)、[780](https://github.com/modelzen/vonvon-bot/pull/780) 已合；契约/构建回归 | 最终客户端/服务端组合检查 |
| M2.3 | 私有资产、Logo、完整云端交付；依赖 M1.1、M2.2 | [PR 778](https://github.com/modelzen/vonvon-bot/pull/778)、[782](https://github.com/modelzen/vonvon-bot/pull/782)、[783](https://github.com/modelzen/vonvon-bot/pull/783) 已合；本地另有沙箱/边界修复；真实 staging HTTP/Storage 及 Linux 服务单元沙箱已验 | 补备份恢复演练及最终客户端组合检查 |
| M3.1 | 云草稿登记、确认与恢复；依赖 M1.1 | [PR 769](https://github.com/modelzen/vonvon-bot/pull/769) 已合；并发、取消与回执回归 | 供 M3.3 串联 |
| M3.2 | 本机取源、私聊与同稿编辑；依赖 M3.1、M2.2 | [PR 773](https://github.com/modelzen/vonvon-bot/pull/773)、[781](https://github.com/modelzen/vonvon-bot/pull/781) 及本地 rich 修复；真实 GitHub 作者在配对测试设备已关联本人私聊，经真实确认保存同一草稿修订 1，完整 skill 和所选参考资料已读回；014 修补首次上传时限已部署 | 补 fresh App 公共字段选择并真实聊天改同 UUID 到修订 2；不把到期卡的暂停响应或 App 预填当成模型改稿通过 |
| M3.3 | App 审核、发布与版本管理；依赖 M1.2、M2.3、M3.2 | [PR 770](https://github.com/modelzen/vonvon-bot/pull/770)、[775](https://github.com/modelzen/vonvon-bot/pull/775) 及本地 rich Main/UI；托管 API 发布走过 | 真实 Bot 草稿审核→发布→出新版→撤下，验证取消与旧版 |
| M4.1 | 设备范围内安装授权/恢复；依赖 M1.1、M2.1 | [PR 768](https://github.com/modelzen/vonvon-bot/pull/768) 已合；SQL 仲裁与证明回归 | 最终真实账号/设备交接 |
| M4.2 | daemon/Main 安装、原入群与旧群兼容；依赖 M1.2、M4.1 | [PR 771](https://github.com/modelzen/vonvon-bot/pull/771)、[772](https://github.com/modelzen/vonvon-bot/pull/772)、[774](https://github.com/modelzen/vonvon-bot/pull/774)、[776](https://github.com/modelzen/vonvon-bot/pull/776) 已合；v3 进入既有 Bot 选择器、零 Bot 时下一步禁用、关闭回详情已验 | 以 M3.3 的真实版本测建群、Bot 已在群中及失败恢复；入口验收不代表已安装 |
| M4.3 | 完整配置、技能、任务与更新/忽略；依赖 M2.2/2.3、M4.2 | 已整合 rich runtime/UI、任务时区、来源选择及 legacy 安装兼容修复；setup 改为普通 skill，无独立准备状态；新增提交仍需整理进远端集成分支 | 真实安装时核对普通 skill、双 Bot 隔离、任务默认暂停、新版忽略与冲突；legacy 字段仅作只读兼容说明 |
| M5.1 | 部署包与隔离单元；依赖 M2.3，可与 M3/M4 并行 | **已通过**。固定 `1ebe22f2` 已部署，四个 staging 单元 active、未启用开机启动；真实单元沙箱策略已验。API/Broker 的 staging 写入已显式开启供后续发布验收 | 保留源码、包、单元策略及回滚证据，供 M3/M4 使用 |
| M5.2 | 公网域名、TLS、登录回程与飞书打开；依赖 M1.3、M5.1 | 浏览器退出后，从真实飞书客户端点既有公网链接→匿名介绍→获取→GitHub 登录→同一固定版本与完整六页签连续通过；该账号此前已获取，本次未兑换新码。首次新码兑换来自早先 e450 公网直达证据；未测内置 WebView | 保留当前公网入口供 M3/M4 和最终 owner 验收；不把分开的首次兑换证据写成同一次连续链 |
| M5.3 | 整批回归、验收与 `dev` 集成；依赖 M1–M4、M5.2 | 最终整批验收未完成；owner 要求反馈配方与账号/社区同批交验 | 加入可信提交人 USER 授权、聊天确认、原生 Base 记录回链及第二用户隔离；整理补丁审查证据，统一跑必要 CI，owner 验收后合入 |

## 并行调度

- M5.1 已通过，M5.2 匿名飞书开链登录回原版连续复验已通过。当前关键路径回到 M3.2→M3.3 的真实改稿/发布，再串联 M4 的安装、更新和忽略。
- v4 已使用固定路径和现有证书签名，钥匙串本人授权后真实 GitHub 登录、头像和空 Bot 引导已验。重新核对资源并取得本线程锁后，exact `1ebe22f2` 的隔离 `test-home` daemon 仅一份连接 Bot 1/2；Preview 通过原有配对使用它，真实作者已保存自己的草稿修订 1。不能把旧 fixture A 草稿、旧卡或旧本地 API 源码当成本轮结果。
- 同一组真实 Bot、测试群、daemon/Main journal 只交给一名验收者。M3.3 确定发布回执后，再用同版串到 M4.2/4.3。浏览器、桌面打包与服务器变更由集成负责人调度。
- 各片明确文件/模块 owner，先固定接口。实现者本地测试后，由不同模型独立审查。片 PR 进入功能集成分支时不逐片跑重 CI，最后按累积差异统一检查。合入功能集成分支、合入 `dev` 和公开发布分别报告。

本地 rich 补丁多于远端已合切片，不能按 PR 数量估算完成百分比。每次更新记录确切源码、测试类型及剩余门槛。
