## 补做的独立审查：#384、#385

审查对象：#384（s36c2c3，已有群的稳定目录与保留恢复，合入提交 0cfc95e）和 #385（s36c2c4a，建群操作记录与跨进程归属，合入提交 898d3c5）。判断以当前 origin/main（42d98d2）为准；两片合入后，相关文件只有 #388 改过 `config/data-access.ts`（删掉旧端口过渡），#366 在 `project/registry.ts` 加了 4 行，都没碰本片的逻辑。复现都在 origin/main 的临时 worktree 里做，测试用隔离的 HOME 和 VONVON_HOME，没联系飞书。

**总结论。** #384 的核心承诺都成立：已有绑定不改 cwd，同参数重试不重写、不另建目录；解绑、删账号再重注册同一账号后，再绑同一群会回到原来的目录，内容还在；旧实例拿着过期的注册身份不能提交；根注册表到项目表的写入顺序和崩溃窗口都有真实子进程测试。原有的 bot-namespace、admin-groups、creation-journal 三份测试在当前 main 上 111 项全过。查出三条仍然存在的问题，都已复现：

- R6-1（中）：现有建群入口仍把默认目录放在 `<项目根>/<群名>`。群名和 bot 的目录名相同时，新群的 cwd 就是 bot 的稳定目录，里面就是 c3 新放的 `groups/`，装着别的群的工作区；群名取 `.` 或 `..` 时，cwd 是项目根或数据目录。
- R6-2（低）：已归属的群目录或 `groups` 容器一旦不在了（用户清理、移走），这个群、甚至这个 bot 的所有群都再也不能用默认目录绑定，报错是英文的 ENOENT，带完整路径。
- R6-3（低）：c3 之前绑定的旧群，解绑后再用默认目录绑定（包括 bot 被移出群后自动解绑、再拉回来），会拿到一个新的空目录，不再回到原来的 `<项目根>/<群名>`；旧会话因为 cwd 变了也续不上。c3 之前私聊默认绑定会回到原目录，这个变化 PR 和 v1-plan 都没写。

#385 的 `creation-journal.ts` 现在没有任何生产调用：生产代码不 import 它，启动时不扫描，不建 `creation-operations/` 目录，不写盘，也不拿锁。留下的只有 `data-access.ts` 里 `MutexRole` 多出的 `'creation'`。#388 已经把 c4a 改过的旧端口过渡整段删掉，creation-journal 的测试在当前 main 上照样通过。没查到 #385 的生产缺陷。s36d1 会复用 c3 的代码，有几处要提前注意，写在最后一节。

复现用的测试文件：`claude-work/retro-review/r6-repro.test.ts`。放进 `packages/daemon/test/` 后，在隔离的 HOME 和 VONVON_HOME 下用 vitest 跑，3 项都通过，也就是三个问题都复现了。

### R6-1（中，#384）建群的默认目录会落到 bot 稳定目录本身，或项目根、数据目录

- 位置：`packages/daemon/src/project/lifecycle.ts:107`（`resolveCwd` 的 `join(projectsRootDir, name)`），调用方是 `createProject`（私聊建群 `handle-message.ts:4111`、网页建群 `handle-message.ts:4984`）。
- 现象：c2b 起，bot 的稳定目录是 `<项目根>/<bot 目录名>`；c3 起，这个目录下又放了 `groups/<群名>/`，装着各群的默认工作区。建群入口还没迁（s36d1 才迁），默认目录仍是 `<项目根>/<群名>`，`mkdir -p` 以后直接标 `blank: true`，不查这个路径是不是已经归属给 bot 或别的群。
- 复现：注册 bot（目录名 `shared`），用默认目录绑定群 Alpha，得到 `projects/shared/groups/Alpha`；再用 `createProject` 建一个叫 `shared` 的群。新群的 cwd 等于 bot 的稳定目录 `projects/shared`，目录列表里就是 `groups`。再建一个叫 `..` 的群，cwd 等于数据目录本身。
- 影响：新群（默认完全访问）的会话从 bot 的主工作区起，cwd 下面就是别的群的工作区。这违反 product.md 3.3"每个群默认有自己的目录"。把这个群改成读写档以后，它的会话还能写进别的群的目录。macOS 默认的文件系统不区分大小写，群名 `Shared` 也会撞上。bot 目录名来自飞书 bot 名，比如"研发助手"，同名的群并不少见。`.`、`..` 让工作区落在项目根或数据目录，违反 product.md 3.6 的"工作区不能是数据目录或它的上级"。`.`、`..` 这一半 c3 之前就有；撞 bot 目录这一半 c2b 就有，c3 把别的群的工作区放进了这个目录，影响扩大了。
- 建议：s36d1 把建群的默认目录改走 c3 的 `planDirectory`，放进 `groups/` 容器，彻底不再用 `join(root, name)`。如果 s36d1 一时合不进来，先在 `resolveCwd` 里加约 15 行的守卫：拒绝 `.`、`..`，并且按 NFKC 加小写比较，拒绝和任一 bot 稳定目录同名的群名。已经这样建出来的旧行，cwd 等于 bot 稳定目录或项目根的，s36d1 的数据迁移里要能识别出来。

### R6-2（低，#384）群目录或 groups 容器不在了以后，默认目录绑定永久失败

- 位置：`packages/daemon/src/config/bot-namespace.ts:150-151`（`ready` 状态先 `realpath`，再比对 inode），以及 `admin/groups.ts:108` 把原始错误原样交给界面。
- 现象：归属记录在解绑、删账号后都保留（这是设计）。可是用户删掉或移走一个已解绑群的目录以后，再用默认目录绑定同一个群，`materializeDirectory` 对 `ready` 记录调 `realpath`，抛出 `ENOENT: no such file or directory, realpath '<…>/groups/Alpha'`，每次重试都一样。容器 `groups/` 不在时，这个 bot 的任何新群用默认目录绑定也都失败。没有恢复入口，只能改选"使用现有目录"。
- 复现：绑定 Alpha，解绑，删掉 `groups/Alpha`，再绑定 Alpha，退出码 1，报上面的 ENOENT，再试一次结果相同。另一个隔离目录里删掉 `groups/`，再绑定新群 Beta，同样失败。改用现有目录绑定 Gamma 正常。
- 为什么不只是"拒绝自动接管"：目录不存在时不涉及接管别人的目录。父目录核对通过后，重新 `mkdir`（0700）再同步，和 `reserved → ready` 的那一步完全一样，不增加接管风险。c3 的测试只覆盖了"目录被换成另一个 inode"和"已有陌生容器"，没覆盖"目录不在了"。
- 影响：清理已解绑群的目录，是用户自然会做的事，不算误操作，可是做完以后这个群就再也用不了默认目录。界面上看到的是带完整路径的英文报错。将来 s49 把私聊的工作区换成 bot 主工作区（也就是 `groups/` 的上级）以后，私聊里的会话也能动到这个目录。s36d1 如果在建群成功之后才分配目录，这个状态还会让建群在远端成功、本地失败。
- 建议：`ready` 记录对应的目录 ENOENT、父目录核对通过时，重新建目录，发布新的 object；容器被重建时，同一次 publish 里把它下面各群记录的 parentIdentity 一起更新，或者把这些记录标回 reserved。另外把 namespace 的错误映射成中文提示，不带绝对路径。约 50 行加测试。

### R6-3（低，#384）旧群解绑后再用默认目录绑定，换成新的空目录，旧会话续不上

- 位置：`packages/daemon/src/project/lifecycle.ts:197-210` 和 `config/bots.ts:171`（只有 c3 记录过的群才有 `allocatedPath`）。
- 现象：c3 之前绑定的群，cwd 是 `<项目根>/<群名>`，项目表里有这一行时，c3 不动它，这一点核对过。可是一旦解绑（私聊里手动解绑，或者 bot 被移出群时 `onBotRemovedFromChat` 自动解绑），这一行就删了，旧 cwd 没有记在任何地方。再用默认目录绑定时，c3 按"新绑定"分配 `groups/<群名>`，得到一个空目录。c3 之前同样的私聊默认绑定走 `resolveCwd` 的 `join(root, name)` 加 `mkdir -p`，会回到原目录（`git show 0cfc95e^:packages/daemon/src/project/lifecycle.ts` 第 193、204 行）。
- 复现：旧 bot 没有稳定目录，项目表里有 `Group → projects/Group`，目录里有 `notes.md`。同参数重绑返回原行，cwd 不变，这一点正确。解绑后再用默认目录绑定，cwd 变成 `projects/legacy/groups/Group`，目录是空的。
- 影响：用户看到的是群的文件"没了"（其实还留在原目录，没人告诉他）。会话记录还在，但 `handle-message.ts:2656` 发现 cwd 变了就新开会话，上下文丢失。PR 描述写的"解绑后重绑同一群应保留内容"只对 c3 之后绑定的群成立，PR 和 v1-plan 都没提旧群的这个变化。
- 建议（二选一）：A. 在 product.md 和 v1-plan 里写明旧群解绑后重绑会换新目录，绑定完成卡显示新目录，并提示"旧文件在 X，可以改选现有目录"。B. 解绑时，cwd 不在 `groups/` 归属里的旧行，留一条 `{chatId, cwd}` 的小记录；再绑定时，网页对话框和私聊卡默认选"使用现有目录"并填上旧路径。B 约 40 行。

### #385：creation-journal 现在没有调用者，留在代码里有没有副作用

- 在 `packages/*/src` 里 grep `creation-journal`、`withCreationJournal`、`creation-operations`，只有它自己。`'creation'` 只出现在 `data-access.ts:9` 的类型联合里。生产代码不 import，启动时不扫描，不建目录，不写盘，不拿锁，所以没有副作用。
- c4a 改过的 `data-access.ts` 旧端口过渡分支，#388 已经整段删除；当前 main 上 creation-journal 的测试照样通过（和 c3 的两份测试合计 111 项全过）。
- 它还算留着的东西：一份 202 行、没有调用者的私有模块，加 467 行测试；文件头写着"Lock order: operation -> bots -> projects"。s36d1 明确不做操作号和恢复入口（v1-plan s36d1 一行），c4b、c4c 已经移到 v1 之后。建议在 s36d1 合入后决定删不删：要留，就在文件头写明"v1 不接入，见 product.md 第 10 节"，免得后面的片误以为它在生效。这不是缺陷，不列为发现。

### 给 s36d1 的提醒（复用 c3 代码时的坑）

1. **归属键要 chatId，建群时拿不到。** `groupAllocationKey` 是 `[appId, tenant, chatId]`，`parseGroupNamespaces` 要求键必须等于它，chatId 必须是 `oc_…`。建群要等 `chat.create` 返回才有 chatId。所以，要么在建群成功后、写项目行之前分配目录（同一次短锁里做完），要么扩展记录格式。如果先建目录、后建群，建群失败会留下空目录，下次同名会被当成"已占用"，目录名就会一路长后缀（`X-<hash>`、`X-<hash>-2`……）。
2. **不要在 `withBotGroupBinding` 里发网络请求。** 它拿的是根目录的 `bots` 互斥锁，所有 bot 进程和 host 共用（`bots.ts:139`，等锁上限 30 秒）。在锁里调 `chat.create`、设管理员、发公告或欢迎卡，会让别的 bot 的注册表写入和启动时的 `ensureRegistry` 等满 30 秒以后报 busy，也会和 s36d1 自己"30 秒总时限"的预算打架。
3. **先修 R6-1、R6-2。** 默认目录必须走 `planDirectory`，不再用 `join(root, name)`，`.`、`..` 也要挡住。R6-2 的状态下（容器或群目录不在了），如果 s36d1 在建群成功之后才分配目录，结果就是远端建好了群、本地保存失败，正是 s36d1 要避免的情况。
4. **错误要分清本地和远端。** namespace 层抛的是英文内部错误，带绝对路径，现在由 `AdminWriteError(error.message)` 原样显示。s36d1 要求"没发出请求时显示原因""发出后结果不明时提示先去飞书看一眼"，本地目录分配失败要明确归到"还没发请求"一类，并翻成中文。
5. **"加入已有的群"按 bot 建的群算。** `joinExistingGroup` 写死了 `origin: 'joined'`，默认档是 `qa`。改的时候注意 `bindProject` 判断"同参数重试"只比名字、cwd、后端、会话方式和免 @，不比档位和 origin，改动不会让旧行在重试时被判成冲突，但也不会更新它们。
6. **身份来源。** 建群入口要拿到 `BotIdentity`。私聊和网页入口都在 orchestrator 里，可以用 `bindingBot`，但它是可选项（测试里构造 orchestrator 时不传），没有时要像绑定一样明确拒绝，不要退回不带身份的写入。

### 复现记录

- 环境：origin/main 42d98d2 的临时 detached worktree，在副本里 `npm ci`，build protocol 和 client；vitest 加 `--maxWorkers=2`，HOME 和 VONVON_HOME 指向临时目录，重命令加 `flock /tmp/vonvon-heavy.lock`。
- 现有测试：`test/creation-journal.test.ts`、`test/bot-namespace.test.ts`、`test/admin-groups.test.ts`，111 项通过。
- 新写的复现：`r6-repro.test.ts`，3 项通过，分别对应 R6-1、R6-2、R6-3。关键输出（路径已去掉临时前缀）：
  - R6-1：`alpha=projects/shared/groups/Alpha`，`created=projects/shared`（等于 `botRoot`），`listing=['groups']`；`..` 的 cwd 等于数据目录本身。
  - R6-2：重绑 Alpha 和新绑 Beta 都是退出码 1，报 `ENOENT … realpath '…/groups/Alpha'`、`'…/groups'`；用现有目录绑定 Gamma 正常。
  - R6-3：`same=projects/Group`（原行不变），解绑后 `again=projects/legacy/groups/Group`，目录为空。
