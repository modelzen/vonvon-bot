# Owner updates after the research started (binding; newer entries override older ones)

## 2026-10-14, update 1
- The owner agreed to replace pstack with Ultracode workflows for Claude's development work. Independent review is done by subagents inside workflows, and the rule is written into AGENTS.md so it does not depend on the mode.
- Group response, the owner's decision for v1: keep the original bridge modes as the base layer, set per bot in each group: 仅 @ 时回复, or 全部回复. Add a third mode 智能回复: a small model judges whether the bot should respond to a message. The owner also mentioned a "Jev" model or a "选择 API" and said OpenAI has released a model like this (the name is an unclear transcription). Do not design the five-rule scheme Claude proposed earlier. Exact judge prompts, model choice and thresholds can be decided during implementation; v1 only fixes the three modes, the defaults, the permissions, and the multi-bot behaviour (loops, several bots answering the same message).

## 2026-10-14, update 2: the owner's question about conversation context (close to verbatim)
"一个 bot 对话是在飞书群里的吗？也有可能在私聊里面，我不确定要不要做私聊。即使在飞书群里，它的上下文怎么算？发一个消息过去，这个会话的上下文怎么算？群里的对话消息还可以生成一个单独的会话，飞书群里还可以再带话题会话，这种又怎么算上下文？形式是不是可以做成跟 Codex 或者 Claude 原生的会话形式一样？多个人、多个 Agent 的话上下文怎么搞？每个 Agent 有自己的上下文、自己的会话，我觉得是 OK 的。压缩怎么压缩？要不要支持命令？还是自动？上下文还有记忆。飞书有飞书 CLI（lark-cli）可以查历史消息，如果要查的话这点可以利用到。"

A separate research run answers this and writes `context-model.md` in this directory. When that file exists, read it fully and add a 上下文 subsection to section 3 (Bot 模型): where conversations happen (group topics, single-session groups, DM yes or no), what counts as context in each case, several people, several bots, compaction (automatic, command, or both), looking up Feishu history (API or lark-cli), and how context relates to memory. The cap on decision questions rises from 8 to 10 so this topic can have its own questions.

## 2026-10-14, update 3: group session kinds and sub-agents (close to verbatim)
"我原本是分两种：多会话群和单会话群。单会话群就是一个群一直一个会话的上下文；多会话群就是一个群里会创建出多个会话，每个会话对应一个 Agent 的会话。我之前没有子 Agent，这版肯定还是要支持子 Agent 了：子 Agent 怎么显示？在一个群里它的上下文怎么算？这些都调研一下，想一个比较好的方案。这是个新产品，不用太顾及老产品。"

So: sub-agent support and display are in v1. The old two group kinds are a starting point, not a constraint. `context-model.md` covers this too; put sub-agent display in the 上下文 subsection or next to the run-card items.

## 2026-10-14, update 4: open source decided
The owner decided: v1 is closed source; whether to open-source is reconsidered later. No open-source research is needed. Section 5 only records this decision in one or two lines. Do not include an open-source decision question.

## 2026-10-14, update 5: the four process items are approved
The owner approved: (1) no product code during the design stage, with #281 and #285 kept on hold; (2) Claude changes AGENTS.md and CI now, in a docs and CI PR that Claude merges itself; (3) swap (done: 4 GB at /swapfile); (4) no Demo 0 (the owner does not want to look at the current UI). The product design Q&A happens after the research returns, right before development starts, with Claude asking concrete questions topic by topic.
