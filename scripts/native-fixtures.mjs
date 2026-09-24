import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createNativeFixture(home, mode) {
  if (!["fresh", "existing"].includes(mode))
    throw new Error(`Unknown fixture mode ${mode}.`);
  await mkdir(join(home, ".codex"), { recursive: true });
  const files = new Map();
  if (mode === "existing") {
    const directory = join(home, "fixture-workspace");
    await mkdir(directory, { recursive: true });
    const bots = [
      {
        name: "研发助手",
        botName: "研发助手",
        appId: "cli_fixture_engineering",
        tenant: "feishu",
        createdAt: 1,
        active: false,
      },
      {
        name: "内容助手",
        botName: "内容助手",
        appId: "cli_fixture_content",
        tenant: "feishu",
        createdAt: 2,
        active: false,
      },
    ];
    const project = {
      name: "产品研发群",
      chatId: "oc_fixture_product",
      cwd: directory,
      kind: "multi",
      backend: "codex-appserver",
      blank: false,
      createdAt: 1,
      origin: "joined",
      mode: "qa",
      guestMode: "qa",
      noMention: false,
      network: false,
      autoCompact: false,
      defaultModel: "fixture-saved-model",
      defaultEffort: "high",
      allowedUsers: ["ou_fixture_member"],
      extensionFromOlderVersion: { keep: true },
    };
    files.set(
      join(home, ".feishu-codex-bridge", "bots.json"),
      JSON.stringify({ version: 1, bots }),
    );
    for (const bot of bots) {
      const botDirectory = join(home, ".feishu-codex-bridge", "bots", bot.appId);
      files.set(join(botDirectory, "config.json"), JSON.stringify({
        accounts: { app: { id: bot.appId, tenant: "feishu", secret: { source: "env", id: "VONVON_UNUSED_FIXTURE_SECRET" } } },
        preferences: {
          showToolCalls: false,
          showModel: true,
          maxConcurrentRuns: 5,
          runIdleTimeoutSeconds: 300,
          pendingPolicy: "queue",
          completionReminder: { mode: "long", longTaskMinutes: 7 },
          access: { ownerOpenId: "ou_fixture_owner", admins: ["ou_fixture_admin"], allowedChats: [] },
          sessionTitles: { byBackend: { "codex-appserver": { enabled: true, model: "fixture-custom-title-model", effort: "high" } } },
          cliBridge: { enabled: false, presence: { idleThresholdSeconds: 180, extensionFromOlderVersion: "retain" } },
          extensionFromOlderVersion: { keep: [1, 2, 3] },
        },
        extensionFromOlderVersion: "preserve this raw configuration",
      }));
      files.set(join(botDirectory, "comment-instructions.md"), "请先阅读 {docUrl}，再按原文语言回复。\n");
      files.set(join(botDirectory, "sessions.json"), JSON.stringify({
        version: 2,
        sessions: [{
          threadId: "omt_fixture_topic",
          chatId: project.chatId,
          cwd: directory,
          sessionId: "fixture-agent-session",
          backend: "codex-appserver",
          model: "fixture-saved-session-model",
          effort: "high",
          summary: "升级前保留的话题：" + "较长的实际任务说明需要在设置页面截断显示，".repeat(12),
          createdAt: 1,
          updatedAt: 2,
        }],
      }));
    }
    files.set(
      join(
        home,
        ".feishu-codex-bridge",
        "bots",
        bots[0].appId,
        "projects.json",
      ),
      JSON.stringify({ version: 1, projects: [project] }),
    );
    files.set(
      join(
        home,
        ".feishu-codex-bridge",
        "bots",
        bots[1].appId,
        "projects.json",
      ),
      JSON.stringify({
        version: 1,
        projects: [
          { ...project, backend: "claude-agent" },
          {
            ...project,
            name: "内容讨论群",
            chatId: "oc_fixture_content",
            kind: "single",
            backend: "future-runner",
          },
        ],
      }),
    );
    for (const [path, value] of files) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, value);
    }
  }
  return files;
}
