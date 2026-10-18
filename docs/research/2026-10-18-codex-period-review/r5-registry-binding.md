## 补做的独立审查：#382、#383

审查对象：#382（项目表跨进程写入，s36c2c1，合入提交 `bb84270`）和 #383（同群绑定幂等与显式工作区准入，s36c2c2，合入提交 `fae1c32`）。以当前 `origin/main`（`42d98d2`）为准判断问题是否仍在；#384、#385、#388 之后又改过 `registry.ts`、`lifecycle.ts`、`groups.ts` 和 `data-access.ts`，审查按现在的代码看。复现都在 `origin/main` 的 detach 副本里做（副本内 `npm ci`、build protocol/client），跑了 #382/#383 自带的 `project-writers.test.ts`（10 项）、`admin-groups.test.ts` 和我新写的 3 项探针，39 项全过；主仓库和各 worktree 没有改动。

**总结论**：两个 PR 的核心承诺成立。六类项目表修改确实都在 `ownProjects` 里完成"建父目录 → realpath 父目录 → 取 `projects` 内核锁 → 读盘 → 回调/准入 → tmp 写入 + rename → 放锁"，入口在排队前固定了路径和可变输入，错误路径不会留下半写的 `projects.json`（只会留下一个没人读的 `projects.json.tmp-*`）。锁的顺序一致：`joinExistingGroup` 先拿 `bots`（数据根）再拿 `projects`（bot 目录），全仓没有反向持锁路径，不会死锁；持锁期间没有远端请求——`isInChat`、`chat.create`、欢迎卡都在锁外，锁内只有本地文件系统操作（`realpath`、`stat`、`mkdir`、bots 账本发布）。同 chat 同参数重试在同一临界区内判定并原样返回旧记录，不重写、不 mkdir、不重发欢迎；冲突在准备目录前拒绝。显式目录准入只接真实目录，符号链接取 canonical 路径后判定，数据目录本身、它的祖先和 `bots/` 等内部位置拒绝，`projects/` 下允许。没有发现 #382/#383 引入的新缺陷。
确实存在、但不属于这两个 PR 引入的事项有两条，列在下面；另有几处只记不报：`createProject` 的重名检查在锁外、建群在锁内之前，两个入口同时建同名群仍会留下一个远端孤儿群（owner 2026-10-18 已把建群结果恢复移到 v1 之后，#387）；`rename` 失败时 tmp 文件不清理（无害）；`ownProjects` 对不存在的 bot 目录会先 `mkdir`。

### R5-1（中，已复现）桌面端"编辑项目"改 cwd 不走准入，旧记录可以把会话目录改到数据目录里

- 文件：`packages/daemon/src/bot/handle-message.ts`（editProject 分支，`patch.cwd = cwd` 处）；`packages/daemon/src/project/registry.ts` 的 `writeStored`。
- 现象：#383 把"创建"和"绑定新群"的显式目录统一接到 `admitDirectorySettings`，数据目录、`bots/`、普通文件都会被拒。但桌面 RPC `editProject` 改目录时只做 `realpath` + `isDirectory`，直接 `patch.cwd = cwd` 交给 `mutateProject`。`writeStored` 只在该行已有 `directories.workspaces` 时才重新准入，#383 之前绑定的旧记录没有这块，于是旧记录的 cwd 可以被改到数据目录本身或 `bots/` 下，之后该群的会话就在数据目录里跑（完全访问档能读写 `secrets.enc`、`master.key`、其他 bot 的 `config.json`）。
- 复现（副本内 vitest，三条探针全部按"缺陷存在"方向通过）：
  1. 旧记录（无 `directories`）`mutateProject` 把 cwd 改成 `<数据目录>/bots` → 成功写盘；
  2. 同样的改动放到 #383 风格的记录（带 `directories.workspaces`）上 → 被 `Invalid directory settings` 拒绝；
  3. 经 `createOrchestrator(...).collaboration({ action: 'editProject', directory: <数据目录> })` 改旧记录 → 返回 `ok: true`，`projects.json` 里该群的 cwd 变成数据目录根。
  仓库自己的 `desktop-collaboration.test.ts` 夹具也一直用 `cwd: paths.appDir` 建 demo 项目并成功编辑，说明这条路一直没接准入。
- 边界：只有 owner 能调 `editProject`，DM 没有改目录的入口；所以是"同一条准入规则没有覆盖全部写入口"，不是外部可利用的问题。
- 建议：在 editProject 分支里把 `request.directory` 过 `admitDirectorySettings({ workspaces: { primary, additional: [] } }, { dataDir: paths.appDir })`，把返回的 canonical `primary` 同时写进 `patch.cwd` 和 `patch.directories.workspaces`（已有 `directories` 时合并保留 `repositories`），这样旧记录在第一次编辑时也补上声明，之后 `writeStored` 的复核自然生效。约 10 行；再给 `desktop-collaboration.test.ts` 加一条"旧记录改到数据目录被拒"的用例。

### R5-2（低，已复现）准入失败的提示原样把内部英文字段名发给用户

- 文件：`packages/daemon/src/project/lifecycle.ts`（`resolveCwd` 抛 `Invalid directory settings: directories.workspaces.primary`）；`packages/daemon/src/admin/groups.ts`（包成 `AdminWriteError(error.message)`）；`handle-message.ts` 的 `newProjectSubmit`/`joinGroupSubmit` 把 `err.message` 直接填进卡片。
- 现象：用户在私聊卡片或网页选了数据目录、`bots/` 子目录或不存在的路径，看到的是 `Invalid directory settings: directories.workspaces.primary`，既不说哪条路径、也不说为什么不行。#383 自己的测试（`admin-groups.test.ts` "rejects protected explicit workspaces"）就是按这个英文串断言的，说明是有意接受的现状，但它是用户可见的文案，和 PR 描述里"非法路径…拒绝"这条用户可见变化直接相关。
- 建议：在 `resolveCwd`（或 `joinExistingGroup`/`createProject` 捕获处）把 `Invalid directory settings: directories.workspaces.*` 翻成一句中文（"所选文件夹不能是 Vonvon 的数据目录或其内部目录，请换一个"），内部串留在日志。约 5 行。

### 其余核对项（无发现）

- 锁粒度与顺序：`projects` 锁按 bot 目录的 canonical 路径取（Linux 抽象 socket / macOS `.locks/projects.lock`），`bots` 锁按数据根；`withBotGroupBinding → bindProject` 是唯一的嵌套，方向 bots → projects；`removeBot`、`registerBotEntry`、`commitBotCredentialRefresh` 的回调都不碰项目表，`mutateProject`/`updateProject`/`removeProject` 的回调都是同步本地逻辑。
- 持锁期间的 I/O：`writeStored` 的 `admitDirectoryChanges` 在 `repositories` 变化时会在锁内起 `git rev-parse`（每个最多 5 秒），但现在没有任何入口写项目级 `repositories`（s36d 还没做），暂不构成问题；s36d 接线时要注意这一点。
- 读改写：`read` 和 `write` 里的 `readStored` 都在锁内，顶层未知字段和行内未知字段保留；#382 的 8 进程强制交错测试、函数式补丁测试在副本里通过。
- 重试幂等：同 chat 比较 名字、canonical cwd（显式路径一个候选，默认路径按旧 `root/name` 和 #385 分配的目录两个候选）、后端（缺省用当前默认后端补）、会话方式、免 @；不比较 `mode`、`network`、`addedBy`，与 v1-plan "旧记录重试不重写、不覆盖操作者或设置"一致。
- 错误路径：准备失败 / 准入失败 / rename 失败 / 回调抛错都放锁，`projects.json` 要么旧要么新；默认目录分支里 bots 账本可能先于项目行落盘（分配为 ready 但没有项目行），下次重试通过 `allocatedPath` 复用，不重复分配，这是 #385 的设计。
