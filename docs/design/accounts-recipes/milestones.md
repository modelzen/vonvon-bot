# 账号与配方里程碑

2026-11-15。沿用 Vonvon 账号、Supabase Auth 与自有社区，首版不做飞书登录。会员、租赁与账号下多设备托管不在本轮范围。产品行为仍以 [PRD](prd.md) 为准。

本页是执行索引，实现、自动化检查和真实端到端验收分别记录。M1 至 M5 均未关闭。本批尚未合入 `dev`、提升 `main` 或发布到 stable。

当前签名 Preview、隔离 daemon 和[公网测试站](https://recipes-staging.vonvon.cc)实际运行 `4b72ae8879af5acab195e98100ef514425eae8af`。完整证据边界见[实现状态](implementation-status.md)。较早候选上的实测保留其当时源码，不能写成已在当前候选全部复验。

## 当前里程碑

| M | 交付 | 当前状态 | 尚缺的关闭门槛 |
| --- | --- | --- | --- |
| M1 | 账号与登录 | 真实 GitHub 登录、固定版本回程和 Web 到 Native 同账号库已验。`4b72ae88` 已验公开署名保存、恢复及与 OAuth 名称独立。v3 的钥匙串授权、恢复和退出重登保留当时边界 | 补齐[原生计划](../../plans/accounts-native-login.md)尚未完成的取消等场景，并核对最终客户端 |
| M2 | 配方资源、版本与权益 | 真实 HTTP、Storage、受限角色、凭码兑换及 `4b72ae88` 实际单元沙箱已验。撤下后新增获取受阻，既得账号下载和内容哈希已验 | 备份恢复、运营封禁、限额回收及最终组合检查仍未关闭 |
| M3 | 本地创作与发布 | 真实 GitHub 作者经飞书生成草稿，App 已发布反馈 v1 和凭码配方。`4b72ae88` 已验撤下确认与取消。出新版候选继承发布信息，但重连后恢复失败，v2 未保存或发表 | 完成原交接恢复修复的独立审查与真实复验，再验证同稿改稿、v2 发布、旧确认和旧版边界 |
| M4 | 领取、安装与更新 | 真实非作者经飞书开链、GitHub 登录和正确新码领取完整版本，已同步 Native。专用 Bot 在既有群与新群真实安装，角色和文件落盘及双 Bot 隔离已核对 | 真实更新、忽略、任务默认暂停、冲突与恢复仍待验 |
| M5 | 公网与整批交付 | M5.1 已在当前源码激活并验实际单元。M5.2 的系统浏览器连续领取链已验。反馈普通 setup 和真实问答已通，流式卡更新有 issue 784 | 本人 OAuth、聊天确认、原生 Base 提交回链和第二用户隔离未通。M5.3 的整批 CI、owner 验收及 `dev` 合入未完成 |

## 切片与依赖

以下 PR 只表示已进入功能集成分支，后续验收修复仍须整理。旧自动化结果只覆盖各片当时源码。

| 片 | 职责与依赖 | 实现与实测证据 | 下一步 |
| --- | --- | --- | --- |
| M1.1 | 业务账号与身份映射，无前置 | [PR 763](https://github.com/modelzen/vonvon-bot/pull/763) 已合。SQL 验迁移、停用与并发。真实作者、非作者和 fixture B 分别核对过归属 | 随最终身份与授权联调复核 |
| M1.2 | 原生会话、中转、头像、账号入口，依赖 M1.1 | [PR 764](https://github.com/modelzen/vonvon-bot/pull/764) 至 [767](https://github.com/modelzen/vonvon-bot/pull/767) 已合。v2、v3 真实登录与账号恢复已验。`4b72ae88` 已验公开署名保存恢复，登录名保持独立 | 补齐原生计划剩余场景，不以此前登录代替最终组合验收 |
| M1.3 | 固定版本网页登录续领，依赖 M1.1、M2.1、M2.2 | `1296ad49` 续领修复有普通、PostgreSQL rich 回归及独立审查。`55c6adb3` 上真实非作者从飞书经系统 Ego 浏览器登录回确切版本，新码领取、刷新和库重开已通 | 最终候选保留回程复验。内置 WebView 未测 |
| M2.1 | 不可变版本、领取权、码与回执，依赖 M1.1 | [PR 761](https://github.com/modelzen/vonvon-bot/pull/761)、[777](https://github.com/modelzen/vonvon-bot/pull/777) 已合。App 发码、兑换和停用状态已观察。真实非作者新码领取及 fixture B 兑换分别通过 | 保留两类账号的独立证据，核对最终版本权益 |
| M2.2 | rich-v2 契约与跨代兼容，无运行前置 | [PR 779](https://github.com/modelzen/vonvon-bot/pull/779)、[780](https://github.com/modelzen/vonvon-bot/pull/780) 已合。完整六标签配置已在真实 Web 与 Native 读取 | 最终客户端、服务端及 legacy 组合检查 |
| M2.3 | 私有资产、Logo、完整云端交付，依赖 M1.1、M2.2 | [PR 778](https://github.com/modelzen/vonvon-bot/pull/778)、[782](https://github.com/modelzen/vonvon-bot/pull/782)、[783](https://github.com/modelzen/vonvon-bot/pull/783) 已合。真实 Storage 与沙箱已验。`4b72ae88` 撤下后既得账号下载 manifest 和三个内容对象，四项哈希匹配 | 备份恢复、限额及最终组合检查 |
| M3.1 | 云草稿登记、确认与恢复，依赖 M1.1 | [PR 769](https://github.com/modelzen/vonvon-bot/pull/769) 已合。已有并发、取消与回执回归。真实重连暴露新版候选恢复句柄失效 | existing-only 原交接恢复正在纵向实现，需新源码独立审查和真实复验 |
| M3.2 | 本机取源、私聊与同稿编辑，依赖 M3.1、M2.2 | [PR 773](https://github.com/modelzen/vonvon-bot/pull/773)、[781](https://github.com/modelzen/vonvon-bot/pull/781) 及本地 rich 修复。真实 GitHub 作者已关联本人私聊、确认内容并保存自己的草稿。首次上传时限修复已部署 | 恢复原卡和原候选后验证同 UUID 改稿与修订增长。到期卡暂停和 App 预填不计为模型改稿 |
| M3.3 | App 审核、发布与版本管理，依赖 M1.2、M2.3、M3.2 | [PR 770](https://github.com/modelzen/vonvon-bot/pull/770)、[775](https://github.com/modelzen/vonvon-bot/pull/775) 及本地 rich Main/UI。App 已发布反馈 v1 和凭码配方。`4b72ae88` 已验撤下、取消撤下及既得权益保留 | 出新版候选已继承名称、摘要、概览、Logo 和访问方式，但尚未保存或发表 v2。恢复修复后继续验证 |
| M4.1 | 设备范围内安装授权与恢复，依赖 M1.1、M2.1 | [PR 768](https://github.com/modelzen/vonvon-bot/pull/768) 已合。真实 Web 新获取已同步到 Native 账号库。另已完成专用 Bot 安装 | 最终真实账号、设备交接及失败恢复 |
| M4.2 | daemon、Main 安装、原入群与旧群兼容，依赖 M1.2、M4.1 | [PR 771](https://github.com/modelzen/vonvon-bot/pull/771)、[772](https://github.com/modelzen/vonvon-bot/pull/772)、[774](https://github.com/modelzen/vonvon-bot/pull/774)、[776](https://github.com/modelzen/vonvon-bot/pull/776) 已合。既有群与新群真实安装，角色、两个 skill、三个文件及双 Bot 隔离已核对 | 补失败恢复及最终版本安装检查 |
| M4.3 | 完整配置、技能、任务与更新、忽略，依赖 M2.2、M2.3、M4.2 | rich runtime、时区及 legacy 兼容修复已整合。实际落盘匹配所选来源，未选 skill 排除。managed CLI 1.0.100 与普通 setup 的真实目标配置已通 | 真实更新、忽略、任务默认暂停和冲突仍未通过。当前安装样本没有任务或记忆 |
| M5.1 | 部署包与隔离单元，依赖 M2.3，可与 M3、M4 并行 | 当前 `4b72ae88` 的隔离部署已通过。四单元 active、boot-disabled、无 drop-in，Broker 两项真实 `ExecStartPre` 成功。daemon 双 Bot 和配对保留 | 保留当前源码和实际运行证据，后续修复取得自己的部署与单元复验 |
| M5.2 | 公网域名、TLS、登录回程与飞书打开，依赖 M1.3、M5.1 | `55c6adb3` 上真实飞书链接经系统 Ego 浏览器、GitHub 返回确切版本。非作者错码仍锁、正确新码解锁六标签，刷新、账号库重开及 Native 同步均已验 | 最终候选复验必要回程。内置 WebView 未测 |
| M5.3 | 整批回归、反馈联合链、验收与 `dev` 集成，依赖 M1 至 M4、M5.2 | 普通 setup 已配置目标，真实问答已送达且未代提交或改设置。流式卡更新的非法 element ID 拒绝由 [issue 784](https://github.com/modelzen/vonvon-bot/issues/784) 跟踪。本人 OAuth 待回复 | 完成本人授权、聊天确认、原生 Base 提交回链和第二用户隔离。整理最终补丁及独立审查，统一 CI，owner 验收后合入 |

## 并行调度

- 当前关键路径是原交接恢复修复、真实 v2 发布，再验证安装更新和忽略。`32ce` 的 UI-only 补丁被独立审查判为 BLOCKED，未成为当前候选，不能替代修复验收。
- 反馈问答已送达。流式卡问题与本人 OAuth、提交回链分别跟踪，setup 成功和旧模拟表单收件不关闭完整反馈链。
- 同一组真实 Bot、测试群、daemon 和 Main journal 只交给一名验收者。浏览器、桌面打包与服务器变更由集成负责人调度。
- 各片先自测并由不同模型独立审查，进入功能集成分支时不逐片跑重 CI。最终按累积差异统一检查。合入功能集成分支、合入 `dev`、提升 `main` 和公开发布分别报告。

每次状态更新记录确切源码、实测类型与剩余门槛。旧候选通过、代码存在、权限指纹保持或部分 CI 结果均不能关闭整个 M。
