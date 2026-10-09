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
    assert.equal(snapshot.host.version, "0.7.0");
    const settings = request => window.webContents.executeJavaScript(
      `window.bridge.settings(${JSON.stringify(request)})`,
    );
    const hostSettings = await settings({ type: "read", scope: { kind: "host" } });
    assert.equal(hostSettings.kind, "view", JSON.stringify(hostSettings));
    assert.equal(hostSettings.view.scope.kind, "host");
    assert.equal(hostSettings.view.sections.execution.access.kind, "writable");
    const reset = await settings({ type: "save", edit: {
      scope: { kind: "host" }, section: "execution",
      revision: hostSettings.view.sections.execution.revision,
      patch: { codexBin: null },
    } });
    assert.equal(reset.kind, "saved", JSON.stringify(reset));
    assert.equal(reset.result.kind, "saved", JSON.stringify(reset));
    assert.equal(reset.result.section.value.stored.codexBin, null);
    assert.equal(reset.result.effects.some(effect => effect.when === "restart"), true);
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
      const agentScope = { kind: "agent", botId: "cli_fixture_engineering" };
      const agent = await settings({ type: "read", scope: agentScope });
      assert.equal(agent.kind, "view", JSON.stringify(agent));
      assert.equal(agent.view.sections.cards.stored.showToolCalls, false);
      assert.equal(agent.view.sections.run.stored.maxConcurrentRuns, 5);
      assert.equal(agent.view.sections.completion.stored.longTaskMinutes, 7);
      assert.equal(agent.view.sections.cards.access.kind, "readonly");
      const denied = await settings({ type: "save", edit: {
        scope: agentScope, section: "cards",
        revision: agent.view.sections.cards.revision,
        patch: { showToolCalls: true },
      } });
      assert.equal(denied.kind, "saved", JSON.stringify(denied));
      assert.equal(denied.result.kind, "unavailable", JSON.stringify(denied));
      const project = await settings({ type: "read", scope: {
        kind: "project", botId: agentScope.botId, projectName: "产品研发群",
      } });
      assert.equal(project.kind, "view", JSON.stringify(project));
      assert.equal(project.view.sections.compact.stored.autoCompact, false);
      assert.equal(project.view.sections.model.stored.selection.model, "fixture-saved-model");
      const sessions = await settings({ type: "sessions", botId: agentScope.botId, projectName: "产品研发群" });
      assert.equal(sessions.kind, "sessions", JSON.stringify(sessions));
      assert.equal(sessions.sessions.length, 1);
      const session = await settings({ type: "read", scope: {
        kind: "session", botId: agentScope.botId, threadId: sessions.sessions[0].threadId,
      } });
      assert.equal(session.kind, "view", JSON.stringify(session));
      assert.equal(session.view.sections.model.stored.selection.model, "fixture-saved-session-model");
      const engineeringAgent = snapshot.agents.find(agent => agent.id === agentScope.botId);
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.collaboration-agent-list-row')).find(row => row.querySelector('strong').textContent === ${JSON.stringify(engineeringAgent.name)}).click()`);
      await poll(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.collaboration-profile'))"), Boolean);
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('产品研发群') && button.textContent.includes('Codex')).click()`);
      await poll(() => window.webContents.executeJavaScript(`document.querySelector('select[aria-label="选择话题"]')?.options.length`), value => value === 2);
      const layout = await window.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('select[aria-label="选择话题"]');
        select.scrollIntoView();
        const scroll = document.querySelector('.settings-content-scroll');
        const row = select.closest('.ss-row');
        return { clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, labelWidth: row.querySelector('.ss-row__copy').getBoundingClientRect().width, options: [...select.options].map(option => option.textContent) };
      })()`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
      assert.ok(layout.labelWidth > 60, JSON.stringify(layout));
      assert.match(layout.options[1], /^共用 ·/);
      await writeFile(path.join(home, "native-long-topic.png"), (await window.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Bot').click()`);
      await writeFile(path.join(home, "native-settings.json"), JSON.stringify({ hostSettings, reset, agent, denied, project, sessions, session }, null, 2));
    } else assert.equal(snapshot.agents.length, 0);
    assert.equal(snapshot.stale, false);
    const text = await window.webContents.executeJavaScript(
      "document.body.innerText",
    );
    if (snapshot.agents.length) {
      for (const agent of snapshot.agents) assert.ok(text.includes(agent.name), agent.name);
      assert.match(text, /添加 Bot/);
    } else assert.match(text, /邀请你的第一个 Bot/);
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
