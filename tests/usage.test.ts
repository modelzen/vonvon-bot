import { test } from "node:test";
import assert from "node:assert/strict";
import { collaborationReplySchema, collaborationRequestSchema } from "../desktop/shared/collaboration";

const agentId = "cli_fixture";
const groupId = "oc_fixture";

test("usage reply retains activity statistics and daily buckets from Core", () => {
  const reply = collaborationReplySchema.parse({
    kind: "usage",
    data: {
      profile: {
        displayName: "Tester", lifetimeTokens: 120000, peakDailyTokens: 34000,
        currentStreakDays: 3, longestStreakDays: 8, longestTurnSec: 120,
        totalThreads: 24, fastModePct: 50, totalSkillsUsed: 7, uniqueSkillsUsed: 3,
        mostUsedEffort: "high", mostUsedEffortPct: 70,
        topInvocations: [{ name: "review", count: 4, kind: "skill" }],
        dailyBuckets: [{ date: "2026-09-25", tokens: 34000 }], statsAsOf: "2026-09-25",
      },
      usage: { planType: "pro", main: { primary: { usedPercent: 25 } }, extras: [], fetchedAt: 1000 },
    },
  });
  assert.equal(reply.kind, "usage");
  if (reply.kind !== "usage") return;
  assert.equal(reply.data.profile.peakDailyTokens, 34000);
  assert.deepEqual(reply.data.profile.dailyBuckets, [{ date: "2026-09-25", tokens: 34000 }]);
  assert.deepEqual(reply.data.profile.topInvocations, [{ name: "review", count: 4, kind: "skill" }]);
});

test("account usage request has no Agent identity", () => {
  assert.deepEqual(collaborationRequestSchema.parse({action: "usage", force: true}), {action: "usage", force: true});
  assert.equal(collaborationRequestSchema.safeParse({action: "usage", force: false, agentId}).success, false);
});

test("share request accepts Core card sections and rejects unknown choices", () => {
  const request = { action: "shareUsage", agentId, projectName: "Demo", groupId, sections: ["stats", "heatmap"] };
  const parsed = collaborationRequestSchema.parse(request);
  assert.equal(parsed.action, "shareUsage");
  if (parsed.action === "shareUsage") assert.deepEqual(parsed.sections, ["stats", "heatmap"]);
  assert.equal(collaborationRequestSchema.safeParse({ ...request, sections: ["unlisted"] }).success, false);
});
