# Jev 决策接口扩展

## 做什么与范围

owner 2026-10-30 确认新增 OpenRouter Jev、Vercel Jev、自定义 Jev/System One 完整请求地址，保留 TypeSafe。普通语言模型沿用当前 Provider 配置，不增加模型 API 类型；不接插件市场或本地模型安装。完成后提供隔离的 Mac 本地验收，不发布、不替换 owner 正在使用的应用。

## 现在的代码

实施基线为 main `c560fe72`。`judge/decision.ts` 登记 TypeSafe；`typesafe.ts` 负责请求、5 秒预算和限流；`judge/global-models.ts` 与 `admin/host-settings.ts` 保存整机模型配置并固化旧群引用。`DecisionPicker`、`DecisionProviderSettings` 与 `SecretsPanel` 共用当前决策入口。

## 怎么改

- 登记 openrouter、vercel、custom，密钥分别使用 openrouter-api-key、vercel-api-key、custom-decision-api-key，保持 TypeSafe 的 typesafe-api-key。
- OpenRouter 默认模型 typesafe/jev-1.14，Vercel 为 typesafe-ai/jev，自定义为 jev-latest；允许填写服务实际接受的模型 ID。
- 预设只发往官方固定 System One 地址。自定义填写完整 HTTP/HTTPS 请求地址，不自动追加路径，拒绝 URL 内账号、密码、查询与片段，不跟随重定向。
- 共用现有网络层、判断输入、概率解析、取消与失败规则；每家独立密钥、队列和冷却，自定义地址改变后不沿用旧地址的认证冷却。
- 机器级 byProvider.custom 新增 endpoint。此连接地址与密钥一样由本机使用该连接的群共享；每次判断读取地址。模型仍按现有规则保存群快照，更改全局模型不改已有群模型。界面如实说明地址共享。
- TypeSafe 的试一次仍列模型；新增服务用固定虚构消息发一题 Choice，验证所选模型可用和响应格式，不发送群消息。
- UI 统一选择、分别配置密钥；自定义地址和模型可先保存，选择为默认/给智能群使用前校验地址与密钥。没有有效地址不能伪装成仅缺密钥。

## 测试与自测

定向覆盖协议、选择/快照、host CAS、自定义地址校验与热读、服务和凭据分离、旧 TypeSafe、格式错误/认证/限流/取消/超时、密钥不交给 Bot、UI 自动保存与组内选择。使用本机 HTTP 测试服务验证真实请求，不调用付费账号。

Mac 上构建 protocol/client/UI/daemon，在全新隔离 HOME、VONVON_HOME 和 Electron userData 中验收。网页操作使用浏览器控制，不编写 Playwright 操作脚本。检查四家服务、缺密钥/缺地址引导、自定义保存和重新读取、密钥试判。没有指定飞书测试群，不发群消息。

## 验收与风险

owner 后续明确无相应 key，授权 Codex 自行简单验收后合入 dev。验收新增三种入口可见且可配、原 TypeSafe 保留；HTTP fixture 不代表真实网关付费推理已验证。

风险主要为地址与凭据配错、旧配置兼容、全局设置的 CAS/快照、错误路径；不增加子进程类型或迁移用户数据。源代码与当前产品约定一并更新，截图与运行目录留本机，diff 不含真实凭据或环境标识。

## 本地实现与验证

后台 14 个定向测试文件共 350 项、协议 79 项、界面 11 个定向文件共 208 项通过；全工作区类型检查、协议 lint、protocol/client/UI/daemon/desktop 构建通过。新增的 HTTP fixture 证明实际判断读取自定义地址并在地址改变后解除旧地址的认证冷却。只读复核发现并关闭成功响应模型字段回显、首页 Jev 用量漏计及预览提供方硬编码。

真实浏览器完成四服务显示、OpenRouter 缺密钥跳转、自定义地址/模型保存与重新读取、固定虚构试判返回“能用”、非法地址被拦截；截图保留本机。后台保存结果与界面一致。使用全新隔离数据目录打开独立桌面验收窗口，展示新增接口，所有 key 留空交 owner 填写；自动测试的 daemon 和示例服务器已停止。未调用真实网关付费账号，未触碰日常应用与其数据，未合入或发布。

owner 指出自定义入口仅弹出密钥框：将接口地址、模型 ID、API 密钥合并到同一配置区，缺配置时选择器直接定位地址输入。同步修复地址搜索目标及 host 配置读取失败时自定义密钥入口丢失；只读复核通过。真实浏览器复验三项同区、入口定位、保存与本地虚构试判；两个官方网关均返回未授权 401，证明地址可达，未使用付费 key。未推送的开发提交在创建 PR 前调整为基于 dev。
