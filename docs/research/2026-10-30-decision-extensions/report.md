# 判断模型的开放接入、插件分享和本地推理

2026-10-30 调研。代码基线为本地 `main` 的 `cf5ec97d28c8c353f9db1485b281d14a2d97dbcf`。读取了产品反馈群 10 月 29—30 日的讨论，复用了 10 月 18 日 Jev 实测报告，并重新核对提供方与本地模型的官方资料。群聊只归纳问题，不在仓库保存成员姓名、群标识或完整聊天。

本轮是方案建议，不改变 `docs/product.md` 的既有决定；没有运行付费推理，没有把群聊发给候选服务，没有在本机安装模型或修改运行中的 Bot。本地 CPU 数字是项目方公开测量，不是本轮实测。

## 1. 建议

**先做可配置的判断连接，再做可分享的决策包，代码插件后置；本地推理先作为可选连接验证。**

这三个方向可以使用同一个输入输出协议，按需求逐步开放，无须分成三套产品。

| 阶段 | 交付内容 | 解决的问题 |
|---|---|---|
| 第一阶段 | TypeSafe、OpenRouter、Vercel 预设；自定义 System One 接口；本地接口；最小试判 | 用户能使用已有账号、网关和本地服务，不必只在 TypeSafe 开户 |
| 第二阶段 | 导入、导出不含凭据的决策包；GitHub Release 分享；少量官方精选 | 别人配好的接入和规则，普通用户也能安装和选择 |
| 同期实验 | 中文群聊评测集；Laya multilingual 与较强的本地候选对比；只记录的影子运行 | 判断 CPU 方案是否达到实际使用要求 |
| 第三阶段 | 确有需求后开放自定义代码、SDK、受限运行时 | 用户能实现多阶段判断、自己的模型或业务算法 |

如果近期只做一项，做第一阶段。多接两个网关会立即解决群里反馈的问题；完整插件市场并不能直接消除开户、网络和模型选择的门槛。

## 2. 群聊表明的需求

反馈包括：不知道当前判断是否使用 Jev；Jev 官网需要绑卡；想添加自己的中转接口却找不到方法；有人提出本地跑 Laya，认为 CPU 能承受。还有本机自定义模型列表相关的反馈，但那是执行后端模型发现的问题，不能全归为决策模型问题。

这里至少有三类需求：

1. **接入自己的服务。** 已有 OpenRouter、Vercel 或其他网关账号，不想再注册一家。
2. **知道当前用的是什么。** 模型、接入服务、从 Bot 继承还是群覆盖、配置是否有效，需要能直接看清。
3. **本地、无逐次 API 费用。** 接受下载和常驻内存，希望减少外部依赖。

插件适合第四类需求：自己改判断算法，以及把整套方案分享给别人。不能仅靠“支持插件”就认为前三类也解决了。

## 3. 当前代码已经有什么

- `packages/daemon/src/judge/decision.ts` 有 `DecisionProvider` 登记表，目前仅 TypeSafe，模型候选为 `jev-latest`。
- `packages/daemon/src/judge/typesafe.ts` 把判断地址固定为 `https://api.typesafe.ai/v1/systemone`；单次 HTTP 请求预算为 5 秒，外层还有判断期限、队列和取消。
- `packages/daemon/src/judge/types.ts` 已保存 `{kind:'decision', provider, model}`，Bot 默认、群覆盖也已具备。语言模型判断仍与群的执行后端关联。
- `decisionBody()` 已把消息、上下文、Bot 分工、所在位置、智能规则和候选锚点转成结构化输入。主区结果为 `skip/main/topic`，话题内为 `skip/reply`。
- `readDecision()` 目前读取 Jev 的概率分布，取最高项；不能直接把任意插件回包喂给它。
- `prompt.ts` 的上下文最多 20 条、合计 6,000 字，当前消息最多 2,000 字，个性 1,500 字；`smart-file.ts` 的智能规则最多 8,000 字。这些是上限，实际请求可能小很多。

所以近期增加 System One 兼容连接有明确复用点。通用插件还需要独立的宿主协议、能力声明、运行方式和安装生命周期，不能仅把静态 Map 换成动态加载。

## 4. 云端接入：模型、提供方、连接分开

Jev 是模型；TypeSafe、OpenRouter、Vercel 是访问它的路径；一个用户创建的连接还包括自己的地址、凭据引用、模型和选项。相同模型换网关，主要改变的是账号、计费和网络路径，不代表判断质量自动变强，也不代表上游推理服务独立冗余。

| 路径 | 已核对的判断地址 | 模型示例与注意点 |
|---|---|---|
| TypeSafe 直连 | `https://api.typesafe.ai/v1/systemone` | 当前产品使用 `jev-latest`；可以固定版本做评测 |
| OpenRouter 兼容接口 | `https://openrouter.ai/api/v1/systemone` | 文档支持裸 Jev id，也支持 `typesafe/jev-1.13` 这样的完整 id；凭据为 OpenRouter key |
| Vercel 兼容接口 | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | 文档示例为 `typesafe-ai/jev`；凭据为 AI Gateway key |
| 本地 Ollaya | `http://127.0.0.1:11435/v1/systemone` | 例如 `laya:multilingual`；本地连接不应强制有远端 API key |
| 自定义兼容服务 | 用户填写完整判断地址 | 明确要求 System One 请求响应格式；仅支持 Chat Completions 的中转站不能直接接 |

OpenRouter 与 Vercel 都明确提供 TypeSafe 兼容接口，因此第一轮可以复用 `state/questions/answers`。但这不等于所有端点都相同：OpenRouter 还有 alpha Decisions API，Vercel 还有自己的 Decision API，模型名称、字段和错误返回必须由适配层处理。[OpenRouter 兼容接口](https://openrouter.ai/docs/guides/community/typesafe-sdk)、[Vercel 兼容接口](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)。

一个容易漏掉的地方是模型发现和测试。OpenRouter 官方说明，其 `/api/v1/models` 的返回格式不同于 TypeSafe，TypeSafe SDK 的模型列表解析会失败。当前 Vonvon 的“试一次”只是向 TypeSafe 模型列表发请求，扩展后应将“连接可达”“凭据有效”“所选模型能完成判断”分开。建议增加一条虚构消息的最小推理测试，不发送真实群消息。[OpenRouter 说明](https://openrouter.ai/docs/guides/community/typesafe-sdk)。

推荐用户操作是：新增判断连接 → 选服务或填兼容地址 → 选/填模型 → 如需要则填 key → 试判 → 设置为 Bot 默认或单个群覆盖。选择处直接显示“模型 · 服务 · 继承来源”。同一家服务应能保存多个连接和各自的密钥引用。

配置设计上，用稳定的连接 id 引用地址、凭据与模型配置；旧的 `typesafe + model` 选择继续可读，迁移时保留其含义。协议适配器、用户连接、插件包分别标识，避免两个 OpenRouter 连接共用一个 provider id 而互相覆盖地址或 key。插件版本升级也不应改变群原来选中的连接。

“更多模型”可以先靠网关目录与手填 id 覆盖，不必为每个模型写一套 UI。OpenRouter 目前还列有 Perplexity Decider、Liquid d1、Kev 等决策模型；它们是候选，并没有在 Vonvon 上验证优劣。[官方决策模型目录](https://openrouter.ai/for-ai#decisions)。优先选 Jev 固定版本作基线，再选一两个其他模型比较，不根据排行榜自动更换默认模型。

如要支持普通语言模型 API，应另提供 Chat Completions/其他协议适配器，把同一份输入交给模型并校验结构化输出。不要宣称一个 System One URL 输入框支持所有中转站，也不要把模型在 JSON 里自报的 confidence 当成校准过的概率。

## 5. 插件的边界和固定 JSON

用户提出固定输入输出、中间由用户实现，这个方向合理。建议公开的是 **Vonvon 自己的判断协议**，Jev 的回包只是其中一种适配，避免所有插件都被要求仿造概率分布。

建议输入有协议版本、请求标识、位置类型、Bot 分工、智能规则、当前消息、上下文和合法动作/锚点。保留短消息引用，给出宿主已经实施的截断信息、输入预算和 deadline。输出的最小形式可为：

```json
{
  "protocolVersion": 1,
  "requestId": "example-request",
  "decision": "topic",
  "anchorRef": "m0",
  "reason": "新的任务，需要多轮处理"
}
```

这是提案，不是当前已经公开的插件协议。主区和话题的合法动作不同；`anchorRef` 只能来自本次宿主给的合法候选。`probabilities` 和 `confidence` 可以缺省，若提供则要有来源说明；不同模型的分数不能直接套同一阈值。`skip` 是有效业务决定，格式错、超时、不可用是调用错误，应分开记。

中间算法可以是一个模型、正则加模型、多模型、自己微调的分类器或远程服务。固定的输入输出限制它能读什么、能建议什么；宿主仍负责验证、执行和期限。

宿主保留：响应成员与权限限制、调度和关注度、每小时上限、并发队列、撤回/关闭时取消、锚点合法性、最终发送与开话题、现有失败兜底。插件只建议本次怎样处理，不能自行发送飞书消息、创建会话、取得其他群的数据或绕过宿主约束。

初期只把已有判断事实交给插件，凭据通过指定连接由宿主管理；不交所有环境变量、飞书令牌、执行后端密钥、数据库路径或其他群历史。联网地址和本地执行能力是插件的实际权限，固定 JSON 本身不形成运行沙箱。

## 6. 别人的插件怎么安装和使用

先把“决策包”定义成可分享的配置与实现描述，分成两种：

| 包类型 | 内含什么 | 适合谁 |
|---|---|---|
| 声明式包，先做 | manifest、兼容协议、模型与地址预设、可选规则、配置表单、虚构测试样例 | 接网关、接本地服务、分享某种群聊判断风格 |
| 代码包，后做 | 相同 manifest 加实现、明确的运行环境与能力需求 | 自定义算法、多阶段调用、特殊模型适配 |

所有包都应声明作者命名空间与 id、包版本、宿主协议范围、实际使用的网络域名/本地服务、需要哪些凭据、支持哪些动作与输入上限。包内不带作者的 key，不默认覆盖用户自己写的群规则。规则包和连接包可以分别复用。

一个实际分享流程：

1. 作者在本机开发、跑官方一致性样例，导出 `.vonvon-decision` 包或 manifest；GitHub Release 发布不可变版本与 SHA-256，模型权重用单独的版本和哈希引用。
2. 作者把安装链接或包文件分享给别人。初期提供“从链接安装”和“导入本地包”，无需先建设完整市场。
3. 安装页显示作者、用途、版本、网络去向、是否运行本地代码、下载体积，以及所需的账号或本地服务。用户安装后绑定自己的凭据；作者分享的是实现，不是付费账号。
4. 用包内虚构样例试判，展示动作、耗时和失败原因，再让用户选择在哪个 Bot 或群启用。安装和启用分开。
5. 检测新版本后由用户更新；固定版本、保留上一版、可以回滚。改变网络目标或执行能力时清楚显示差异。卸载时列出受影响的 Bot/群，由用户选替代连接；不悄悄换成另一个云服务。

可先用 GitHub 上的静态索引放少量精选包，后续再增加搜索、评价与发布者管理。哈希校验保证拿到预期文件，不能证明作者或代码安全；精选也不能代替能力限制。

代码运行方式建议先提供给开发者一个 HTTP 服务接口或受控 stdio 协议，便于任何语言实现。不要直接 `import()` 第三方代码进 daemon，不要安装时执行任意 npm/pip 安装钩子。独立进程有故障隔离价值，但本身并不限制文件和网络权限。面向普通用户自动安装代码前，必须选定可实际执行权限边界的运行时；WASI/受限宿主调用可做后续技术验证，不能仅写一个权限清单就称其已隔离。

## 7. CPU 本地推理：可以做，但先测实际任务

Laya 和 Ollaya 需要分开：Laya 是模型家族；Ollaya 是提供多个本地决策模型的运行与服务工具。Jev 兼容请求可以发给 Ollaya，不表示模型权重相同，也不表示结果相同。[Laya 作者仓库](https://github.com/NandhaKishorM/laya)、[Ollaya 项目](https://github.com/ollaya-dev/ollaya)。

Laya 的 multilingual 版本约 322M 参数，覆盖多语言，适合优先评估中文；根模型偏英文。作者将模型定位为可专门训练的快速基础模型，并明确披露基础检查点在 typed-decisions 零样本任务上接近随机水平；较高的 0.766 来自对该基准训练集微调的特定检查点，不能外推到中文群聊。[作者模型卡](https://huggingface.co/convaiinnovations/laya)。

Ollaya 公开的 CPU 评测给了一个现实量级：

| 候选 | 五题 HTTP 请求中位数 | 峰值内存 | 该项目 typed-decisions 准确率 |
|---|---:|---:|---:|
| Laya multilingual | 516 ms | 1,941 MB | 0.349 |
| Decima small | 591 ms | 586 MB | 0.414 |
| Snap 2B Q4 | 1,735 ms | 2,802 MB | 0.655 |

硬件是 **24 核 Threadripper 3960X**，不是普通笔记本，也不是 Mac mini。这些来自同一个运行时项目的公开评测，只说明速度、内存和质量之间有取舍，不是 Vonvon 的效果排名。GPU 宣传中的十几毫秒不能当 CPU 速度。[Ollaya CPU 文档](https://ollaya.dev/docs/cpu-classification)。

更实际的限制是上下文。Laya multilingual 默认总序列预算为 1,024 token，其中还要给问题与选项分配预算。作者的 Laya SDK 现在提供 `max_len=8192` 的长输入方式，但长文本质量需要另测，输入越长也越慢；这也不代表 Ollaya 的相同模型标签已暴露同一个参数，须单独核对运行时。Vonvon 的上下文、当前消息、个性、智能规则加起来可能显著超出默认预算。不能静默截掉规则或当前消息，再把快速返回理解为模型已读完；也不能把默认只测短文本的速度套到 8k 输入。[multilingual 模型卡](https://huggingface.co/convaiinnovations/laya-multilingual)。

建议本地方案这样落地：

- 第一轮允许用户连接自己已运行的 Ollaya 或 `laya-serve`，保留现有云端/订阅判断选择。
- 进程常驻并共享权重，不为每条消息、每个 Bot 重新加载一份；每个 Bot 仍独立判断，不改变 owner 既定的“各判各的”。
- 模型下载与运行时按需管理，显示体积、内存、CPU/GPU 设备、模型版本；不把所有模型打进安装包。
- 先验证 Mac mini，再测一台普通 Windows x64 电脑与一台小型 Linux CPU 服务器。Apple GPU 的测试单列，不能称作纯 CPU 测量。
- 默认缺省仍按当前产品处理。即使以后做“本地不确定再上云”，也必须作为用户明确启用的策略；当前已定行为是低把握度取最高项、错误不自动转订阅模型。

本地的价值是离线可用、减少逐次外部调用和控制数据去向；代价是下载、资源、维护和判断质量。API 判断本身已很便宜，用户感到的最大收益可能是能否方便用上，而非省下几分钱。

## 8. 用什么证据决定下一步

先做一组 200—500 个中文测试片段，包含技术群和日常群的 Bot 分工差异、直接提问、说给别人、已有人处理、第三人称提到 Bot、连续追问、新任务开话题、引用与锚点、多 Bot 来回、消息中的干扰指令和长上下文。模糊情况允许多个可接受动作。训练/调参用例与最终评测用例按群/会话分开，避免泄漏。

第一轮使用虚构与脱敏材料。真实群片段如果用于外部评测，需另有用户授权；这次读群授权不等于把聊天发给其他模型。

比较 Jev 固定版本、现有订阅小模型、Laya multilingual，以及一两个较强的本地/云端候选。必须记录：

- 应该不回却插话的比例，以及应该回却漏掉的比例，分场景统计，不能被大量“不回”抬高总准确率。
- 主区/话题判断和锚点分别的正确率，不能只测二分类。
- 中文、长规则、截断前后和多 Bot 场景；运行时、tokenizer、权重版本。
- 冷启动、热运行 p50/p95/p99、队列时长、超时、1/2/4 并发、CPU、峰值内存和下载体积。
- 单独看返回概率是否在本场景校准；不跨模型直接复用 0.5/0.8 阈值。

可把“相对当前基线不增加误插话、漏回不明显恶化、目标设备热运行 p95 约 1 秒”作为首轮期望，具体门槛待数据确定，不是已达到的承诺。先在本地评测，再在明确选择的测试群做只记录、不影响实际回复的影子运行。

10 月 18 日已有 Jev 的 31 个编造中文用例与 JP-VPS 延迟测量，可以复用作回归起点；样本小，不能据此宣称总体 97% 的中文群聊准确率，也不能把日本网络延迟当大陆用户体验。

## 9. 核实记录

2026-10-30，由另一代理独立复查。读取整份报告，对照 `cf5ec97d28c8c353f9db1485b281d14a2d97dbcf` 的源码、产品约定与本轮重新打开的官方资料；没有运行推理。

**结论：主要事实有来源支持，未发现需要推翻分阶段建议的事实错误。建议仍是产品与技术提案，不是已实现能力或已通过的效果验收。**

| 核对项 | 结果与边界 |
|---|---|
| System One 端点与模型 id | TypeSafe 的 `/v1/systemone` 与 `jev-latest`、OpenRouter 的 `/api/v1/systemone` 与裸 id／`typesafe/` id、Vercel 的 `/typesafe/v1/systemone` 与 `typesafe-ai/jev` 均有官方文档支持。Ollaya 文档给出本机 11435 端口、`/v1/systemone` 与 `laya:multilingual`。地址与文档示例一致，不等于本轮实测账号可用、网络可达或所选模型能成功判断。[TypeSafe](https://docs.typesafe.ai/api/system-one)、[OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk)、[Vercel](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)、[Ollaya](https://ollaya.dev/docs/typesafe-compatibility)。 |
| 模型发现与试判 | OpenRouter 官方明确说明 TypeSafe SDK 的列表调用会因返回形状不同而失败；其 Models API 是 `data` 数组，TypeSafe 则是 `models` 数组。当前 `probeTypeSafe()` 仅请求固定模型列表并验证能读成 JSON，不验证所选模型能推理。因此正文把连通、凭据和实际试判分开是有依据的建议。[OpenRouter 列表接口](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)、[TypeSafe 列表接口](https://docs.typesafe.ai/api/list-models)。 |
| CPU 性能来源 | 三行耗时、峰值内存与 typed-decisions 数字均与 Ollaya CPU 文档一致：516／591／1735 ms，1941／586／2802 MB，0.349／0.414／0.655。来源明确是 24 核 Threadripper 3960X 上、每请求五道 triage 题的 HTTP 中位数；不能推导 Mac mini、普通电脑、长中文群聊或并发时的 p95。[Ollaya CPU 测量](https://ollaya.dev/docs/cpu-classification)。 |
| Laya 模型与质量 | multilingual 的 322M、根检查点偏英文、基础模型 typed-decisions 零样本接近随机、0.766 来自该基准训练集微调后的特定检查点，均得到作者模型卡支持。作者根模型卡同页对 multilingual 零样本有 0.342／0.352 的小幅不一致，且与 Ollaya 的 0.349 是不同测量；正文没有把它们合并成一个精确结论，处理正确。多语言覆盖也不能代替中文群聊验收。[根模型卡](https://huggingface.co/convaiinnovations/laya)、[multilingual 模型卡](https://huggingface.co/convaiinnovations/laya-multilingual)。 |
| Laya 上下文 | 默认 1024 是每题的总序列预算，作者还为问题与选项保留 256 token；默认供 state 使用的空间约 768 token。模型卡提供 `max_len=8192` 的 SDK 示例，也报告长文本准确率波动；这不是 Ollaya 已暴露同参数、中文长规则质量可靠或 8k 输入仍有表中 CPU 延迟的证据。该细节已反馈并补入第 7 节。[作者上下文说明](https://huggingface.co/convaiinnovations/laya-multilingual)。 |

源码核对还确认：`decision.ts` 的提供方登记表目前只有 TypeSafe，候选列表只有 `jev-latest`，同时接受手填 id；`decisionBody()` 使用结构化 state 和按位置区分的合法动作，主区另有受限锚点候选；`readDecision()` 必须读到合法概率字段，始终取最高项，平局取顺序靠前的一项（`skip` 排第一）。它不是通用插件回包解析器。`prompt.ts` 和 `smart-file.ts` 的字符预算与第 3 节一致；这些字符上限不能直接当作任一 tokenizer 的 token 数。

当前失败规则也与报告的约束一致：`judge.ts` 的决策提供方分支没有出错后改问订阅模型的路径；5 秒 HTTP 预算包含仅在尚未连上时允许的一次重试，外层还受判断期限和取消控制。`handle-message.ts` 的兜底保留真人点名，以及符合单人连续对话条件的话题；撤回、调用方放弃和关闭不触发直接回复。实现新连接时应复用这些实际规则，不能把“出错都不回”当成现状。

固定 JSON、网络域名清单和独立进程都不能单独构成权限沙箱。第 5—6 节已明确这一点；“插件不能自行发消息、访问其他群”等句子应按拟议宿主的能力边界理解，不能当作未经限制的第三方本机进程已经受到的保证。HTTP／stdio、WASI、安装格式、更新回滚与精选索引均未在本轮实现或验证。

本轮没有测：真实账号的兼容推理和计费、网关错误与限流格式、任一候选在中文群聊上的质量与概率校准、模型下载与首次加载、Mac／Windows／Linux 的资源及并发表现、长输入截断路径、第三方代码的权限隔离和安装安全。未发送群聊给候选服务，未读取用户凭据，未运行付费调用或下载模型。第 8 节的样本量、延迟目标与影子运行是后续评测设计；10 月 18 日的 31 个编造样本和 JP-VPS 延迟只核对了已有报告记载，没有重跑，也不能外推为总体准确率与大陆延迟。
