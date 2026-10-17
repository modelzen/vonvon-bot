# Rakazo 小范围源码检查

2026-10-17，由 Codex 主会话执行。源码固定为 `e55263f5fdfee9b2c48680a78e4487d37b4c04a8`，Vonvon 比较基线为 `bbb329b9a9eef0dd809ee9468e0b6d1b9bf4a769`。原始程序和下方可迁移版本均实际运行，结果为 8 项全部通过。实际运行环境是 Node `v24.21.0`。

程序只导入已经人工阅读的三个纯源码文件，没有安装依赖、运行上游脚本、连接网络、启动应用或调用模型。它检查 HEAD 和已跟踪文件未修改。未跟踪文件不影响检查的含义；运行前仍应阅读所导入的源码。

将下方代码保存为 `rakazo-probes.mjs`，在 Node 24 环境传入固定 checkout 路径：

```sh
node --experimental-strip-types rakazo-probes.mjs /path/to/rakazo
```

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = 'e55263f5fdfee9b2c48680a78e4487d37b4c04a8';
assert.ok(process.argv[2], 'Pass the pinned Rakazo checkout path');
const checkout = resolve(process.argv[2]);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), source);
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout, encoding: 'utf8' }), '');
const load = name => import(pathToFileURL(resolve(checkout, 'packages/core/src', name)).href);
const { resolveGroupTargetBotIds } = await load('group-mentions.ts');
const { approvalEffectKey, stableJsonValue, toolEffectIdempotencyKey } = await load('approval-effect-key.ts');
const { latestAnswerableAskMessageId, resolveAskChoice } = await load('answerable-ask.ts');

const passed = [];
function check(name, run) { run(); passed.push(name); }
const members = [{ id: 'a', name: 'Research' }, { id: 'b', name: 'Review' }];

check('group-everyone-wakes-all', () => assert.deepEqual(
	resolveGroupTargetBotIds({ text: '@everyone hello', members }), ['a', 'b']));
check('group-unmentioned-falls-back-first', () => assert.deepEqual(
	resolveGroupTargetBotIds({ text: 'hello', members }), ['a']));
check('group-typed-id-restricts-to-member', () => assert.deepEqual(
	resolveGroupTargetBotIds({ text: 'hello', members, explicitMentions: ['b', 'outside'] }), ['b']));
check('effect-canonical-argument-order', () => assert.equal(
	approvalEffectKey('run', 'tool', { z: 1, nested: { b: 2, a: 1 } }),
	approvalEffectKey('run', 'tool', { nested: { a: 1, b: 2 }, z: 1 })));
check('effect-distinguishes-live-occurrence', () => assert.notEqual(
	toolEffectIdempotencyKey('run', 'tool', { a: 1 }, 0),
	toolEffectIdempotencyKey('run', 'tool', { a: 1 }, 1)));
check('canonical-json-rejects-non-json-and-cycles', () => {
	for (const value of [NaN, Infinity, undefined, new Date(0), new Array(1)]) {
		assert.throws(() => stableJsonValue(value), TypeError);
	}
	const cyclic = {}; cyclic.self = cyclic;
	assert.throws(() => stableJsonValue(cyclic), TypeError);
});
check('ask-only-waiting-active-run', () => {
	const messages = [
		{ id: 'active-question', runId: 'active', blocks: [{ kind: 'ask', status: 'pending' }] },
		{ id: 'stale-question', runId: 'old', blocks: [{ kind: 'ask', status: 'pending' }] },
	];
	assert.equal(latestAnswerableAskMessageId({ messages, activeRuns: [{ id: 'active', status: 'waiting_input' }] }), 'active-question');
	assert.equal(latestAnswerableAskMessageId({ messages, activeRuns: [{ id: 'active', status: 'completed' }] }), null);
});
check('ask-choice-id-before-normalized-label', () => {
	const actions = [{ id: 'keep', label: ' Keep changes ' }];
	assert.equal(resolveAskChoice(' keep ', actions)?.id, 'keep');
	assert.equal(resolveAskChoice('KEEP CHANGES', actions)?.id, 'keep');
	const collision = [{ id: 'other', label: 'keep' }, ...actions];
	assert.equal(resolveAskChoice('keep', collision)?.id, 'keep');
});
console.log(JSON.stringify({ source: 'e55263f5fdfee9b2c48680a78e4487d37b4c04a8', checks: passed.length, passed }, null, 2));
```

| 检查 | 本次观察 | 能证明的范围 |
|---|---|---|
| `group-everyone-wakes-all` | 选中全部两个成员 | 该点名 helper 的结果，不是所有群 API 的完整行为 |
| `group-unmentioned-falls-back-first` | 选中第一个成员 | 无点名时的局部回落规则 |
| `group-typed-id-restricts-to-member` | 忽略非成员 ID | 显式成员选择，不含权限鉴定 |
| `effect-canonical-argument-order` | 键顺序变化得到相同键 | 规范化参数，不是外部效果只执行一次 |
| `effect-distinguishes-live-occurrence` | 相同参数的不同调用次数得到不同键 | 必须额外维护正确的次数与持久状态 |
| `canonical-json-rejects-non-json-and-cycles` | 拒绝所列非 JSON 值和循环 | 这组边界输入，不是所有任意对象的完整审计 |
| `ask-only-waiting-active-run` | 只选仍等待输入的活动运行 | 不等于 Vonvon 的 FIFO、actor 或卡片授权 |
| `ask-choice-id-before-normalized-label` | ID 与规范化标签均可解析 | 不覆盖同名选项、多问题或真实点击 |

没有运行 Rakazo 全量测试、数据库、Pi 会话、GUI、文件效果恢复、权限边界或真实消息投递。上述结果不能解释为其整体产品已通过验收。

## 核实记录

核实记录（2026-10-17）：独立 gpt-6-astra 直接读取本页 js fenced 程序，经 Node v24.21.0 stdin 运行，固定 checkout HEAD/已跟踪文件检查和全部八项断言均通过，退出码 0。没有安装依赖、启动服务、联网调用模型或读取真实数据。验证范围仅为文中列出的输入与 helper 输出。
