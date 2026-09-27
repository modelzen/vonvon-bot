import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentViewSchema } from "../desktop/shared/settings";

test("native settings fixture matches the IPC settings contract", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-settings.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => agentViewSchema.parse(fixture));
});
