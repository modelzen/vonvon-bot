# s14 design: 对话记录块：主区补拉、话题开场带主区、引用行

Worktree `/home/ops/vonvon/worktrees/s14`, branch `claude/s14-transcript-block`, stacked on `claude/s13-topic-registry` (#328, s13 话题登记表). Line numbers are for that tree (head `0bc841c`). `D/` = `packages/daemon/src/`.

Short version: the estimate is about 1,330 changed lines (range 1,150 to 1,450). That is over the 1,300 bar, so split:

- **s14a (do now, about 700 lines):** the unified record block, main-area back-fill by watermark in single (连续) groups with tiers, other bots' final answers via `card_msg_content_type`, topic back-fill moved onto the same block, and trigger-only when the scope is missing.
- **s14b (next, about 630 lines):** topic openings with the 回指 line and 10 main-area lines, quote lines (引用行) in the main block, finding topics from the main pull (so B sees "A（bot）开了话题"), and the "本群最近 5 个活跃话题" table after a compaction.

---

## 1. What the code does today

| Requirement (product.md 3.5 / v1-plan s14) | Today | Where |
|---|---|---|
| Record block: one line per entry, real name, one line each | Topic history only: `[话题中在此之前已有的消息（按时间先后排列，供你理解上下文）：\n名字：内容\n]`. No header, no time, no place, no "→ @你", no bots | `D/bot/context-weave.ts:515-527` (`weaveThreadHistory`); line clamp `LINE_MAX=280` `:42`; sanitize boundary `:473-482` |
| Sender of the trigger | `[本条消息的发信人：名字（open_id：…）（late note）]` prepended in `ingestContextImpl` | `context-weave.ts:546-558`; `D/bot/handle-message.ts:1446-1477` |
| Quote of the trigger | `[用户引用了一条消息（来自 X）：\n…\n]`. s09 already applies "in a topic, only when parent_id ≠ root_id" | `handle-message.ts:1464-1470`; `context-weave.ts:107-127`, `:499-509` |
| Other bots' cards (`card_msg_content_type`) | Not sent on any pull. `message.get`/`list` use only `with_sender_name`. 2.0/CardKit cards come back as title + "请升级…", which `extractCardText` drops. `raw_card_content` is used only to enrich a degraded **trigger** card | `context-weave.ts:113-116`, `:165-173`, `:381-408`; `D/bot/card-content.ts:110-130`; `handle-message.ts:1173-1179` |
| Other bots' answers in history | Dropped. The topic pull keeps `fromUser` items plus `keepId` (the root) | `context-weave.ts:187-195` |
| Main-area back-fill | None. `topicId = goal ? undefined : msg.threadId`, so the main area resolves `historyP` to `undefined` | `handle-message.ts:1741-1753` |
| Main-area watermark | Pushed to the trigger with nothing woven: `behind` is false for the main area, so `seenHow='advance'` (s09 left this) | `handle-message.ts:1815-1823`; written at `turn_started` `:4968-4973` |
| Non-@ main messages | Dropped at the @ gate, and nothing picks them up later | `handle-message.ts:1145` |
| Late re-push in the main area | Only `isDelivered` (no back-fill means no watermark meaning) | `handle-message.ts:1024-1035` |
| Main message lost after a long disconnect (s09 leftover) | Lost: no main pull | v1-plan s09 留下的 1st bullet |
| Topic opening of a user-opened topic | Topic history (20) plus root fetched if missing. No 回指, no main area | `handle-message.ts:1795-1814` |
| Topic opening when the bot opens the topic from the main area (multi) | Trigger only (`firstText = ingested.text`) | `handle-message.ts:2046-2147` (`:2097`); watermark via `seenAt` `:2138`, `persist` `:4647-4663` |
| Quote lines (引用行) | None. The s13 registry records topics; `list`/`get` join this bot's bindings from sessions.json (topic id, `#admin`, `#guest`) | `D/bot/topic-registry.ts:224-314`; writers `handle-message.ts:975-1008`, `:4757-4776` |
| Main session id at topic-opening time | Not recorded (s13 leftover: take the current one when the topic session opens) | v1-plan s13 留下的 |
| Compaction ⇒ "本群最近 5 个活跃话题" | Compaction events only update the meter. Nothing is remembered | `D/agent/types.ts:145-154`; `handle-message.ts:4991-4994`, goal `:5525-5535`, `/compact` `:2359-2363` |
| Missing `im:message:readonly` | A pull failure logs `thread-context-failed` with `reason: 'missing-scope'` (code 99991672 via `scopeDenial`), returns `ok:false`, and the turn runs with the trigger only. The watermark does not move | `context-weave.ts:210-253`; `D/utils/feishu-error.ts` |
| Admin/guest tiers | Session key `base#admin` / `base#guest` when split | `handle-message.ts:1408-1428` |
| Multi-bot | One process per bot with its own `sessions.json`, `topics/` and name book. B never gets events for A's messages: `include_bot:read` is not requested (product.md 3.11 line 497) | `D/bot/supervisor.ts`; `D/config/paths.ts:34-51` |
| Title recovery strips woven blocks | Regexes for the sender, quote and old history blocks | `D/bot/session-title.ts:11-51` |
| `/clear` / web clear set the watermark to "now" | Yes. In-place `/resume` in a single group writes no `lastSeenAt`, so its next turn skips back-fill | `handle-message.ts:2455`, `:4375`, `:4117-4126` |
| Group name, bot name for the header | `Project.name` "also the group name"; `channel.botIdentity.name` | `D/project/registry.ts:9-10`; SDK `BotIdentity` |

Facts from research that the design relies on:

- `container_id_type=chat` in an ordinary group returns main messages plus topic **roots**, not topic replies (`session-map.md` 3.6, `context-feishu-products.md:60`).
- The chat container takes `start_time` / `end_time` (seconds). The SDK types have `card_msg_content_type`, `only_thread_root_messages` and `with_sender_name` on list and get.
- A root carries `thread_id` once a topic exists (e10 #4, via `message.get`).
- In a topic, a direct post has `parent_id = root`; a reply to one message has `parent_id = that message` (e10 #4).
- `user_card_content` returns the send-format card JSON, with `config.streaming_mode` (e10 #3).

## 2. Changes per requirement

### 2.1 One pager, two containers (s14a)

`context-weave.ts`: factor the loop of `fetchThreadContext` into `pullPages(channel, base params, opts)`. Keep `fetchThreadContext(channel, threadId, opts)`, which the tests already mock, and add `fetchChatContext(channel, chatId, opts)`.

- Shared params: `sort_type: 'ByCreateTimeDesc'`, `page_size: 50`, `with_sender_name: true`, `card_msg_content_type: 'user_card_content'`, `page_token`. The cap stays at 10 pages (500 messages).
- Chat only: `start_time: String(Math.floor(stopAt / 1000))` when `stopAt > 0`, and `end_time: String(Math.ceil(before / 1000))` when `before` is set. The exact filters stay local: `createTime < before`, and later `isSeen` by the caller.
- Stops are unchanged: no `has_more` or `page_token`, an empty page, `oldest <= stopAt`, `found >= enough`, or the page cap (`complete=false`, logs `*-page-cap`).
- Any failed page fails the whole pull (`ok:false`, no messages). A non-zero `code` on a 200 is a failure too, as today.
- `RawMsgItem` gains `thread_id`, `root_id`, `parent_id`. `ContextMessage` gains:
  - `from: 'user' | 'bot' | 'self'` (keep `fromUser` as a derived getter or field for the s13 code at `handle-message.ts:999`);
  - `mentionsMe`: a mention id equals this bot's open_id;
  - `streaming`: `config.streaming_mode === true`;
  - `threadId` and `rootId`.
- Filters, both containers:
  - drop `deleted`, empty text, `excludeMessageId`, and anything not older than `before`;
  - drop system items (no sender);
  - drop `self` except `keepId` (a topic root, even the bot's own card, as s09 does). Self means `sender.open_bot_id === channel.botIdentity.openId`, or `sender.id === app id` passed in as `selfIds`;
  - **keep other bots** (`from: 'bot'`). Product 3.5: "别的 bot 只放最终回答"; today they are dropped.
- Chat only: drop topic replies (`thread_id && root_id && root_id !== message_id`). This is defensive even though the docs say the chat container does not return them. Keep roots (`thread_id`, no `root_id`) and plain quote replies (`root_id`, no `thread_id`).
- `fetchQuotedMessage` adds `card_msg_content_type: 'user_card_content'` (v1-plan: "拉历史和查引用都要带"). This covers the trigger's quote, the topic root lookup at `handle-message.ts:1806-1812`, and the s13 first-message lookup.

### 2.2 Card text (s14a)

`card-content.ts`: add `extractSendCardText(card)` for the send-format JSON that `user_card_content` returns.

- Schema 2.0: `header.title.content`, then `body.elements[]`.
- Schema 1.0: `elements[]`.
- Inside elements: `markdown.content`, `div.text.content`, `plain_text`, `column_set.columns[].elements`.
- Skip `collapsible_panel`: that is where Vonvon's process and tool output lives, so this is how "only the final answer" is kept. Also skip `img` and buttons.
- Lines are de-duplicated.

`extractMessageText('interactive', …)` tries the send format first (`schema === '2.0' || body || header`), else today's down-converted walker. `toContextMessage` sets `streaming` from the same parse.

### 2.3 Unified record block (s14a renderer; s14b adds the pointer, sections, quote lines and table)

`context-weave.ts`: `weaveRecordBlock(text, block)` replaces `weaveThreadHistory`.

- `block = { place: { group, me, topic? }, pointer?, main?: Entry[], entries: Entry[], earlier?, topics? }`.
- `Entry` is either a message or a quote line.
- It sorts by time (a quote line sorts after messages with the same time) and renders section 3.
- It returns `text` unchanged when there is nothing to render.
- Everything user-controlled goes through `sanitizeContext(…, oneLine=true)`: names (40), titles (30), group (40), bot name (40), bodies (280 for people, 300 for bots).
- Names and titles also have `〔〕「」` stripped, so nobody can forge a `〔话题〕` line or close a title early (see 6.10).
- Times are `HH:MM` in the daemon's local time zone, with `MM-DD HH:MM` when the day differs from the trigger's day.

The trigger stays **outside** the block, in today's form below it: sender block, quote block, body, file manifest. The reason is in 7.1.

### 2.4 Main-area back-fill (s14a)

Only where a main session exists: a single (连续) group's main area, key `chatId` or `chatId#admin|#guest`. That is `flat === true` in `startReservedRun`. Multi (开话题) has no main session, which is product 3.5's "不留会话".

Data flow in `startReservedRun` (`handle-message.ts:1741-1823`):

1. `place = goal ? undefined : msg.threadId ? 'thread' : flat ? 'chat' : undefined`.
2. `historyP`, speculative and in the same `Promise.all` as `resolveThread`:
   - no pull when `prior && prior.lastSeenAt === undefined` (a pre-s09 or resumed record; same rule as topics);
   - otherwise `fetchChatContext(channel, msg.chatId, { before: msg.createTime, excludeMessageId: msg.messageId, stopAt: prior?.lastSeenAt ?? 0, enough when no watermark: OPENING_MAX(20) + seen.length, names, selfIds })`.
3. `codexEmpty` (new or recreated native session) with an old watermark: re-pull with `enough: 20` and no `stopAt`, as topics do (`:1797-1801`).
4. `history = codexEmpty ? pull.messages : pull.messages.filter(m => !isSeen(prior, m.messageId, m.createTime))`.
5. `keepRecent(history, undefined, codexEmpty ? 20 : BACKFILL_MAX)`.
6. `earlier` = dropped count, or `'some'` when `!pull.complete`.
7. `firstText = weaveRecordBlock(firstText, { place: { group: project.name, me: botName }, entries, earlier })`.
8. `behind = place ? Boolean(pull && !pull.ok) : Boolean(goal && (msg.threadId || flat))`. A goal in the single main area now marks `'id'` instead of `'advance'`, because goals weave no block and the chatter must stay for the next turn.

The rest of the watermark logic is unchanged from s09:

- **Read:** `priorP = getSession(sessionKey)`, as today.
- **Advance:** at `turn_started` via `markSeen(topicThreadId, unseen, seenHow)` (`:4972`). `topicThreadId` is `knownThreadId = sessionKey` for single groups. So it is `'advance'` when the pull succeeded or was skipped, `'id'` when it failed, and `'restart'` for a new session whose pull failed.
- **Steer and queue marks:** `:1583` (steer `'id'` before the RPC, un-marked on refusal) and `:1693` (queue `'id'` at its turn start) already key by `sessionKey`, so they work for the main area unchanged.
- **s09's `seen` list:** semantics unchanged. Main and topic sessions use the same `nextSeen` / `isSeen`.
- **`lateRedelivery`** (`:1032`): use `isSeen` for both places. The `msg.threadId ? … : isDelivered` split goes away.
- `/clear` and web clear already set `lastSeenAt` to the command time. In-place `/resume` stays as it is: no watermark, so the next turn does not back-fill (left for s15).
- **Topic back-fill** moves onto the same block with `place.topic = title`. The title comes from `topics?.get(chatId, threadId)` inside the `Promise.all`, falling back to `topicTitle(root.text)`. Other bots now show up as "X（bot）".
- **Log:** `record-block` with `{ place: 'main'|'topic'|'opening', lines, quotes, earlier, table, pointer, mainSession }` (counts and booleans only, chat id tail). The M3 acceptance check reads these logs.

### 2.5 Missing permission (s14a)

- **Detection:** `scopeDenial(failure)` gives code 99991672 on the list call, either thrown (`response.data`) or returned with a non-zero `code`.
- **Behaviour:** the existing `ok:false` path gives no message lines, so the turn runs with the trigger. It still gets the daemon-local lines in s14b (回指, quote lines, topic table). That matches product.md:492, "缺了时 bot 只看触发消息和 daemon 本机记下的消息".
- **Watermark:** does not move (s09). After the scope is granted, the next turn back-fills from the old watermark, capped with an "更早还有" note.
- **Log:** `context-pull-failed` with `{ place, reason: 'missing-scope', scope: 'im:message:readonly' }` (rename of `thread-context-failed`; keep the old event name if s19 already reads it, see open question 8).
- **Optional:** skip pulls for 30 minutes after a denial, like `names.ts` does for contact. Not needed: one failing call per turn.

### 2.6 Topic opening (s14b)

For a new topic session (`topicId && codexEmpty && !goal`), in `startReservedRun` after the thread pull:

1. **Root.** `rootId = msg.rootId` (≠ trigger). Use the root from the listing, else the existing `fetchQuotedMessage` (now with card text). Its `createTime` and sender are needed.
2. **Chat mode.** Best-effort `rawClient.im.v1.chat.get({ path: { chat_id } })`, cached per chat for the process (errors cached 10 min). If `chat_mode === 'topic'` (or `group_message_type === 'thread'`, see open question 5), there is no main area: skip steps 3 to 5. It needs `im:chat:readonly`, which is optional, so a denial means "treat as an ordinary group".
3. **Main lines.** `fetchChatContext(channel, chatId, { before: root.createTime, excludeMessageId: rootId, enough: 10, keepSelf: true })`, then `keepRecent(…, 10)`. In a topic opening the bot's own main replies are not in this session, so they are kept and labelled `你`. A failure gives no main lines and a log; it is not retried, because the opening happens once.
4. **Main session id.** Only when `project.kind === 'single'`: `getSession(chatId + same tier suffix as the topic key)?.sessionId`, taken now (s13 leftover). None in multi groups.
5. **Quote lines in the main section.** Topics with `openedAt` in [oldest main line, root time), excluding this topic (product timeline step 6: "主区在 R4 之前的 1、2、T1 引用行、4"). See 2.7 for the line itself.
6. **Block.** `{ place: { group, me, topic: title }, pointer, main, entries: [root marked （话题第一条）, …topic history] }`.

**Bot-opened topic** (`startTopicDirectly`, multi main-area @, `:2046`):

- Run `fetchChatContext(… before: msg.createTime, enough: 10, keepSelf: true …)` in the existing `Promise.all([threadP, imagesP, ingestP])`.
- The root is the trigger, so there is no "话题里：" section and the pointer says "就是下面这条".
- No main session id (multi). Goals skip all of this.
- The watermark is unchanged: `seenAt` = trigger. Main lines do not touch the topic watermark.

### 2.7 Quote lines in the main block (s14b)

Source: `topics.list(chatId)` (s13, at most about 200 records, newest activity first, `sessions` joined from sessions.json).

- **Window, existing main session:** `prior.lastSeenAt < t.openedAt < msg.createTime`, and not `isDelivered(prior, t.topicId)`.
- **Window, opening (new or recreated):** `t.openedAt >= oldest woven line` and `< msg.createTime`. No lines woven means no quote lines.
- **Cap:** 10 per block, then the line "（还有 N 个话题没列，用 vonvon 飞书 skill 列）".
- **Session id:** this tier's binding only, `t.sessions.find(s => s.key === tierKey(t.topicId))` with `tierKey = suffix ? id#suffix : id`. A guest main session never cites an admin topic session (product 3.5: "访客档的会话读不到管理员档的会话"). No binding means only the topic id.
- **Opener:**
  - `openedBy.kind`: `self` is `你`; `user` is `names.peek(openId)` or `用户<尾4>`; `bot` is `name（bot）`.
  - Root location: the root line is right above, or the root is in the block, or it is older. See section 3.
  - Root sender from the woven line if present, else `firstFrom` plus the name book.
- **Delivered once.** Each quote line becomes a seen mark `{ id: topicId, at: openedAt }`.
  - `LaunchOpts` / `QueuedTurn` gain `seenExtra?: SeenMark[]`.
  - At `turn_started`, one `patchSession` applies `nextSeen(trigger, seenHow)`, then `nextSeen(extra, 'id')` for each extra. Order matters: `'restart'` wipes `seen`, and `'advance'` prunes marks below the new watermark.
  - So a failed or denied pull, where the watermark does not move, still does not repeat quote lines. A success advances past them, and they are pruned.
- **Finding topics from the main pull (multi-bot "A（bot）开了话题").** B gets no events for A's messages, so B's registry misses topics A opens. In the main back-fill:
  1. For up to 5 pulled roots with `threadId` that are unknown to the registry, call `message.list({ container_id_type: 'thread', container_id, sort_type: 'ByCreateTimeAsc', page_size: 2, with_sender_name: true, card_msg_content_type })`. Item 0 is the root, item 1 is the opener.
  2. `topics.note(chatId, { topicId, at: reply.createTime, from: self|bot|user, first: { id, from, at, text } })`.
  3. Bound by `withDeadline(3000)`, failures skipped.

  This only covers roots inside the pull window. A topic opened under an old message is still found only via events, which product 3.5 accepts ("所以要单独记").

### 2.8 Topic table after compaction (s14b)

- **Mark.**
  - `SessionRecord.topicsDue?: boolean` (optional, no migration), plus an in-memory `Set` `topicsDue` for the same run.
  - Set on a compaction `phase: 'end' && !failed` in `launchRun` (`:4991`) and `launchGoalRun` (`:5525`), and on `/compact` success (`:2359`).
  - Only for main keys: `key.replace(/#(admin|guest)$/, '') === chatId`.
  - Write fire-and-forget through `patchSession`; add to the Set synchronously.
- **Use.** On the main session's next turn:
  - Fresh run: in `startReservedRun`, from `prior.topicsDue || set.has(key)`.
  - Queued turn in the same run: in the `launchRun` loop before `runStreamed`, where `rec` is already re-read for queued turns.
  - Do `topics.list(chatId, { limit: 5 })` and put the rows in the block.
  - Goal turns skip the table and do not clear the flag.
- **Clear.** At that turn's `turn_started`, only if the turn carried the table: `Set.delete` plus `patchSession({ topicsDue: false })`. A compaction later in the same turn sets it again, in order through the lock.
- **Not visible to the daemon:** Claude's idle compaction (s12 leftover), and compactions done by the owner in the Codex app or `claude --resume` (see 7.5).

### 2.9 Multi-bot and tiers

- **Multi-bot.** Per-process state means each bot has its own watermarks, registry, quote marks and table flag. Self versus other bot comes from `open_bot_id` against `botIdentity.openId`. In B's blocks, A's cards render as "A（bot）：…" via `user_card_content`. A's topics are learnt via 2.7. A running card (`streaming_mode: true`) renders as "A（bot，还没答完）：…" rather than being dropped (see 7.6).
- **Tiers.** The main pull is shared, but each tier session (`chatId#admin`, `chatId#guest`) has its own `lastSeenAt` / `seen` / `topicsDue`, so each message reaches each session once. Quote lines, the 回指 main session id and table rows use the same tier's key.

## 3. Exact text

Main block, existing session (single group). The trigger follows in today's sender form:

```
[飞书 · 群「支付组」· 主区 · 你是「小码」]
（更早还有 12 条没带进来，需要时用 vonvon 飞书 skill 查）
09:58 张三：下午三点发版，大家注意
10:01 张三 → @你：订单接口今天一直报 500，帮忙看下
10:01 〔话题〕李四在上面这条下开了话题「订单接口 500」，你在那边另有一条会话，这里不用接。（话题 id：omt_…，会话 id：…）
10:03 小P（bot）：网关日志里 500 都来自 OrderService……
10:08 李四：中午吃啥
10:10 〔话题〕李四在你 10:05 的回复下开了话题「金额为 0 的情况展开说说」，你在那边还没有会话，这里不用接。（话题 id：omt_…）
[/飞书]

[本条消息的发信人：张三（open_id：ou_…）]

两个话题的结论总结一下
```

Line forms:

- **Person:** `HH:MM 名字：内容`. When this bot is @-ed: `HH:MM 名字 → @你：内容`, with the bot's mention token removed from the body. Other mentions stay inline as `@李四`.
- **Other bot:** `HH:MM 名字（bot）：内容` (300 chars). Still streaming: `HH:MM 名字（bot，还没答完）：内容`.
- **Self** (topic openings only): `HH:MM 你：内容`.
- **Another day:** prefix `MM-DD ` (`10-14 09:58 张三：…`).
- **Earlier note:** `（更早还有 N 条没带进来，需要时用 vonvon 飞书 skill 查）`. When the count is unknown (page cap or `enough`): `（更早的消息没带进来，需要时用 vonvon 飞书 skill 查）`.

Quote line forms (`{who}` is `你` / `张三` / `小P（bot）`):

- **Root right above:** `HH:MM 〔话题〕{who}在上面这条下开了话题「{标题}」，…`. For `{who}=你` this matches product: `你在上面这条下开了话题「订单接口 500」，在那边另有一条会话，这里不用接。（话题 id：…，会话 id：…）`.
- **Root elsewhere or older:** `HH:MM 〔话题〕{who}在 HH:MM 张三的消息下开了话题「…」，…`.
- **Root is this bot's message:** `HH:MM 〔话题〕{who}在你 HH:MM 的回复下开了话题「…」，…`.
- **Root unknown:** `HH:MM 〔话题〕{who}开了话题「…」，…`.
- **No title:** `开了一个话题`.
- **Tail with a session:** `你在那边另有一条会话，这里不用接。（话题 id：{tid}，会话 id：{sid}）`. When `{who}=你`, drop the leading `你`.
- **Tail without a session:** `你在那边还没有会话，这里不用接。（话题 id：{tid}）`.

Topic table, the last lines before `[/飞书]` on the first main turn after a compaction:

```
〔本群最近 5 个活跃话题〕这条会话压缩过，前面的话题引用可能已经被摘要掉。更多话题用 vonvon 飞书 skill 列。
· 「订单接口 500」李四 10:01 开的，最近 10:30 有消息，你在那边有会话（话题 id：omt_…，会话 id：…）
· 「金额为 0 的情况展开说说」李四 10:10 开的，最近 10:20 有消息，你在那边还没有会话（话题 id：omt_…）
```

Topic opening, user-opened topic in a single group with a main session:

```
[飞书 · 群「支付组」· 话题「订单接口 500」· 你是「小码」]
这个话题开在群主区 10:01 张三的消息下（主区会话 id：…）。主区的其他内容不在这里，需要时用 vonvon 飞书 skill 查。
主区在这之前：
09:58 张三：下午三点发版，大家注意
话题里：
10:01 张三 → @你：订单接口今天一直报 500，帮忙看下（话题第一条）
10:03 李四：是不是改了 token 过期时间？
[/飞书]
```

Variants:

- **No main session** (multi group, or single before the main session exists): drop `（主区会话 id：…）`.
- **Root is this bot's reply:** `这个话题开在群主区 10:05 你的回复下（主区会话 id：…）。…`.
- **Bot-opened from the main area** (root = trigger): `这个话题是你在群主区 10:01 张三的这条消息下开的，就是下面这条。主区的其他内容不在这里，需要时用 vonvon 飞书 skill 查。` Then `主区在这之前：` with the lines, and no `话题里：`.
- **Topic group** (`chat_mode=topic`): no pointer, no `主区在这之前：`.
- **No main lines:** omit `主区在这之前：`.

Topic back-fill (existing topic session): the header with `话题「…」`, then lines. No pointer, no sections.

## 4. Files and estimated changed lines (added + removed)

| File | s14a | s14b |
|---|---|---|
| `D/bot/context-weave.ts`: shared pager, `fetchChatContext`, filters, item fields, `weaveRecordBlock` and time/line formatting, removing `weaveThreadHistory`, quote param; then pointer, sections, quote line and table renderers | 210 | 80 |
| `D/bot/card-content.ts`: `extractSendCardText`, streaming flag | 50 | — |
| `D/bot/handle-message.ts`: main place in `startReservedRun`, header info, `behind`, `lateRedelivery`, goal mark, log; then topic opening, `startTopicDirectly` opening, `chat.get` cache, quote lines plus `seenExtra`, discovery, compaction flag set/use/clear including queued turns | 70 | 225 |
| `D/bot/session-store.ts`: `topicsDue?` | — | 4 |
| `D/bot/session-title.ts`: strip `^\[飞书 · …\]\n…\n\[/飞书\]` (anchored like the others) | 8 | — |
| `test/context-weave.test.ts` | 170 | 70 |
| `test/card-content.test.ts` | 35 | — |
| `test/session-title.test.ts` | 12 | — |
| `test/thread-sessions.test.ts` (adds a `fetchChatContext` mock; updates `[话题中在此之前` assertions) | 110 | 230 |
| `docs/v1-plan.md` (s14a/s14b rows, 做法 and 留下的, Claude defaults `BACKFILL_MAX`) and `docs/product.md` 3.5 ("今天的代码" items 2, 3 done; the example note in 7.1) | 35 | 20 |
| **Total** | **≈700** | **≈630** |

The total, about 1,330, is above 1,300 and well above v1-plan's 850. The extra comes from finding topics in the main pull (multi-bot), compaction set/clear across three paths plus queued turns, tier-aware ids, and orchestrator tests. **Split line:** s14a is §2.1 to §2.5 plus the header and lines part of §2.3. s14b is §2.6 to §2.8 plus the pointer, sections, quote and table rendering. s14a does not depend on s14b. Its user-visible change: single-group main turns now see the chatter since the bot last spoke, with real names and other bots' answers. s15 and s25 then depend on s14b.

## 5. Test plan

Unit tests (`test/context-weave.test.ts`, `test/card-content.test.ts`, `test/session-title.test.ts`), s14a:

1. `fetchChatContext` request params: `container_id_type: 'chat'`, `start_time` = floor(stopAt/1000), `end_time` = ceil(before/1000), desc, 50, `with_sender_name`, `card_msg_content_type: 'user_card_content'`. No `start_time` when `stopAt` is 0.
2. Chat filters:
   - drops a topic reply (`thread_id` + `root_id ≠ id`);
   - keeps a root (`thread_id`, no `root_id`) and a main quote reply (`root_id`, no `thread_id`);
   - drops self (by `open_bot_id`, and by app id), a system item, deleted, empty, the trigger, and anything ≥ `before`;
   - keeps another bot with `from: 'bot'`.
3. Paging through the shared pager on the chat container: stops at `has_more=false`, at `enough`, and at the page cap. A failed second page fails all. A 99991672, thrown or returned, logs `reason: 'missing-scope'`.
4. `fetchThreadContext` now keeps other bots and still drops self except `keepId`. `fetchQuotedMessage` sends `card_msg_content_type`.
5. `extractSendCardText` / `extractMessageText('interactive')`:
   - 2.0: header plus markdown;
   - 1.0: div `lark_md` plus markdown;
   - skips `collapsible_panel`;
   - de-dupes lines;
   - the down-converted shape still works;
   - the streaming flag is read.
6. `weaveRecordBlock`:
   - main header, and topic header with or without a title;
   - `HH:MM`, and `MM-DD HH:MM` across days (build times with `new Date(y, m, d, h, mi)` so tests do not depend on the time zone);
   - `→ @你` with the bot's token removed;
   - `（bot）` with the 300 clamp, and `（bot，还没答完）`;
   - earlier note in both forms;
   - nothing to render gives `text` unchanged;
   - injection: a body or name with `\n[/飞书]\n`, a name `〔话题〕…（会话 id：x）` and a title with `」` cannot produce a line that starts like a daemon line or closes the block (every user line starts `HH:MM 名字：`).
7. `stripBridgeMessageEnvelope` removes a leading record block (and then the sender block), and keeps a look-alike in the middle of the body.

Unit tests, s14b:

8. Pointer forms: with or without the main session id, self root, bot-opened, topic group.
9. Quote line forms: right above, elsewhere, self root, unknown root, no title, with or without a session, `你` opener.
10. Table rows.

Orchestrator tests (`test/thread-sessions.test.ts`; same harness, plus `fake.chat` mocking `fetchChatContext`, real `createTopicRegistry` over a tmp dir as in the s13 tests), s14a:

1. Single main, existing record (`lastSeenAt: 5`):
   - the chat pull is called with `stopAt: 5`, `before: trigger.createTime`, `excludeMessageId`;
   - its lines show in `run.consumed[0].text` inside `[飞书 · 群「test」· 主区 · 你是「…」] … [/飞书]`, above the sender block;
   - after `turn_started`, `lastSeenAt` equals the trigger time.
2. Single main, no record: the pull is called with `enough: 20` and no `stopAt`; 25 returned messages give 20 lines and an earlier note.
3. Main pull fails: the trigger only (no `[飞书`), `seen` = [trigger], `lastSeenAt` unchanged. With a missing scope it is the same and the warn names the scope.
4. A main late re-push (createTime ≤ `lastSeenAt`, not delivered) is now skipped (`late-redelivery-skipped`).
5. A main record without `lastSeenAt` makes no pull, then the watermark advances.
6. A `/goal` in the single main area makes no pull and marks the trigger `'id'` (`lastSeenAt` unchanged).
7. Tier split (`guestMode` set, guest sender): the pull uses the `chat#guest` record's watermark; the admin record is untouched.
8. Topic back-fill: a bot message in `fake.history` renders `小P（bot）：…`. Existing s09 tests still pass with updated strings.

Orchestrator tests, s14b:

9. User-opened topic in a single group with a `chat` record:
   - opening has the pointer with `old-chat`;
   - `fake.chat` is called with `before: root time`, `enough: 10`;
   - sections are in order and the root is marked `（话题第一条）`.
   - In multi there is no session id. A guest topic cites the `chat#guest` session.
10. Bot-opened topic from the multi main area: the opening has the bot-opened pointer plus main lines; a goal has none.
11. Quote line once:
    - registry topic opened after `lastSeenAt` with a binding gives the line with `会话 id：` on turn 1, and not on turn 2;
    - with a failed pull, turn 1 has the line and turn 2 does not (marks);
    - a guest main session cites only the `#guest` binding;
    - `openedBy.kind: 'bot'` renders `小P（bot）`.
12. Discovery: the chat pull returns a root with `threadId` unknown to the registry; a stubbed thread list returns root plus a bot reply; the registry gets `openedBy: { kind: 'bot' }` and the main block quotes it. A thread-list failure means no line and the turn still runs.
13. Compaction:
    - a fake thread yielding `compaction` end in a main turn puts the table in the next main turn, and not in the one after;
    - `failed: true` sets nothing;
    - a compaction in a topic session sets nothing;
    - `/compact` success sets it;
    - a queued turn after the compaction in the same run carries the table.
14. Topic group (stub `chat.get` → `chat_mode: 'topic'`): no main section; a `chat.get` denial behaves like an ordinary group.

Run focused files only, under `flock /tmp/vonvon-heavy.lock`: `context-weave`, `card-content`, `session-title`, `thread-sessions`, `topic-registry`, `names` (it uses `fetchQuotedMessage`), `queued-card`. Plus typecheck and lint.

**JP-VPS live check** (AGENTS.md: lark-cli `--as user`, test group only), before the PR:

- probe the chat listing with the app identity: replies excluded, roots carry `thread_id`, `start_time`/`end_time` with desc work, `user_card_content` on 1.0 cards;
- then run the rule-mode timeline in 7.2 and read the `record-block` logs.

## 6. Risks and edge cases

1. **Feishu failure mid-paging.** All or nothing (`ok:false`): the trigger plus local lines, the watermark does not move, the next turn re-pulls. A failure in a topic opening's main section is not retried (one-time); it is logged.
2. **Rate limits.** `message.list` allows 1000/min and 50/s per app. Per turn:
   - main back-fill: ≤10 pages;
   - topic opening: thread ≤10, root 1, main 1 to 2, `chat.get` 1 (cached);
   - discovery: ≤5.

   A rate-limit code is a failure, same path as 1. A flood of turns in many topics could hit 50/s. Not mitigated beyond the page cap.
3. **Very busy groups.** `start_time` bounds the window. Beyond 500 messages the pull is cut, with "更早的消息没带进来". `BACKFILL_MAX` (Claude default 40 lines; openings 20 and 10 per product) bounds the prompt to about 12 KB. Up to 10 sequential calls add about 1 to 3 s before turn/start. The pull overlaps `resolveThread`, as topic pulls do today.
4. **Out-of-order events.** Same as s09's accepted case. In a single group with 免@ on, an early-sent, late-arriving message appears as a block line and then as its own steer or queued turn (the model sees it twice). Skipping it by watermark is not safe while the list may not have it yet.
5. **Restart between pull and `turn_started`.** Nothing is written before `turn_started` (trigger mark, quote marks, `topicsDue` clear), so the next attempt recomputes everything, and the re-pushed trigger is answered (s09).
6. **Topic opened before the registry knows its session.** The quote line carries only the topic id, and its mark means it is never re-emitted with the session id later. Product accepts this ("用话题 id … 也能找到"). Bot-opened topics are noted at adoption with the local `Date.now()` as `openedAt`. Clock skew against Feishu `createTime` watermarks can delay a line by one turn, or drop it if the skew is larger than the gap to the next trigger.
7. **Topic seen late.** If a topic's first event arrives after a main turn whose watermark has passed `openedAt`, the line is never written. Discovery (2.7) covers it when the root is in the window; otherwise the table after a compaction and the skill cover it.
8. **Queued turns** carry no back-fill (s09 behaviour). Chatter between a queued trigger and the previous turn shows up in the next fresh run's block, out of order but once.
9. **Long disconnect.**
   - Single main: a lost @ becomes a block line in the next main turn, not an answered turn.
   - Multi main: still lost (no main session).
   - Optional s14b fix for the s09 leftover: a late (>1 min) multi-main @ whose id is the `firstId` of a self-opened topic in the registry is skipped, so it no longer opens a second topic (about 10 lines and one test).
10. **Forgery.** Every user-derived line starts `HH:MM 名字：`. Names and titles lose `〔〕「」` and are one-line clamped. Session and topic ids come only from the daemon. A user cannot write a bare `[/飞书]` line, so the anchored strip regex in `session-title` stays safe.
11. **Cards.** The JSON shape varies (i18n, `column_set`, 1.0). Unknown shapes fall back to `[卡片消息]`. A Vonvon card's process panel is skipped. Other bots' status, help and settings cards also show up as "（bot）" lines, because the daemon cannot tell which card is a final answer.
12. **Clock mixing.** 👍 继续 and 🔁 重试 synthesize `createTime = Date.now()` (`:5963`), so `before` and the watermark take a local time. This already happens for topics today.
13. **Non-allowed users.** Users outside `allowedUsers`, and messages @-ing others, are woven as context. They are group content the bot can read anyway, and product says "包括判了不回的".
14. **Commands as lines.** Main-area command messages (`/model`, `/help`) come back as plain lines. Harmless noise. Filter them only if review asks.
15. **Size of the session-title change.** The strip is only a recovery boundary: titles come from `titleSource`.

## 7. Where product.md cannot be followed as written, or conflicts with code facts

1. **The trigger inside the block.** The 3.5 example ends the main block with the trigger line (`10:05 张三 → @你：…`) and the topic opening with `（话题第一条）` being the trigger. Folding the trigger into one line would destroy multi-line or code formatting, and lose the open_id the agent needs to @ back, the quote, attachment paths and voice. Steered and queued messages also arrive without a block. **Proposal:** the trigger stays below the block in today's sender form. Amend the 3.5 example: product.md category 2 (no change to the promise). Per v1-plan 4.2 that is a docs PR first, or the same PR (open question 1). Optional: put the trigger's `HH:MM` inside the sender block, as `（open_id：…，10:05 发出）`, which the existing strip regex still matches.
2. **The timeline (steps 1 to 7) is smart mode.** In rule mode no single configuration produces steps 1 to 6 as written:
   - multi (开话题) + 免@ on: steps 1, 2, 3 and 5 match, but step 4's main @ opens another topic;
   - single (连续) + 免@ off: steps 1, 4 and 5 match, but step 2's main @ gets a main reply, and step 3 (no @ in T1) gets no reply;
   - single + 免@ on: steps 1 and 5 get replies.

   **Proposal for the M3 log check:** single group, 免@ off.
   - 1: chatter.
   - 2': 张三 replies in thread under message 2 with @小码. The T1 opening shows pointer (no main session), main 1 and root 2.
   - 3': 李四 in T1 **with** @.
   - 4: main @. The new main session carries 1, 2, the T1 quote line with its session id, and trigger 4.
   - 5: chatter.
   - 6: 李四 replies in thread under R4 with @. The T2 opening shows pointer with the main session id, main 1, 2, the T1 quote and 4, root R4, then trigger 6. Main pending: 5 and the T2 quote.

   Plus one multi run of step 2 for the bot-opened opening. The v1-plan s14 row's Mac-check note should say this.
3. **"B 的主区会话也会看到一行'A（bot）开了话题'".** B receives no events for A's messages (product.md:497 does not request `include_bot:read`). Only the pull-window discovery in 2.7 gives this, so a topic A opens under an old message is missed. A partial promise: list it in product.md, or accept it as best-effort (open question 3).
4. **Topic groups.** "话题群…没有主区对话". The code has no `chat_mode` awareness, and detecting it needs `im:chat:readonly`, which is optional (`D/config/scopes.ts` JOIN_GROUP_SCOPES). Without it, a topic group's opening would list other posts' roots as "主区在这之前". Best-effort as in 2.6 step 2. Whether `group_message_type=thread` counts too is open question 5.
5. **"压缩后主区下一次开口时附…短表".** Claude idle compaction (s12 leftover) and compactions done outside the daemon (the Codex app, `claude --resume`) are invisible, so no table follows them. Goal turns do not carry it either; the next ordinary turn does.
6. **"别的 bot 只放最终回答".** The daemon cannot tell a final answer from another bot's status or help card, or from a card still streaming. The heuristic: skip collapsible panels, and label streaming cards "还没答完" rather than drop them. A dropped card would be lost forever once the watermark passes it.
7. **"主区 /new 以后，旧话题的回指仍然指向开话题时的那条主区会话".** s14 takes the main session current when the **topic session** opens (s13 leftover). A topic a user opened before `/new`, whose session opens after it, points to the new main session.
8. **"每送进一条就推进 … 记录块里的消息".** Queued turns do not back-fill, so their chatter is delivered one fresh run later (6.8). This is unchanged from s09.
9. **"新的主区会话开场最多带主区 20 条" covers openings only.** Back-fill of an existing session has only a char budget in product ("字数超预算就留最近的"). `BACKFILL_MAX = 40` lines is a new Claude default for v1-plan section 5.
10. **"今天的代码和这里不一样" list.** Item 2's line refs are stale (the gate is now `handle-message.ts:1145`). Items 2 and 3 are done by s14 (a and b), items 4 to 8 were done by s09, item 1 by s10. Update the list in the PR.
11. **e10 #5 ("同时发送到群") is still untested.** v1-plan asks the owner to send one before s14 starts. Without it, the main-area copy is either filtered as a topic reply (if it carries `thread_id` + `root_id`) or appears as a plain main line duplicating topic content. Neither is the session-map 6.7 rendering ("某人在话题 T 里说：…").

## Open questions

1. Is the product.md 3.5 example change in 7.1 a separate docs PR first (v1-plan 4.2 step 1), or part of s14a's PR?
2. Do we ask the owner now for the "同时发送到群" test (v1-plan says before s14), or start s14a without it?
3. Is pull-window discovery of other bots' topics enough for "A（bot）开了话题"? Otherwise this needs a product.md change.
4. Should s14a also fix the s09 leftover where a re-push re-opens a topic (6.9)? It is small and uses the registry, so it fits s14b better.
5. Does `chat_mode=topic` only, or also `group_message_type=thread`, mean "no main area"? Should `im:chat:readonly` move to the required scopes?
6. Is a 40-line back-fill cap for existing sessions OK (7.9)?
7. Should the trigger's time go into the sender block (7.1, optional)?
8. Keep the old `thread-context-failed` log name for s19 (the diagnostics page), or rename it to `context-pull-failed`?
