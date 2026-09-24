const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const home = process.env.VONVON_DESKTOP_TEST_HOME;
if (
  !home ||
  process.env.HOME !== home ||
  process.env.USERPROFILE !== home ||
  !process.env.CODEX_HOME?.startsWith(home)
)
  throw new Error("Native smoke requires isolated home.");
require("../dist/main.cjs");
let finished = false;
let failed = false;
app.on("will-quit", () => {
  if (failed) app.exit(1);
});
const timeout = setTimeout(() => {
  if (!finished) {
    process.stderr.write("Native smoke timeout.\n");
    app.exit(1);
  }
}, 60_000);
async function poll(operation, predicate) {
  for (let index = 0; index < 200; index++) {
    const value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Native smoke condition timed out.");
}
void app
  .whenReady()
  .then(async () => {
    const window = await poll(
      async () => BrowserWindow.getAllWindows()[0],
      (value) => !!value,
    );
    await poll(
      async () => window.webContents.isLoading(),
      (loading) => !loading,
    );
    const snapshot = await poll(
      async () =>
        window.webContents.executeJavaScript(
          "new Promise(resolve=>{let stop;stop=window.bridge.watch(value=>{resolve(value);queueMicrotask(()=>stop?.());});})",
        ),
      (value) => value.host.kind !== "starting",
    );
    await writeFile(
      path.join(home, "native-initial.png"),
      (await window.capturePage()).toPNG(),
    );
    await writeFile(
      path.join(home, "native-initial.json"),
      JSON.stringify(snapshot, null, 2),
    );
    assert.equal(
      snapshot.host.kind,
      "connected",
      JSON.stringify(snapshot.host),
    );
    assert.equal(snapshot.host.ownership, "owned");
    if (process.env.VONVON_DESKTOP_FIXTURE_MODE === "existing") {
      assert.deepEqual(snapshot.agents.map((agent) => agent.id).sort(), [
        "cli_fixture_content",
        "cli_fixture_engineering",
      ]);
      assert.equal(
        snapshot.agents.every((agent) => !agent.enabled),
        true,
      );
      assert.equal(snapshot.groups.length, 2);
      assert.equal(snapshot.memberships.length, 3);
      assert.deepEqual(
        snapshot.memberships.map((member) => member.backend).sort(),
        ["claude-agent", "codex-appserver", "future-runner"],
      );
      assert.equal(
        snapshot.memberships.every(
          (member) => member.directory === path.join(home, "fixture-workspace"),
        ),
        true,
      );
    } else assert.equal(snapshot.agents.length, 0);
    assert.equal(snapshot.stale, false);
    const text = await window.webContents.executeJavaScript(
      "document.body.innerText",
    );
    assert.match(text, /你的 Agent/);
    assert.match(text, /本机环境/);
    assert.doesNotMatch(text, /交互原型|模拟授权|示例数据/);
    const malformed = await window.webContents.executeJavaScript(
      'window.bridge.run({type:"refresh",arbitraryUrl:"https://example.com"}).then(()=>false,()=>true)',
    );
    assert.equal(malformed, true);
    window.close();
    assert.equal(window.isVisible(), false);
    assert.equal(window.isDestroyed(), false);
    window.show();
    await writeFile(
      path.join(home, "native-smoke.png"),
      (await window.capturePage()).toPNG(),
    );
    await writeFile(
      path.join(home, "native-smoke.json"),
      JSON.stringify(
        {
          snapshot,
          visibleText: text,
          malformedDenied: malformed,
          hideToTray: true,
          platform: process.platform,
          arch: process.arch,
          fixtureMode: process.env.VONVON_DESKTOP_FIXTURE_MODE,
          osServiceQueries: process.env.VONVON_OS_QUERIES,
        },
        null,
        2,
      ),
    );
    finished = true;
    clearTimeout(timeout);
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    finished = true;
    clearTimeout(timeout);
    failed = true;
    app.quit();
  });
