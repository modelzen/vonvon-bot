# 实现状态

2026-11-14。本批仍在开发和自验，尚未合入 dev、提升 main 或发布产品。owner 已明确本轮全部由 Codex 承担计划、实现和独立审查；各片先进入功能集成分支，最后统一执行集成 CI。

## 已审查并进入集成分支

| 交付 | 证据与边界 |
| --- | --- |
| 文字角色、setup、私人草稿、不可变发布、公开／凭码读取、账号库及分享码 | [PR 761](https://github.com/modelzen/vonvon-bot/pull/761)。真实隔离 PostgreSQL/HTTP 与浏览器合成身份流程已验，不代表完整配置、图片或真实飞书创作已交付。 |
| 业务账号映射与旧权益迁移 | [PR 763](https://github.com/modelzen/vonvon-bot/pull/763)。独立业务 ID、固定 issuer、停用账号和并发首次登录已用真实 SQL 验证。 |
| 原生主进程登录会话、头像、网页中转、账号与设备入口 | [PR 764](https://github.com/modelzen/vonvon-bot/pull/764)、[765](https://github.com/modelzen/vonvon-bot/pull/765)、[766](https://github.com/modelzen/vonvon-bot/pull/766)、[767](https://github.com/modelzen/vonvon-bot/pull/767)。使用实际 Auth SDK 配合合成上游，测试 PKCE、终态、换号和恢复；实际网页完成页与无原生能力的账号设置已观察。尚未完成真实 OAuth 或 Electron 全流程验收。 |
| 已取得确切版本的云端安装授权 | [PR 768](https://github.com/modelzen/vonvon-bot/pull/768)。设备密钥与 nonce 证明、取消／兑换仲裁、独立完成回执与限额已用 PostgreSQL 15 验证。SQL 空值、锁等待跨期限和未来 ID 的发现已复现、修复并独立复审。 |

## 真实环境进展

- 在 owner 指定组织内建立独立免费 staging，地域为新加坡；原暂停项目未改动。
- 首四份 schema/账号迁移已按哈希记录执行；专用 API 登录只获受限角色。使用控制台提供的 CA 验证证书链和主机名，实际数据库连接及本地 API 启动成功。配置、密码与 CA 路径在仓库外管理。
- staging 实际 JWKS 提供 ES256 公钥。GitHub 测试 OAuth 应用已登记，生成 secret 时平台要求本人验证；owner 明确选择本轮暂时跳过真实 GitHub 登录测试。没有生成或配置该 secret，没有以模拟结果宣称真实登录成功。
- 首个答疑／排错配方的多维表格入口已建立并完成测试写入和读取核对；配方不会自动代用户提交或重试问题报告。完整 Bot→私聊→草稿→群安装仍需实现和验证。
- 腾讯云官网主机的只读 SSH 资源检查在密钥交换前被远端关闭，尚未读取当前资源或部署新服务。没有更换正式官网配置、DNS、stable 或正式 Bot。

## 仍须完成

群内安装的主进程编排、原入群流程复用、更新／忽略及恢复；原生社区的完整自验；真实管理员双向关联、私聊投递和创建／修改同一草稿；完整可移植配置、Logo 上传及服务端转码／私有资产；运营撤下与限额回收；部署、整批平台检查和最终主流程验收。

测试通过只覆盖当次命令的路径。已发现的用户确认、组件重连、接口校验和落盘失败问题必须修复并再次审查，再将相应切片计为完成。owner 本轮跳过的真实 GitHub 登录保持明确未验证。
