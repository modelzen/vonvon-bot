## 补做的独立审查：#379、#381

审查对象：#379（s36c2a，并发注册不丢 bot、统一注册与账号写入，合入提交 bbb329b）和 #381（s36c2b，稳定 bot 目录与默认工作区，合入提交 74d9160）的代码部分。#381 里改 product.md 的部分不在本次范围。判断以当前 origin/main（42d98d2）为准，#382、#384、#385、#388 之后对同一批文件的改动也一起看了。

总结论：#379 的跨进程写入归属是对的。现在 bots.json 只有 `config/bots.ts` 一个写入者，所有修改都走 `ownBots`，也就是进程内排队加内核互斥 `bots`，锁里先读盘再改。启停按目标做增量修改。删除和刷新凭据都核对同一次注册的身份（createdAt 加 registrationId）。锁的顺序固定为 bots 在前、keystore 在后，没找到反过来拿锁的路径。临时文件名唯一，不会再出现修复前的 ENOENT 和丢写。旧单 bot 布局的迁移也挪进了锁里。这部分没找到要报的缺陷。

#381 的账本写入顺序没有问题：先记 reserved，再建目录，再记 ready，最后提交账号。名字在锁内选，已删除 bot 的句柄也算占用，目录名碰撞时加 sha8 后缀，比较时忽略大小写和 Unicode 写法差异（NFKC 加小写）。但它把 bot 稳定目录放进了所有 bot 共用的 `projects/` 根，旧的建群入口却不知道这些目录已经有主，于是出现目录碰撞（R4-1）。账本把目录的 dev/inode 和绝对路径钉死，碰到"目录不见了"或"目录被换成新 inode"时只能永久失败，没有任何恢复入口（R4-2）。另外，每次写注册表都要 fsync 数据目录的全部既有上级目录，这比 #379 多了一个"每个上级目录都要可读"的前提（R4-3）。

三条都在副本里用真实子进程复现了（假凭据，隔离数据目录，没有调用飞书和模型）。

---

### R4-1（中）新建群的名字和某个 bot 的句柄相同时，群目录落进这个 bot 的稳定目录

- PR：#381。缺陷在 `packages/daemon/src/project/lifecycle.ts` 第 107 行（`resolveCwd` 的 `join(projectsRootDir, name)`），根因是 `config/bot-namespace.ts` 的 `planAllocation`。
- 缺陷：#381 把 bot 的稳定目录分配在 `<projects 根>/<句柄>`，和旧建群入口的默认目录 `<projects 根>/<群名>` 共用同一个父目录。分配时只避开已经存在的目录，事后建群的那一边（`createProject`，私聊建群卡和网页建群都走它）不查账本，直接 `mkdir -p` 然后照用。群名和任一 bot 的句柄相同时，新群的 cwd 就是那个 bot 的主工作区根。这个根下面放着 s36c2c3 给已有群分配的 `groups/<群名>/` 目录。新建群默认是"完全访问"档，于是这个群的会话能读写别的群的工作区，也和 bot 的主工作区（私聊用的就是它）混在一起，违反 product.md 3.3"每个群默认有自己的目录"。所有 bot 共用默认的 projects 根，所以 bot B 建一个和 bot A 句柄同名的群，也会落进 A 的目录，跨 bot 串目录。macOS 默认的 APFS 不分大小写，句柄 `alpha` 和群名 `Alpha` 也会撞上（Linux 上复现不了，这一点是读代码得出的）。
- 复现：注册 bot，句柄 `shared`；绑定一个已有群 `Joined`，得到 `projects/shared/groups/Joined`；再用假 channel 调 `createProject({name:'shared'})`。实际输出是 `namespaceRoot: …/projects/shared  group cwd: …/projects/shared  contents: ['groups']  groups: ['Joined']`，新群的 cwd 和 bot 的稳定目录完全相同。断言 `expect(cwd).not.toBe(namespaceRoot)` 失败。
- 现状：origin/main 上仍然存在。还没合入的 s36d1 分支把 `createProject` 改走了 `withBotGroupBinding`，合入后这个碰撞会消失，但那个分支没有"群名等于 bot 句柄"的回归用例。
- 建议：s36d1 合入时加上这条回归用例（同一个 bot 和跨 bot 各一条），约 30 行。如果 s36d1 还要等，就先在 `resolveCwd` 的默认分支里查 `loadBots().allocations` 里同一父目录下的 namespaceRoot，按忽略大小写比较，碰上了就拒绝或加后缀，约 10 行。

### R4-2（中）bot 稳定目录被删除、被替换或整体换了 inode 后，这个 bot 的默认目录绑定和同 app 重新注册永久失败，没有恢复入口

- PR：#381。代码在 `packages/daemon/src/config/bot-namespace.ts` 的 `materializeDirectory` 和 `validateParent`（当前 main 第 125 到 155 行，ready 分支在第 150 行）。
- 缺陷：账本里 ready 状态的记录钉死了 namespaceRoot 的绝对路径，以及父目录和目录本身的 dev/inode。之后每次复用都要求 realpath 不变、dev/inode 不变，否则直接抛错。以下三种都是正常用户操作，却都会让这个 bot 永久卡住：
  1. 用户删掉了注册时建的空目录 `projects/<句柄>`；
  2. 用户删掉 `projects/` 根，或者它被重新创建过；
  3. 从备份恢复、整机迁移（迁移助理、Time Machine 恢复）、`cp -a` 后换回，路径和内容都一样，只是 inode 变了。

  卡住以后，这个 bot 再绑定使用默认目录的群（s36c2c3 的 `withBotGroupBinding`；s36d1 合入后新建群也走这里）会一直失败，同 app 删除后再注册也一直返回"保存失败"。报错是英文的原始信息（`ENOENT … realpath`、`Namespace parent changed`），不告诉用户该怎么办。仓库里没有任何清理或修复账本的命令或界面，只能手改 bots.json，而 bots.json 的读取又有硬链接数、大小和账本 schema 的严格校验，手改风险很大。v1-plan 说的是"崩溃留下的歧义拒绝自动处理"，可是上面三种都不是崩溃造成的歧义。尤其目录已经不存在的情况，没有任何内容需要保护。#381 自带的测试把"ready 目录缺失时拒绝"和"替换时拒绝"写成了期望行为，所以这是设计上有意为之，但缺少恢复路径，用户看到的结果就是功能坏了。
- 复现（当前 main）：
  - 注册以后删掉空的 `projects/saved`，再绑定群：`Error: ENOENT: no such file or directory, realpath '…/projects/saved'`。删除这个 bot 后用同一个 app 重新注册：`{"ok":false,"code":"persist_failed","reason":"保存失败：ENOENT: no such file or directory, realpath '…/projects/saved'"}`。
  - 删掉整个 `projects/` 后再绑定：`Error: ENOENT: … lstat '…/projects'`。
  - `mv projects projects.bak && cp -a projects.bak projects`（路径和内容都相同）之后再绑定：`Error: Namespace parent changed`。
- 建议：ready 目录不存在、父目录又是已核准的同一路径时，就地重建，更新 object 的身份，因为里面没有内容可以误收编。父目录或目录本身的 inode 变了、但路径和内容都在时，至少给一个明确的中文报错，再给一个显式的修复入口，例如 `vonvon bot repair-dir <bot>`，或者设置页上的一个按钮：按当前路径重新记录身份，或者换一个新目录。永久拒绝不应该是唯一出路。改动约 40 到 80 行，外加对应测试。

### R4-3（低）数据目录或 projects 根的任一上级目录不可读时，所有注册表操作失败，daemon 起不来；这是相对 #379 的回退

- PR：#381。代码在 `packages/daemon/src/config/bot-namespace.ts` 的 `ensureDurableDirectory`（当前 main 第 50 行起），以及 `config/bots.ts` 里 `ownBots` 和 `publish` 对它的调用。
- 缺陷：`ensureDurableDirectory` 从顶层祖先开始逐级 `open(dir,'r')` 再 `fsync`，已经存在的上级目录也不例外。`ownBots` 每次操作都要先走一遍 `ensureDurableDirectory(paths.appDir)`，启动时的 `ensureRegistry`、启停、删除、注册都在内；`publish` 每次也走。打开目录要求有读权限，所以只要数据目录（或者配置的 projects 根）的某个上级只有执行权限，没有读权限，所有注册表操作都会报 EACCES：`vonvon run` 里的 `ensureRegistry` 起不来，网页也不能注册、启停或删除 bot。只有执行权限的上级目录在多用户 Linux 主机上可以见到，比如 `/home` 设成 0711，或者共享盘上的目录。#379 用的是 `mkdir -p` 加 `realpath`，只需要执行权限，同样的布局下能正常工作。这个 fsync 的保证只需要覆盖本次新建的目录和它的直接父目录，对从来没由程序创建过的既有上级做 fsync 没有收益。
- 复现：建 `locked/vh`，把 `locked` 改成 0311（属主只有写和执行权限，没有读权限），以 `VONVON_HOME=locked/vh` 调 `ensureRegistry()`。当前 main 报 `Error: EACCES: permission denied, open '…/locked'`；在 #379 的合入提交 bbb329b 上跑同一个用例，通过。
- 建议：只对本次 `mkdir` 新建的目录及其父目录做 fsync，或者对既有上级目录 fsync 时容忍 EACCES、EPERM、EINVAL，约 5 到 10 行。

---

#### 看过、没有报的

- #379 的锁顺序：注册、刷新和删除都是 bots 在前、keystore 在后，没找到先拿 keystore 再拿 bots 的路径。删除时的 `isRunning` 回调只发 IPC 状态查询，不重入 `ownBots`，进程内不会死锁。
- #379 删除失败的处理：cleanup 失败时保留注册表行，重试时 `removeSecret` 对已经删掉的密钥返回 false，`rm` 带了 force，所以重试可以收敛。keystore 本身坏掉（主密钥权限或属主不对）时删除会一直失败，但那时注册和运行同样失败，不算本片引入的新问题。
- 已删除 bot 的句柄继续占用，`uniqueName` 把它也算进去了，`validateAccountClaim` 在删除前会核对，这和计划一致。没有改名功能，所以不存在 bot 名和账本句柄不一致的入口。
- 旧单 bot 布局的迁移在搬完文件、写 bots.json 之前崩溃，旧 bot 会丢。这是 #379 之前就有的问题，PR 描述里写明了没有改变。
- 跨进程的配置比较不是原子的 CAS，账号涉及多个文件、失败时可能只提交了一部分，bots.json 硬链接或符号链接时拒绝读取。这些 PR 和计划里都写明了，属于设计边界，不另外报。
