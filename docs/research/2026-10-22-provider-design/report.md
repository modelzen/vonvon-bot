# Provider 重设计：实现调研与原型边界

调研日：2026-10-22。只读对照 [HarnessRouter `00054dc`](https://github.com/HarnessRouter/harnessrouter/tree/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38)、[Magpie `86254d4`](https://github.com/yetone/magpie/tree/86254d4049cb6be4a2ccdab02edf0bd59860c603) 和 Vonvon Bot 工作树基线 `cf5ec97d28c8c353f9db1485b281d14a2d97dbcf`。这是设计材料，不改产品规则或实现；当前先完成计划和可评审原型。

## 结论

Provider 页应回答三个独立问题：本机有没有可运行的 Agent、它的认证能否确认、选定的模型来源能否驱动它。安装成功不等于已登录，已登录不等于模型可用；探测失败应显示「无法确认」和重试入口。首次使用按 **Provider → Bot → 群** 引导，设置里只有一个 Provider 入口。保留每个 Agent 的原生能力，不把两种 Agent 压成一份看似通用、实际缺功能的配置表。

## 参考实现：采纳、调整与放弃

| 判断 | 证据与对 Vonvon 的用法 |
|---|---|
| 采纳运行时与模型来源分层 | HarnessRouter 的 runner 明确区分 CLI backend 与供其使用的 provider（[runner/server.py:1](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/runner/server.py#L1-L40)）；网关用实际协议接线判断配对（[gateway/app.py:5865](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/gateway/app.py#L5865-L5910)）。技术上区分执行工具与模型来源；界面保留用户已有的 Provider 称呼，在详情中说明工具、账号与来源，避免额外引入 Agent／运行时术语。 |
| 调整就绪状态 | HarnessRouter 用可执行文件存在判定已安装，启动时把缺失写进日志（[docker/entrypoint.sh:222](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/docker/entrypoint.sh#L222-L253)、[1577](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/docker/entrypoint.sh#L1577-L1587)）；但其目录仍静态标「ready」（[gateway/app.py:17834](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/gateway/app.py#L17834-L17855)）。Vonvon 已有更具体的 Codex 版本、app-server 和 `account/read` 探测（`packages/daemon/src/agent/codex-appserver/setup.ts:66-86`），后端应区分安装、认证、可启动、模型可用四种事实。界面用安装、账号两行呈现当前动作，并在汇总就绪前确认启动与模型目录；不把四种事实铺成四张检查卡。 |
| 采纳可运行模型的诚实展示 | HarnessRouter 的模型选择器计算实际可服务集合；不支持所选模型时在启动前拒绝（[gateway/app.py:8232](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/gateway/app.py#L8232-L8305)）。设计里只让已证实的 Agent × 模型来源 × 模型组合可选，并给不可选项具体原因。该仓同一路由的文档字符串仍写「fallback」（[20990](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/gateway/app.py#L20990-L21000)），与执行代码冲突，不能把注释当行为保证。 |
| 保留原生 Agent 能力 | HarnessRouter 把 CLI 事件归一成 Claude `stream-json`（[runner/server.py:9](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/runner/server.py#L9-L10)），同时 Codex 流式路径又走原生 app-server 的 `thread/start`／`thread/resume`／`turn/start`（[12118](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/runner/server.py#L12118-L12128)、[12220](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/runner/server.py#L12220-L12229)）。Vonvon 保留现有 Codex app-server、Claude SDK 适配器；通用层负责共同展示，不吞掉不同的续聊、权限、工具、skill 与审批能力。参考仓自己也区分硬性工具限制与指令级限制，并承认无法列尽 CLI 自带 skill（[gateway/app.py:17829](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/gateway/app.py#L17829-L17855)、[20922](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/gateway/app.py#L20922-L20952)）。 |
| 借鉴 Magpie 的渐进展示与失败保留 | Magpie 把订阅账号和其他来源分组（[app.js:7305](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gui/assets/app.js#L7305-L7319)），新增配置用展开区域（[app.js:15112](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gui/assets/app.js#L15112-L15134)）；未保存的添加表单可只读取模型列表；已保存 Provider 的刷新遇到错误或空结果时保留旧选择，成功刷新时仍可能移除失效模型（[models.go:200](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/models.go#L200-L250)、[406](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/models.go#L406-L430)）。原型采用安静的行分组和按需展开；失败时保留既有有效配置并明确显示探测错误。视觉参照 [app.css:1](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gui/assets/app.css#L1-L40) 与 [panel-light.png](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/site/public/img/panel-light.png)。 |
| 不引入网关接管与批量装 CLI | Magpie 在改写其他 Agent 配置前保存原值并做有归属的回滚（[stash.go:17](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/agent/stash.go#L17-L64)、[applied.go:724](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/agent/applied.go#L724-L787)），且有关闭订阅账号发现后不读凭据的隐私闸（[discovery.go:1](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/discovery.go#L1-L38)）。这是以后需要接管外部配置时的参考，不是本轮核心。HarnessRouter 的 Apache-2.0 只覆盖本仓；其 [NOTICE:59](https://github.com/HarnessRouter/harnessrouter/blob/00054dcc95947c5ca5b3b9f0cad2e62f46ac7a38/NOTICE#L59-L63) 明确第三方 CLI 许可另算并在首次启动安装。本轮不照搬其 Docker 批量安装。 |

## Vonvon 的实现映射与待定范围

现有目录与工厂已分开：`packages/daemon/src/agent/catalog.ts:3-10,86-120` 保存元数据、依赖和下载策略，`packages/daemon/src/agent/index.ts:9-35` 懒创建两个后端；`packages/daemon/src/admin/service.ts:896-926` 提供状态与按需安装。Claude 登录检查也明确区分本地凭据、后台钥匙串不可见和过期后的真实运行失败（`packages/daemon/src/agent/claude-agent/login.ts:12-40,87-94`）。先以这些真实状态设计，不新增假探测。群模型与 Effort 各自多选；群级选择保存独立集合，同时按具体模型的能力约束生成合法组合，不能把跨模型的档位并集当成每个模型都支持；在创建／加入群时把已选 backend 传入 `JoinGroupDialog`，避免硬编码 Codex。Bridge 导入入口始终可找到。

原型保存在本次任务的本地设计资料中。并列比较三种方向：**引导卡片**（首次路径显眼）、**紧凑列表**（已配置者快速扫状态）、**专注分步**（逐步排错）。三者使用同一组真实状态：未安装、待登录、无法确认、探测失败、可用，并显示重试和下一步。

本轮设计范围：现有 Provider 界面重组、设置单入口、首次路径、状态文案、Bridge 导入可达、组内模型／Effort 选择及 backend 传递。若原型评审后进入实现，先核对现有配置和迁移路径，再接缺失的状态／能力接口。新增通用 API endpoint 编辑器、平台模型目录、多 Agent 的订阅路由和改写外部 Agent 配置列为未来议题；只在当前原生适配器已支持的官方模型／认证路径上给可执行入口。

## 核实记录

本报告根据上述固定提交和 Vonvon 指定工作树源码作静态核对；没有启动参考服务、读取凭据或做端到端运行。产品取舍与原型仍待 owner 评审；上述代码行是实现证据，不代表已在本机对全部供应商做实时验收。

Magpie 的模型能力还可能来自 models.dev 或同族推断，而非在线探测（[models.go:1667](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/models.go#L1667-L1692)、[1712](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/models.go#L1712-L1743)）。本轮只借鉴交互；正式版不得把推断 Effort 当作确认支持。

独立核对：另一位 gpt-6-sol 代理复查 Magpie 引用与原型，指出刷新保留条件、模型目录检查、Effort 配对和已有安装来源四类问题。报告已收紧表述；原型增加模拟模型读取阶段、已有 API 配置状态、安装来源及合法组合校验。仍为静态研究与模拟交互，未运行上游服务或验收真实账号。
