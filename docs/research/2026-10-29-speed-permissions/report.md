# Codex 会话加速权限验证

2026-10-29，Vonvon 分支 `codex/session-speed-tiers`，本机 Codex CLI 0.165.0。owner 要求验证“能用才显示”，采用极简闪电入口；仍暂停合入 dev。

## 已验证的事实

- 原生 `account/read` 能返回 ChatGPT 套餐大类，但 `pro` 不区分月费子档，不能作为 $500 或 Ultrafast 资格的凭据。
- 隔离空 CODEX_HOME、清除继承 API 登录环境变量后，未登录的 `model/list` 仍返回内置 Fast 信息；没有生成远端缓存。因此单看模型目录不够。
- 使用现有登录的隔离副本，仅调用元数据 RPC，真实账号返回 `chatgpt / pro`；本次实时远端目录具有账号身份绑定，所有相关模型只公布 Fast，没有 Ultrafast。
- 实际 `discoverCodexModels` 集成代码在同一隔离环境返回公开 `fast`，没有 `ultrafast`。未发起推理请求，未验证任何实际加速倍率。
- 原生 Fast 的 RPC 档位是 `priority`；公开设置保持 `fast`，发送前转换。

## 实现依据

1. 使用当前 ChatGPT 登录、默认 OpenAI 路由，排除自定义目录和路由覆盖。没有可验证文件登录证据或使用钥匙串专用配置时保守隐藏。
2. 原生远端缓存必须有身份绑定、当前 CLI 版本，且在 300 秒有效期内；不能早于当前 auth 文件更新。缓存档位与本次原生模型 RPC 的档位取交集。
3. 应用原生配置与工作区 `fast_mode / ultrafast_mode` 限制。旧服务端不支持独立开关时，Fast 禁用也禁用 Ultrafast。
4. auth / config / 模型缓存变化或快照过期时失效内存结果。离线保存的模型目录不携带可选加速权限。
5. 不从价格、模型名或 Pro 标签推断权限；普通始终可选。读不到权限时隐藏加速，按普通调度。

这与官方选择器使用的账号上下文目录和限制一致，但不是账单查询。账号服务最终仍可因额度、策略或权限变更拒绝请求。

## 限制

没有可用的真实 Ultrafast 账号作为正例；其展示、工作区禁用、缓存失效和 RPC 传参由隔离夹具覆盖。不能将这些测试称为 $500 账号的实际 Ultrafast 推理验收。没有向真实飞书群发送卡片。

## 官方资料

- [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed)：当前 Ultrafast 套餐和模型限制。
- [App Server](https://learn.chatgpt.com/docs/app-server)：账号与模型 RPC。
- [官方选择器的档位约束](https://github.com/openai/codex/blob/23934d31b15b1127c83535f84854e5009f7cd51d/codex-rs/tui/src/service_tier_resolution.rs)：独立 / 旧版共享开关。
- [原生模型目录管理](https://github.com/openai/codex/blob/23934d31b15b1127c83535f84854e5009f7cd51d/codex-rs/models-manager/src/manager.rs)：远端、缓存、内置回退和账号身份检查。

## 核实记录

独立只读调查确认：身份字段存在本身不证明当前账号匹配，应同时验证登录更新与新鲜度；账号权限内存缓存必须失效；离线快照必须移除速度权限。已按这些发现实施。
