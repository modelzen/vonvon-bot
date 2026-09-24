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
    };
    files.set(
      join(home, ".feishu-codex-bridge", "bots.json"),
      JSON.stringify({ version: 1, bots }),
    );
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
