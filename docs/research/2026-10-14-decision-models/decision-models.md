# 判断模型：OpenAI Decisions API 和 Jev

2026-10-14 查。主人在定义第一版时提到"OpenAI Decisions API，或者 Jev"，想用它们做智能回复和智能会话里的前置判断。同一天的 `2026-10-14-v1-definition/group-response.md` 写的是"没找到"，那是搜索漏了，以本文为准。

文中"推断"是我根据证据推出来的，"未核实"是只有二手来源。

## 结论

1. 两个都有，都是专门做判断的模型：输入一段文字（Decisions API 还能带图），问几个事先定好的问题，返回选项和概率，不生成文字。
2. 两个都要单独的 API key 和按量付费，Codex 和 Claude 的订阅都覆盖不到。
3. 用在 vonvon-bot 上很便宜。一次判断按 2,000 个输入 token 算，1,000 次约 0.2 美元（Decisions API）或 0.08 美元（Jev）。推断，按下面的单价算出来的。
4. 所以第一版的做法是：默认用订阅里的小模型做判断，关掉思考；用户在设置里填了 OpenAI 或 TypeSafe 的 key，就改用 Decisions API 或 Jev。这是主人 2026-10-14 的回答。

## OpenAI Decisions API

| 项 | 内容 |
|---|---|
| 发布 | 2026-09-29 DevDay 公布，2026-10-06 公测，官方说"几周内正式发布" |
| 接口 | `POST /v1/decisions`，目前只有 `gpt-6-luna` 一个模型 |
| 输入 | `input`：一段文字，或带文字和图片的 user 消息；图片只能是内联 base64 |
| 问题类型 | `predicate`：返回条件为真的概率；`choice`：从给定选项里选一个，带各项概率和 `confidence`；`score`：按有序等级打分 |
| 多个问题 | 互相独立的问题放在同一次请求里一起问 |
| 速度 | 官方说比 Responses API 快约 10 倍；The New Stack 写 150 毫秒（未核实） |
| 价格 | 输入每百万 token 0.10 美元，没有输出和缓存费用 |
| 认证 | OpenAI 平台的 API key（`OPENAI_API_KEY`），不是 ChatGPT 或 Codex 订阅 |
| 数据 | 支持零数据保留；可以在美国和欧洲处理 |
| SDK | JavaScript SDK 7.30.0 起有 `client.decisions.create` |

来源：[OpenAI 文档 Decisions](https://developers.openai.com/api/docs/guides/decisions)、[社区公告](https://community.openai.com/t/decisions-api-is-now-available-in-public-beta/1403877)、[The New Stack](https://thenewstack.io/openai-decision-api-luna/)。

## Jev（TypeSafe AI）

| 项 | 内容 |
|---|---|
| 发布 | 2026-09-15 早期访问。一篇 Medium 文章说 5 天后取消了排队，现在任何人都能注册（未核实） |
| 公司 | TypeSafe AI，创始人 Diogo Almeida，以前在 OpenAI 参与过 ChatGPT 背后的研究 |
| 模型 | 官方叫"System One 模型"，只做判断，不生成文字，所以不会输出格式错误的结果 |
| 输入 | `state`：一段非结构化的文字，偏重程序状态 |
| 问题类型 | Choice：从列表里选，最多 255 个选项；Score：按等级打分；Noul：判断一句话真不真，返回 0 到 1 |
| 多个问题 | 并行、互相独立地问，加问题几乎不增加耗时 |
| 速度 | 官方说端到端 70 到 500 毫秒；服务在美国西海岸，官方测速也是在西海岸测的 |
| 价格 | 输入每百万 token 0.042 美元，输出不收费 |
| 认证 | TypeSafe 控制台的 API key |

来源：[TypeSafe 发布文章](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、[TypeSafe 文档](https://docs.typesafe.ai/introduction)、[MarkTechPost](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/)、[Medium（排队取消）](https://medium.com/@iniyarajan/typesafe-ai-and-jev-the-model-that-answers-questions-instead-of-writing-essays-4b58788d554e)。

## 和 vonvon-bot 有关的几点

- 智能回复问的是"这条消息我该不该接"，用 `predicate` 或 Noul。几个 bot 在同一台机器上时问"谁来接"，用 `choice` 或 Choice，选项是本机的智能 bot 加一个"都不接"。
- 智能会话问的是"这条消息是接着当前话题，还是一件新事"，也是 `choice`。
- 两个都返回概率，阈值可以按群调。官方都建议用自己的样例定阈值。
- 都不支持中文的说明我没看到，也没看到明确说支持。中文群消息的判断效果要实测。
- 两个服务都在海外。飞书用户在中国大陆时能不能直连：未知。订阅里的小模型也走海外服务，情况一样。
- 订阅里的小模型做判断的成本是占订阅额度，具体占多少：未知，要在 Mac 上量。
