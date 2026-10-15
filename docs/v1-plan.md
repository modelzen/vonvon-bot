# Vonvon Bot 第一版计划

这份计划把定稿的 `docs/product.md` 拆成里程碑、切片和实验。第一版做什么以 product.md 为准，本文不加它没有的功能，两者冲突时以 product.md 为准。每合入一片，就在本文第 3 节的清单里把它勾掉，写上 PR 号。本文随代码 PR 一起改，不为它另开文档 PR。同时最多两个产品 PR 在飞（`AGENTS.md`），所以切片分两条线做，见本文第 1 节。

切片和实验的 PR 不用 owner 认可：按 `AGENTS.md`，由 Claude 找另一个模型审查、CI 通过后合入。product.md 的修订按本文 4.2 分两类，只有改了承诺或范围的才等 owner。owner 出面的时候：里程碑验收；被叫去做决定；本文第 8 节列的提前准备的事。

写法和 product.md 一样："主人"指 bot 的主人，"owner"指本项目的 owner；`D/` 指 `packages/daemon/src/`。不带"本文"的节号都指 product.md，比如"3.5""第 9 节第 5 项"；本文自己的节写成"本文第 3 节"。行数都是约数，不含 lockfile 和生成文件。

## 1. 两条线和第一片

**两条线。**
- 第一条线按里程碑顺序做，当前里程碑的片做完，就出预览版给 owner 验收。
- 第二条线做依赖已满足、不挡第一条线的片：当前里程碑里能并行的片；下一个里程碑里没有依赖的片，比如 M2 的 s07a（Linux 先行的验收要用）、M3 的 s10、s11、s12、s16；拿掉咖啡一下的 s02b、s02c；M4 之后的迁移准备 s58、s59（本文第 2 节 M10）。尽量挑和第一条线不改同一批文件的片。
- 实验 PR 是纯文档，不占在飞名额，随时可以开（本文第 4 节）。

**第一片是 s01**（v1 计划、改名和第一版权限表），理由有四条：
1. 它本来就要和这份计划一起写：里程碑、切片清单、实验清单、Windows 代码去留，以及 product.md 没写、由 Claude 定的默认值，都在本文里。
2. 小而低风险。s01 约 800 行，其中代码和测试约 300 行，只改文案、权限常量和一处日志，其余是这份计划。
3. 直接推进 M1。新用户扫码时看到的预填名、一键授权里的权限，是 owner 第一次验收最先看到的东西。
4. 后面的片要靠它开工。`im:message:readonly` 进了必需权限，s04 的清单才能检测它，s09、s14 的补拉才有权限；`include_bot` 和 `self_manage` 进了授权链接，s27 和 s53 才用得上。

s01（#295）和 s02（#296）已合入，M1 预览版 2026-10-14 装到了 owner 的 Mac 上。owner 2026-10-15 验收时回了五条反馈：用不了、会出错的地方在 s02a 修，修完再装一版给 owner 复验；同时决定第一版拿掉咖啡一下（s02b、s02c）。M1 复验只等 s02a（#311）和 s02d（Claude 第一轮失败后整群卡住，Claude 在 JP-VPS 上自测时发现），s02b、s02c 不挡出包，放在第二条线上做。复验时 owner 只回了一条：注册完 Bot 默认应该就开启，在 s02e 修；其他没问题，M1 复验就此算过。复验第 4、6、7 步里要在 owner 那台 Mac 上接着做的部分（绑群、@ 新 bot、下载 Claude、在飞书客户端里看运行卡）没有单独再做，并进 M2 预览版的"Codex 先查"和 owner 那一步。实验可以同时开：e01、e02 已在 JP-VPS 上做完（#297），e06 已在 Mac 上做完（#304），e05、e07、e10、e11 已在 JP-VPS 上做完，e10 有两项留给 owner（本文第 4 节）。

**先做功能，界面最后调一轮。** owner 2026-10-15 说界面和交互最后会统一调一轮，现在先把功能做对。各片只修用不了、会出错的地方；界面上的问题先记在这里，排进哪个里程碑由 owner 定：
- 建群对话框，owner 已选的方向：只问群名和用 Codex 还是 Claude，没装或没登录的灰掉；文件夹默认自动建并显示路径，"更多设置"里能改选已有文件夹，会话方式也收进去；建好后跳到这个群的设置页，顶部显示"已建好"和"在飞书打开"；Bot 页和群聊页都有入口，分成"新建飞书群"和"加入已有的群"。
- 建群时只转圈，没有进度文字；对话框和群设置页里会话方式的叫法不一样；选文件夹是应用里的第二层对话框，不是系统的选择器。
- 运行卡里命令那一节的"调用参数"写的是命令说明或工作目录，标签不对；命令输出的换行在飞书里是否保留，要由 owner 在飞书客户端里看一次（M1 验收第 6 步顺带看）。

**Linux 先行。** owner 2026-10-15 说："全部功能都在 server 端，客户端只是壳子"；"mac 上只需要做 mac 上的网页端连到 mac 上 server 的功能验收，成功后把网页端封装为桌面端"。所以先做 daemon、`vonvon` 命令行和网页端，桌面端是包着网页端的壳。
- Claude 在 JP-VPS 上做，也在 JP-VPS 上自己验收：飞书里的聊天步骤用 lark-cli 以 owner 的用户身份做，改设置用 `vonvon` 命令行和无头打开的网页端。命令行验得快，网页端也要验，两条都走。
- Mac 上只验 Mac 的部分：Mac 上的网页端连 Mac 上的 daemon，以及只有 Mac 才有的东西：窗口、托盘、菜单、登录项、launchd、钥匙串、Seatbelt 沙箱。这些都过了，再把网页端封装成桌面端。卡片在飞书客户端里显示成什么样，由 owner 看，Codex 不碰 owner 的飞书客户端（`AGENTS.md`"工具和同步"）。
- 一个里程碑怎么按这个顺序验收，见本文第 7 节。

## 2. 里程碑

"怎么验收"的每一步前面写着谁来做。"Claude 先做"：Claude 在 JP-VPS 上用 lark-cli、`vonvon` 命令行和无头网页端做，默认用那边的测试 bot 和测试群，要用 Mac 上的 bot 时步骤里写明；"Codex 先查"：Codex 在 Mac 上的预览版任务里做。这两种都在通知 owner 之前做完，结果写进通知。"Claude 接着做""Codex 接着查"：要用 owner 刚扫码建的 bot，或者要等 owner 注销再登录，只能排在 owner 那一步后面；owner 做完回一句，Claude 和 Codex 再做，结果写进下一条通知。Codex 接着查时，Claude 往 #322 贴一个新任务，只列这几步，Codex 用装好的 app 做，不重新构建和安装，除非任务写明；Mac 上处理队列的会话已经结束，就请 owner 再转发一次（`AGENTS.md`"工具和同步"）。"owner"只留要人来做的，JP-VPS 上做不了的（比如 lark-cli 的用户授权过期时的聊天步骤，本文第 7 节）也退回 owner，Claude 在通知里写明。"Codex 先查""Codex 接着查"都只在合入后的预览版任务里做；PR 上的 Mac 检查按 `AGENTS.md` 另贴检查任务。顺序和环境见本文第 7 节。

### M0 实验（e01 到 e14）

**给 owner 什么：** 没有要装的东西。product.md 第 9 节要实测的事排成 14 个实验，结果写进 `docs/research/`，清单见本文第 4 节。

**怎么验收：** 不用 owner 验收。实验结果和 product.md 不一致时，按本文 4.2 处理。

### M1 第一个预览版（s01、s02，反馈修复 s02a、s02d、s02e）

**给 owner 什么：** 在自己的 Mac 上装好预览版。预览版用 Mac 钥匙串里的 Developer ID 签名，没有公证，只出 Apple Silicon 包。owner 自己扫码建一个新 bot，开权限和事件订阅、发布；之后进群、绑群、@ 它用 Codex 干活，下载 Claude 再绑第二个群用 Claude 试一次，由 Claude 和 Codex 做，owner 最后在飞书客户端里看一眼运行卡。这是 v2 第一次有人从头扫码建成 bot，也是 Claude 的回合第一次在真机上跑。

通知里写明：Claude 的登录要 owner 事先在终端里用 `claude` 登好。登录检测在 M2 才有，M1 的界面上还看不出 Claude 登没登录。

**怎么验收：** 复验时 owner 要做的：第 1 到 3 步（打开 app、扫码建 bot、开权限和事件并发布），做完回一句；第 6 步里在飞书客户端看一眼 Codex 的运行卡。其余步骤 Claude 和 Codex 做，结果写在通知里。
1. owner：打开预览版任务装好的 Vonvon Bot。旧的 bridge 照常用，两边是不同的飞书应用，互不影响。先别打开"咖啡一下"，它会替换 bridge 正在用的 hook。第一版拿掉了它，s02b 合入后的预览版里就没有了。
2. owner：Bot 页点"注册 Bot"，用手机飞书扫码，确认预填的名字是 Vonvon Bot，然后建好。建好的 Bot 默认已启用，不用再去打开。
3. owner：建好后，注册对话框接着显示"第 2 步 · 开权限"。点"一键开权限"，在飞书开发者后台确认预选好的权限；对话框每 5 秒检测一次，开好后显示"权限已开通"。再点"去首次运行清单"，在飞书开发者后台的"事件与回调"里选长连接，加上事件 `im.message.receive_v1`、`application.bot.menu_v6`、`im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1` 和回调 `card.action.trigger`，创建版本并发布。Bot 设置的"连接与权限"里也有"一键开权限"；旁边的"重新扫码"只换一份凭据，不开权限。
4. Claude 先做：在 JP-VPS 上用测试 bot 走一遍：用 lark-cli 把 bot 加进测试群，网页端出现"已加入"的提示，"查找已经加入的群"也找得到，绑好。Claude 接着做：用 lark-cli 建一个测试群，把 owner 新建的 bot 加进去（bot 的 app_id 由 Codex 从装好的 app 里读出）。Codex 接着查：Vonvon 弹出"已加入 <群名>"的通知时，点"继续绑定"，选一个文件夹。没弹出的话，在 Bot 页点"加入飞书群"，再点"查找已经加入的群"，选这个群；回复里写明通知弹没弹出。群聊页没有绑群的入口。
5. Codex 先查：本机环境页看 Codex 那一行，应该显示找到的 codex。显示"未安装"的话，点"安装托管副本"，装好后显示"codex <版本> 已安装。"。装了托管副本，bot 就先用它，不用自己装的 codex。#296 的检查在隔离 HOME 里这样装过，用的是 `/usr/local/bin` 下的 npm 和 node。
6. Claude 先做：在 JP-VPS 的测试群里 @ 测试 bot 做件小事，用 lark-cli 读出 Codex 运行卡的内容。Claude 接着做：在第 4 步的群里 @ owner 新建的 bot 做件小事，让它跑一条有多行输出的命令，读出运行卡的内容。owner：在飞书客户端里看这张运行卡，显示正常，命令输出的换行还在（本文第 1 节）。
7. Claude 先做：在 JP-VPS 上用 Claude 绑一个测试群，@ 一次。Codex 先查：在本机环境页下载 Claude（0.3.296），显示已安装。Claude 接着做：再建一个测试群，把 owner 新建的 bot 加进去；Codex 接着查：绑定时执行工具选 Claude；Claude 再 @ 一次，读出回复。群绑定后界面上换不了执行工具：`bindGroup` 带 `tool`，群设置页的执行工具只读。

哪一步不对，回一句"第几步、看到了什么"就行，Claude 修好后再装一版。s02a、s02d、s02e 之后的复验按每一步前面的标记分工，Claude 和 Codex 的部分按本文第 7 节做。

### M2 首次运行清单和开机自动运行（s03 到 s08，含 s07a）

**给 owner 什么：** 打开 app 先看到一张首次运行清单（product.md 3.1 第 4 条）：扫码建应用、开权限、长连接、事件订阅、发布、Codex 和 Claude 的版本与登录、登录电脑时自动运行。每一步实时变绿，失败时告诉你怎么做。打开"登录电脑时自动运行"以后，bot 跑在 macOS 的后台服务里，退出 app、注销再登录都在线（3.10）。终端里能用 `vonvon service status` 查看状态。

**怎么验收：** owner 要做的：第 2 步里扫码建第二个 bot、照清单做到全绿，第 4 步里注销再登录，各回一句；第 7 步是建议。其余步骤 Claude 和 Codex 做，结果写在通知里。
1. Codex 先查：打开新装的预览版，清单显示 M1 那个 bot 每一步的状态。
2. owner：再扫码建第二个 bot，只照清单一步步做，直到全部变绿。Claude 接着做：照 M1 第 4 步用 lark-cli 把它加进一个测试群；Codex 接着查：在 app 里绑好这个群；Claude 再 @ 它，能回复。
3. Codex 先查：在清单里打开"登录电脑时自动运行 bot"，然后退出 app。Claude 先做：Codex 退出 app 以后，用 lark-cli 在 M1 的测试群里 @ M1 那个 bot（它跑在 Mac 上），仍然回。Codex 再把 app 打开，留给 owner 做第 2 步。
4. owner：注销再登录，不打开 app。Claude 接着做：用 lark-cli 在 M1 的测试群里 @ M1 那个 bot，仍然回。
5. Codex 先查：终端执行 `vonvon service status`，显示在运行。
6. Codex 先查：在"应用与启动"页关掉"登录电脑时启动"，`vonvon service status` 显示未注册；重新打开后 `vonvon service status` 又显示在运行。第 4 步要靠它，Codex 在回复里写明已经恢复；恢复不了就停下回复，不往下做。
7. owner：建议把第二个 bot 拉进一个真实、低风险的群，日常用起来。之后每个里程碑都在这个群里顺带用，遇到问题随时回一句，越早发现越好。

### M3 群里的上下文（s09 到 s16）

**给 owner 什么：** 群里的对话更像同事（3.5、3.12）：
- bot 叫得出群里人的真名。
- 从主区开的话题里，bot 知道主区刚才在聊什么。连续群里有人开话题，bot 在话题里单独聊，主区那条会话不受影响。
- 话题里补拉完整，不再每轮重复话题第一条。
- `/new` 开新会话，`/resume` 换回去；bot 忙时 `/compact` 自动排队。撤回的消息 bot 不再用。
- 十分钟没有输出才算超时，超时或断网的卡片上有重试按钮。群里其他人也能领 bot 发的文件。
- `/model` 能手填模型 id；运行卡头部一直显示上下文仪表。

**怎么验收：** owner 要做的：第 4 步里在 `/resume` 卡上选回去，第 7 步（请同事领文件）。其余步骤 Claude 和 Codex 先做完，结果写在通知里。

在 M1 的测试群（规则模式，主区开话题）和一个新建的连续群里做：
1. Claude 先做：连续群主区先不 @ 说两句，再 @bot 问"刚才大家在说什么"。在开话题的群里 @bot 开一个话题，问同样的问题。
2. Claude 先做：话题里不 @ 说一句，再 @bot，看它知道你刚说的话、叫得出你的名字。
3. Claude 先做：在连续群里自己开一个话题聊几句，回主区问 bot 话题里的事，它应该不知道。
4. Claude 先做：在连续群里 `/new`，再问之前的事，它不记得。owner：在同一个群里（Claude 以 owner 的身份建的，owner 在群里）发 `/resume`，在卡上选回去，再问，又记得。
5. Claude 先做：让 bot 跑一个两分钟以上没有输出的任务，不会被掐断。
6. Claude 先做：撤回一条 bot 读过的消息，再问它这条消息的内容。
7. owner：请同事点 bot 回答里的文件链接，能领到。

### M4 崩溃恢复、诊断和 Linux 命令行版（s17、s18、s19、s20a、s20b）

**给 owner 什么：**
- 崩溃恢复（3.10）：daemon 或某个 bot 崩溃后自动重启，主人在飞书私聊收到一行原因。10 分钟内崩溃 3 次就停下：网页和桌面端照常打开，诊断页顶上一条红条，带"恢复运行"按钮。只是某一个 bot 反复崩溃时，只停这一个。
- 诊断页（3.1 第 8 条）：按 bot 列出连接状态、Codex 和 Claude 的版本和登录、缺的权限，以及最近没回的消息和原因。
- Linux 命令行版（3.10）：用 npm 安装；`vonvon service install` 装 systemd 用户服务，并处理 linger；`vonvon open --print` 打印 ssh 转发的办法；`vonvon bot add` 在终端里扫码建 bot。Claude 已在 JP-VPS 上走完安装、崩溃重启、停止和卸载，记录在本文第 10 节。

**怎么验收：** owner 要做的：没有必做的步骤，第 4 步有 Linux 机器的话可以自己试。其余步骤 Claude 和 Codex 先做完，结果写在通知里。
1. Claude 先做：终端执行 `vonvon daemon status` 看 PID，再 `kill -9 <PID>`。几秒后 bot 回来，私聊里收到"刚才崩溃过一次"。Codex 先查：在 Mac 的隔离数据目录里做前半，launchd 把 daemon 拉起来；隔离目录里没有 bot，私聊那一半只在 JP-VPS 上看。
2. Claude 先做：10 分钟内再 `kill -9` 两次：诊断页顶上出现红条，群里 @bot 不回。点"恢复运行"后恢复。Codex 先查：Mac 上同样三次以后，网页端和桌面端照常打开，诊断页有红条，点"恢复运行"后恢复。
3. Claude 先做：在诊断页看各 bot 的连接状态和版本；在一个没绑定的群里 @bot，诊断页里能看到没回的原因。
4. Claude 先做：Linux 部分 s20b 已在 JP-VPS 上走完，不用 owner 做；有 Linux 机器的话，owner 可以照本文第 10 节的记录试一次。

### M5 智能模式（s21 到 s23、s25 到 s28）

**给 owner 什么：**（3.4）
- 新建的群默认智能模式：bot 自己判断接不接话、回在主区还是开新话题；进群时说一句"我会读群消息，合适时接话"。
- 多 bot 群里只接对自己说的话：@ 了谁、引用了谁，就谁回；bot 不进别的 bot 的话题；主区命令要 @。
- 同一台 Mac 上几个智能 bot 合成一次判断，只放行一个回复。
- 智能 bot 之间能互相 @，没有真人插话时最多来回 3 轮。
- 群详情页能切换智能或规则模式，改回复方式和"运行中来了消息"。
- 用量页显示判断次数，诊断页显示"不回"的原因。
- 已有的群仍是规则模式，行为不变。

**怎么验收：** owner 要做的：开始前扫码建两个 JP-VPS 用的测试 bot，只要一次（本文第 8 节）。第 1 到 7 步 Claude 先做完，结果写在通知里。

照 product.md 3.4 的例子：同一台 Mac 上至少两个 bot，一个规则模式、一个或两个智能模式，都在一个新建的测试群里。Claude 在 JP-VPS 上做时，三个测试 bot 都跑在 JP-VPS 上，一个规则模式、两个智能模式。
1. Claude 先做：@ 规则模式的 bot 问一句，只有它回。
2. Claude 先做：不 @ 说一个产品问题，比如"下周发布要不要先砍掉导出功能？"，智能 bot 里只有一个开话题回。
3. Claude 先做：说一句闲聊，没人回；诊断页能看到"不回"的原因。
4. Claude 先做：发一条 @所有人，没人回。
5. Claude 先做：在智能 bot 开的话题里，让它 @ 另一个智能 bot 帮忙看，对方会回复；来回 3 轮后停下。
6. Claude 先做：引用某个 bot 的回答说一句，只有它回。
7. Claude 先做：在群详情页把这个群切成规则模式，再切回来；在用量页看判断次数。

### M6 提问卡片、权限档和子 agent（s29 到 s35）

**给 owner 什么：**
- 提问卡片（3.8）：agent 向人提问或请人确认方案时，群里单独发一张写清后果的卡片，@ 能回答的人，只有发起人或管理员能点。等回答期间，这一轮不会被超时杀掉；15 分钟没人答，卡片收成一行结果。直接打字回复也算回答。重启后点旧卡，卡片会说明已失效。
- Claude 的权限档（3.8）：只读、读写档下不再写到工作区以外，关网时连不上网，开网时能用 WebFetch。
- 子 agent（3.9）：Codex 和 Claude 的子 agent 显示在运行卡的子 agent 区，每个能单独停；子 agent 都结束，这张卡才收尾。

**怎么验收：** owner 要做的：第 1 步里在选项卡上选一项，第 4 步（请同事点卡），第 6 步里在飞书客户端看子 agent 区、单独停掉一个。其余步骤 Claude 和 Codex 先做完，结果写在通知里。JP-VPS 上 Claude 的沙箱 2026-10-15 能用了（本文第 7 节），第 1 到 3 步和第 5 步也在 JP-VPS 上做，不再退回 owner；还没用真 bot 的回合从头到尾验过。第 6 步不靠沙箱，可以用一个改成完全访问的 Claude 测试群做，e01 就是在 JP-VPS 上用完全访问档跑通两个并行子 agent 的。
1. Claude 先做：在一个用 Claude、读写档的群里说"先用选项问我用哪种方案，再动手"。群里出现选项卡，用 lark-cli 读出卡片内容。owner：自己说一次，选一项后 bot 接着做。
2. Claude 先做：再来一次，这次直接打字回答。
3. Claude 先做：再来一次，不理它；15 分钟后卡片变成"没人回答"。
4. owner：请同事点一张不是他发起的卡，他会看到提示。
5. Claude 先做：在一个用 Claude 的只读群里，让它往桌面写一个文件；它被拒绝，并说明原因。
6. Claude 先做：让 Codex 和 Claude 各起两个并行的子 agent 做事，用 lark-cli 读出运行卡上的子 agent 区。owner：自己让 bot 起一次并行的子 agent，在飞书客户端里看运行卡上的子 agent 区，单独停掉一个。

### M7 个性、记忆和多工作区（s36、s36b、s37 到 s42）

**给 owner 什么：**（3.2、3.3、3.6）
- Bot 页：能改个性（SOUL.md）、规矩（AGENTS.md）、智能提示词、公共记忆、工作区和代码仓库。
- 群详情页：能给每个群补充或替换个性、换工作区、加仓库，查看和修改本群记忆。
- 把 bot 拉进已有的群，不再弹私聊绑定卡，群里直接能用，默认只读、关网（3.8）。
- 新群不用再选文件夹，自动建在 `~/.vonvon-bot/projects/<bot 名>/groups/<群名>/`。群没设工作区时只用自己的目录，bot 的代码仓库照常带上。
- 说"记住……"以后，卡片上显示"已记到本群记忆"，可以撤销；别的群看不到。
- bot 能同时在多个工作区和代码仓库里干活。
- bot 的会话不再读写你自己 Claude 和 Codex 的自动记忆。

**怎么验收：** owner 要做的：第 5 步里在卡片上点撤销。其余步骤 Claude 和 Codex 先做完，结果写在通知里。第 3 步要读写档：Linux 上的 Codex 只能用完全访问，所以用 Claude 做，Claude 的读写档要沙箱。JP-VPS 上的沙箱 2026-10-15 能用了（本文第 7 节），这一步也在 JP-VPS 上做，不再退回 owner；还没用真 bot 的回合从头到尾验过。
1. Claude 先做：在 Bot 页给一个 bot 写几句个性，比如"说话简短，不客套"；在群里 @ 它，语气变了。
2. Claude 先做：在某个群的详情页给这个群补一句个性，只在这个群生效。
3. Claude 先做：把 bot 拉进一个新建的群：不弹私聊绑定卡，群里 @ 它能回。在群详情页把权限档改成读写，让它写一个文件；到 `~/.vonvon-bot/projects/<bot 名>/groups/<群名>/` 下能找到（JP-VPS 上换成它自己的 `VONVON_HOME`）。
4. Claude 先做：给 bot 加一个本机代码仓库，让它在仓库里改一处，再在工作区里写一个文件。Codex 先查：在 Mac 上加仓库时，目录选择器能选到本机的文件夹。
5. Claude 先做：在一个群里说"记住：发版在周四"，卡片上出现"已记到本群记忆"；去另一个群问什么时候发版，它不知道。owner：自己说一次，点卡片上的撤销，再说一次。
6. Claude 先做：在 Bot 页查看并修改公共记忆，两个群都能用上。

### M8 skill、MCP 和查飞书上下文（s43 到 s48）

**给 owner 什么：** 桌面端有本机 skill 库和 MCP 库（3.6）。skill 可以从 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 或任意文件夹导入；MCP 可以从 Codex、Claude 的配置导入，也可以手填命令或网址。导入后给 bot 启用，在某个群里另外增减。新建的 bot 不再带你的 Claude 个人指令和两家的个人 skill，导入的 bot 不变。Codex 的 `~/.codex/AGENTS.md` 关不掉，新建的 bot 也带着，bot 的指令里写明 bot 自己的规矩优先。bot 能用 vonvon 飞书 skill 查本群的话题和另一条会话（3.5）：在主区问"两个话题的结论"，它去读了再答，卡片上写读了哪些。

**怎么验收：** owner 要做的：第 3 步里扫码新建一个 bot、照清单做到全绿，做完回一句。其余步骤 Claude 和 Codex 做，结果写在通知里。
1. Claude 先做：在 skill 页从 `~/.claude/skills` 导入一个 skill，给 bot 启用，在群里让 bot 用它；在另一个群的详情页把它移除，那个群里就用不上。
2. Claude 先做：从 Codex 配置导入一个 MCP，给 bot 启用，让 bot 调一次。
3. owner：在 Mac 上扫码新建一个 bot，照清单做到全绿。Claude 接着做：照 M1 第 4 步用 lark-cli 把它加进测试群，@ 它问有哪些 skill；Codex 接着查：列出 Mac 上 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 里的 skill 名。bot 的回答里没有这些名字。
4. Claude 先做：照 product.md 3.5 的时间线：在主区开两个话题，各聊几句；回主区 @bot 问"两个话题的结论"。卡片上写着读了 T1、T2 的会话，回答里有两边的内容。

### M9 私聊（s49、s50、s51a、s51b、s51c、s53 到 s57）

**给 owner 什么：**（第 4 节、3.7、第 6 节）
- 主人和管理员私聊 bot，就是正常干活，不再弹管理菜单。私聊默认用读写档，这是本文第 5 节记的默认值，可以在设置页改。
- 别人私聊时，收到一张"在群里 @ 我"的卡片。
- 在私聊里直接说"以后在测试群说话活泼点""给测试群加上某个 skill""把测试群改成读写档""建一个发布群，把我拉进来"，bot 自己改好，回一张写明改了什么的卡片，可以撤销；扩大能力的改动单独标出。
- 飞书应用里另外加的管理员和开发者也能管 bot；设置页标出每个管理员是从飞书来的，还是本机加的。
- 设置页能关掉"聊天改设置"。

**怎么验收：** owner 要做的：第 2 步（请同事私聊 bot），第 3 步里在改动卡片上点撤销，第 6 步（在开发者后台加一个开发者，他来私聊 bot）。其余步骤 Claude 和 Codex 先做完，结果写在通知里。
1. Claude 先做：私聊 bot："在工作区写个脚本统计行数"，它直接干活。
2. owner：请一个不是管理员的同事私聊 bot，他收到一张卡片，上面列着你们都在的群。
3. Claude 先做：在私聊里说"以后在测试群说话活泼点"，收到改动卡片；去测试群看效果。owner：自己在私聊里说一次，点改动卡片上的撤销。
4. Claude 先做：在私聊里说"给测试群加上某个 skill""把测试群改成读写档"，卡片上这两项标成"扩大了 bot 能做的事"。
5. Claude 先做：在私聊里说"建一个发布群，把我拉进来"。
6. owner：在飞书开发者后台给应用加一个开发者，10 分钟内他就能私聊 bot；设置页标出他来自飞书。
7. Claude 先做：在设置页关掉"聊天改设置"，再在私聊里让 bot 改设置，被拒绝。

### M10 从 bridge 迁移（s58 到 s64）

**给 owner 什么：**（第 5 节）桌面端发现 `~/.feishu-codex-bridge` 就显示导入页，页上有预检表，以及"会感到的变化"和"失去"两张清单。点一下就把全部 bot 搬进来：群、话题和旧会话都在；迁来的群用规则模式，沿用原来的设置；bridge 装的咖啡一下 hook 卸掉。任何一步失败都会自动回滚，并重新启动 bridge。迁移之后，误开 bridge 会被拒。bridge 最后一版的分支和 PR 已准备好，发布时间由 owner 定。

s58、s59 不依赖 M3 到 M9，M4 之后就在第二条线上做。s59 的预检先在 Mac 检查任务里用 bridge 数据的副本和隔离的 HOME 跑，不碰 owner 在用的 bridge。

**怎么验收：** owner 要做的：第 1 到 5 步，时间由 owner 定。这五步迁的是每天在用的 bridge 和原来的群，Claude 和 Codex 都不碰；同样的导入 Codex 先在 Mac 的测试用户账号里走一遍（下面这段），结果写在通知里。

Codex 先用隔离的 HOME 和 bridge 数据副本走完整个导入，包括故意失败后的回滚。launchd 的任务按用户账号区分，隔离的 HOME 隔不开：停 bridge、重新启动 bridge 这几步会碰到 owner 账号里同名的任务。所以这一遍和 s61、s62 的 Mac 检查一样，放在 Mac 的测试用户账号里做，不碰 owner 在用的 bridge。之后由 owner 自己定什么时候迁移每天在用的 bridge：
1. owner：打开导入页，看预检表和两张清单。
2. owner：点开始，等回执出现"旧目录不要删，空白项目还在里面"。
3. owner：在原来的几个群里 @bot，照旧回复，话题里的旧会话接得上。
4. owner：在 Claude Code 或 Codex CLI 里触发一次审批，照常在终端里问，飞书私聊里不再收到卡片。
5. owner：在终端手动执行 `feishu-codex-bridge run`，被拒绝。

### M11 公开发布准备（s65、s66、s67）

**给 owner 什么：**（第 8 节）能出签名并公证过的 universal dmg，Intel Mac 也能装；应用里能检查更新并装上新版。npm 包和桌面包的许可证改成闭源（UNLICENSED）。在一台没有 bridge 的 Mac 上，从零安装、扫码、开权限，第一次对话走通，这是第 8 节第 5 条的 Mac 一半。s66 只在要不到 Anthropic 的书面确认时做。

**怎么验收：** owner 要做的：第 1 步里新开一个干净的 macOS 用户装 dmg，第 2 步（从零扫码走清单，到第一次对话）。其余步骤 Codex 在 M11 的预览版任务里先做完，结果写在通知里。

product.md 第 8 节留给 owner 的事，应该已经按本文第 8 节提前办好。开始前还没定的，Claude 用【需要你决定】一次问齐。然后：
1. Codex 先查：从下载地址下载 dmg，用 `spctl --assess --type open --context context:primary-signature` 查 dmg、`spctl --assess --type execute` 查里面的 app，再用 `xcrun stapler validate` 查两者，都通过。命令行下载的文件不带隔离标记，Gatekeeper 不会真的拦一次，所以放不放行只在 owner 这一半看。owner：在 Mac 上新开一个干净的 macOS 用户（没有 bridge），从下载地址装 dmg，Gatekeeper 直接放行。
2. owner：从零走一遍清单：扫码、开权限、事件订阅、发布、登录时启动，然后第一次对话走通。
3. Codex 先查：装一个旧一点的版本，在"应用与启动"页检查更新，装上新版。装回新版后，`vonvon service status` 和装旧版之前一样，Codex 在回复里写明。

## 3. 切片清单

每个里程碑一张表。依赖里 e 开头的是本文第 4 节的实验。风险一栏只列这几类：子进程、并发、关闭清理、错误路径、macOS 原生、数据迁移、合入门禁；带这些的片按 `AGENTS.md` 加一轮多角度审查。Mac 检查写"无"的，桌面上的事在里程碑验收时看。

### M1 第一个预览版

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s01 | v1 计划、改名和第一版权限表 | 建这份计划；扫码预填名、群欢迎卡和提示里残留的 bridge 名字改成 Vonvon Bot 和 vonvon 命令（3.12）；`im:message:readonly` 进必需权限，`include_bot` 和 `self_manage` 进可选组和一键授权链接（3.11）；product.md 开头的修改规则改成本文 4.2 | 800 | — | — | 无（预填名在 M1 验收时看） |
| [x] | s02 | 打包版自带 npm、找得到 Homebrew 装的 Codex、Claude SDK 锁版本 | app 资源里带 npm 11.20.0，下载 Claude SDK 和 `installCodex` 用它，由 daemon 自己的 Node 执行；桌面端起 daemon 时补 PATH；catalog 写死 SDK 0.3.296，下载和"更新"都装它，devDependency 改成精确版本（3.11） | 420 | — | 子进程、macOS 原生 | 从 Finder 打开打包版：找得到 Homebrew 或 npm 装的 codex；下载的 Claude SDK 是 0.3.296，日志里用的是 app 自带的 npm；"安装托管副本"用 Homebrew 的 npm 能装完 Codex |
| [x] | s02a | M1 反馈修复：注册、开权限、复制链接、真实报错 | "添加 Bot"统一叫"注册 Bot"；桌面端只放开本应用页面写剪贴板这一项权限；注册对话框扫码成功后接着"一键开权限"并每 5 秒检测，Bot 设置加"一键开权限"，"重新授权"改名"重新扫码"；桌面端显示 daemon 的真实报错；查已加入的群和绑群时读出飞书的错误码，缺权限说缺哪项并写日志，没名字的群不再让整张列表失败；清单单列读群信息的权限和"机器人进群"事件；"有未保存的修改"里不再能"保存并离开"建出一个群（3.1 第 4 条） | 700 | — | 错误路径、macOS 原生 | 点"复制链接"后能粘贴；bot 没运行时点"查找已加入的群"，显示真实原因而不是"Daemon request failed"（注册后的一键开权限要扫码，M1 复验时看） |
| [x] | s02d | Claude 第一轮没建成会话时整群卡住 | 第一轮在 Claude Code 写下会话记录之前就失败（沙箱缺工具、没登录）时，之后每条消息都报"找不到会话"，要 `/clear` 才好；恢复前先查会话存不存在，不存在就换新会话，运行卡上说一声（3.5） | 60 | — | 错误路径 | 无（JP-VPS 上用 lark-cli 复现过） |
| [x] | s02e | 注册完 Bot 默认启用 | 扫码注册的新 Bot 直接加进活跃集并启动连接，和手动打开"启用 Bot"一样：Bot 不再显示"已停用"或"待生效"，清单的"长连接"一步不再停在"没有启用"；启动失败不让注册失败，界面显示真实的运行和连接状态；"重新扫码"只换凭据，不动启用状态，停用过的 Bot 仍停用（3.1 第 4 条） | 160 | — | 并发、错误路径 | 无（注册要 owner 扫码，下次装预览版时看注册完 Bot 已启用、长连接连上） |
| [x] | s02b | 拿掉咖啡一下（一）：入口和设置 | 删桌面端和网页的咖啡一下开关、搜索词和设置项，私聊设置卡里的咖啡一下；daemon 不再起咖啡一下的服务（3.12） | 400 | — | — | 无 |
| [ ] | s02c | 拿掉咖啡一下（二）：daemon 代码 | 删设置协议里的咖啡一下、`D/cli-bridge/` 和它的测试；`vonvon hook` 留一个直接退出的空命令（3.12） | 5600，拆成 5 片（下面的 s02c 拆法） | s02b | 子进程 | 无 |

开工要点：
- s01：兼容标识不动：旧目录、`FEISHU_CODEX_BRIDGE`、`CLAUDE_CODE_ENTRYPOINT`、hook 正则、旧服务标签。不申请 `im:message.group_msg.include_bot:read`。补拉因为缺权限失败时，记一条带权限名的结构化日志；今天没有现成的诊断去处，诊断页上显示缺的权限在 s19 做。
- s01 没改的旧名字：私聊控制台（`D/card/dm-cards.ts`）里的，s51a 到 s51c 整体删掉；没注册的 `doctor`、`bot`、`update` 命令文件（`D/cli/commands/`）里的，走不到，以后要接上这些命令时先改文案。
- s02：补 PATH 的函数放在 daemon 里（`D/platform/tool-path.ts`），s07 写服务定义时复用；不跑登录 shell，免得卡在用户的交互配置上。M1 的 app 从 Finder 打开，不补 PATH 就找不到 Codex。`locate.ts` 不另加候选目录：补了 PATH 以后 `which` 就找得到，加了反而让"找不到 Codex"的测试随机器上有没有 Homebrew 的 codex 变。
- s02：自带的 npm 只给下载 Claude SDK 和 `installCodex` 用，daemon 按自己所在的位置找它（`D/platform/npm.ts`），不靠环境变量。本机环境页的"安装托管副本"仍用 PATH 上的 npm：npm 11.19 起默认不跑依赖的安装脚本，claude-code 和 lark-cli 都靠 postinstall；托管副本自己也要本机有 `node` 才能跑，没装 Node 的 Mac 用自带的 npm 也装不成。

- s02a：owner 的五条反馈：① 叫法不统一 ② 复制链接报错 ③ 注册和开权限分在两处 ④ 把 bot 拉进群后没提醒，"查找已加入的群"报错 ⑤ 建群界面不好用。前四条在 s02a 修；第五条留到本文第 1 节说的界面调整，只有"保存并离开"会建出一个群这一处在 s02a 修。咖啡一下是另外说的，见 s02b。查到的原因：桌面端拒绝了网页的全部权限，复制链接写不进剪贴板（`packages/desktop/src/main.ts:204-205`）；"重新授权"其实是重新扫码刷新凭据，不开权限，本文 M1 验收第 3 步原来的说法是错的；桌面端把 daemon 的每条报错都换成"Daemon request failed"（`packages/desktop/src/bridge.ts:29-35`），飞书返回的错误码在 `D/admin/groups.ts:50-52` 丢了；`im:chat:readonly` 不在必需权限里，清单全绿时它也可能没开。M1 验收第 2 到 4 步已按改后的界面改写：群聊页没有绑群入口，绑群在 Bot 页做。
- s02d：2026-10-15 在 JP-VPS 上用 lark-cli 走 M1 的飞书步骤时发现。当时 JP-VPS 还没装 bubblewrap、socat（后来装了，现状见本文第 7 节），Claude 只读档的第一轮在沙箱里失败；改成完全访问以后，整群仍卡在那条没保存下来的会话上。修法沿用 s10 的恢复失败路径：`resumeThread` 先在 Claude 配置目录的各个项目文件夹里找 `<会话 id>.jsonl`，哪里都没有才抛错，调用方换新会话并在运行卡上写明；文件夹读不了时照常恢复，不因为查不了就丢会话。不用 SDK 的 `getSessionInfo` 判断：它只读文件首尾各 64 KB，长会话在这两段里没有摘要时也返回空，会把存在的会话当成没有（审查时复现）。
- s02e：owner 2026-10-15 复验时回："M1 注册完 Bot 默认应该就开启，其他没问题"。查到的原因：扫码注册只把 bot 写进 bots.json，不带 `active`，也不启动它（`D/bot/register-bot.ts`）。开关过任何一个 bot 的安装里，没有标记的新 bot 算停用；一个 bot 都没有时它靠 current 回退算启用，但 daemon 没起它，界面停在"待生效"。修法：`registerBotByQr` 落盘后，在 `setBotEnabled` 的同一条队列里把新 bot 加进活跃集，`activeBots` 的回退语义不变，旧安装的 current 仍启用；再像打开开关一样调 `applyBotActivation`。注册结果只等落盘、不等启动，启动失败只记日志。命令行的首次扫码（`registerNewBot`）只在一个 bot 都没有时走，`run` 随后按活跃集起它，不改；没有 `vonvon bot add`。
- s02b：Claude 回合带的 `FEISHU_CODEX_BRIDGE` 标记留着：它让 bridge 装的 hook 认出这是 bot 自己的会话、不转发，迁移卸掉 bridge 的 hook 之前都要。本片不卸任何 hook，统一留给 M10 的 s62。开工时确认 daemon 不起服务以后，已经装进 Claude Code、Codex CLI 的 hook 退回终端里问。
- s02b 做法（界面）：网页的"咖啡一下"页、侧栏入口和搜索词（咖啡一下、本机 Hook、接力设置、通知偏好和下面各项）都删了，Bot 设置面板里的那组接力和通知控件、本机 Hook 的检查修复一起删。桌面端没有自己的咖啡一下代码，它显示的就是这个网页。
- s02b 做法（私聊设置卡）：全局设置卡里"☕ 咖啡一下"一节和它的二级卡删了。已经发出去的旧卡上的按钮（入口和二级卡上的总开关、通知范围、转发哪个工具、离开保活、修复 hooks，id 列在 `COFFEE_RETIRED_ACTIONS`）还能点：管理员点了不写盘，卡刷新成没有咖啡一下的设置卡，顶上写一行"☕ 咖啡一下第一版已经拿掉了。本机 Claude Code、Codex 要审批时，照常在终端里问。"；别人点了没反应，和以前一样。旧的审批卡、问答卡、完成卡上的按钮不再有人接，点了只记一条 `action-nohandler` 日志，以前 daemon 重启过也是这样。
- s02b 做法（服务）：bot 不再建、不再起咖啡一下的服务，也就没有 socket；`handle-message.ts` 不再引用 `D/cli-bridge/`，私聊里回复旧完成卡的话照常进私聊。已经装进 Claude Code、Codex CLI 的 hook 连不上 daemon，回 `fallback_local`，终端照常问：在 JP-VPS 上用源码跑 `vonvon hook claude` 和 `vonvon hook codex`，各喂一条 PermissionRequest，标准输出都是空的，退出码 0。已存的 `cliBridge` 设置不迁移、不删。
- s02b 留给 s02c 的：设置协议和 RPC 里的咖啡一下还在，界面已经不调了：Agent 设置的 `cliBridge` 一节和 `cliRuntime`，本机设置的 `coffee`，`setCliBridgeEnabled`、`repairCliHooks`、`setHostCliRoute`、`repairHostCliHooks` 四个写操作（`D/admin/settings.ts`、`host-settings.ts` 和协议，连测试约 750 行，放进本片会超过 1500 行）。bot 不再把服务交给设置层，`cliRuntime.running` 一直是 false，`setCliBridgeEnabled` 回"请先启动此 Agent"。s02c 的第一片先删这一层，`vonvon settings` 里隐藏 `cliBridge` 的过滤跟着去掉。`packages/ui/src/reference/styles` 里早就没人用的 `coffee-*` 样式也在那时删。s02c1 已删，见下面的 s02c1 做法。
- s02c：几乎全是删除，开工前用 `git diff --stat` 量，按 1500 行拆成 s02c1、s02c2……，依次合入。不急，放在第二条线上做。s02b 以后 `handle-message.ts` 不再引用 `D/cli-bridge/`，s02c 不用再改它。cli-bridge 的 Windows 分支随它一起删。s01 说不动的 hook 正则在 `D/cli-bridge/hooks.ts:310`，跟着删掉；s62 卸 bridge 的 hook 用 #226 里的 hook 改写代码，不靠它。
- s02c 拆法：2026-10-15 量过，`D/cli-bridge/` 的源码约 1990 行，它的测试约 2290 行，加上设置协议这一层和配置，s02c 一共约 5600 行，比原来估的 4600 多，拆成 5 片，依次合入。按谁引用谁的顺序删：先删没人引用的，每片合入后都能单独过 typecheck。
  - s02c1（约 1100 行，#326 已合入）：设置协议这一层，见下面的 s02c1 做法。
  - s02c2（约 780 行，子进程，#329 已合入）：`vonvon hook` 改成直接退出的空命令：照收 `--agent`、`--bot`，什么都不输出，退出码 0，已经装进 Claude Code、Codex CLI 的 hook 照常在终端里问。删 `D/cli-bridge/index.ts`（只有 `vonvon hook` 引用它）、`protocol.ts`、`hooks.ts`（s01 说的 `hooks.ts:310` 的 hook 正则和 cmd.exe 引号在这里），和 `cli-bridge-hook-routing`、`cli-bridge-protocol`、`cli-bridge-hooks`、`cli-bridge-hook-targets` 四份测试；`coffee-retired.test.ts` 去掉对 `D/cli-bridge` 的 mock。合入前在 JP-VPS 上用源码跑 `vonvon hook --agent claude` 和 `--agent codex`，各喂一条 PermissionRequest 和 Stop，看标准输出是空的、退出码 0。
  - s02c3（约 1190 行）：删 `cli-bridge-service.test.ts` 和 `cli-bridge-global-service.test.ts`。`service.ts` 连它的测试约 1700 行，一片放不下，所以测试先删；s02c2 以后 `service.ts` 已经没有调用方。测试只测 `service.ts`，别的测试没有引用它们；`service.ts` 本身和它对 `ipc.ts`、`store.ts` 等的引用留到 s02c4，所以这一片合入后 `D/cli-bridge/` 照样能过 typecheck。
  - s02c4（约 1360 行）：删 `service.ts`、`cards.ts`（Windows 离开检测的提示在这里）、`store.ts`，和 `cli-bridge-cards`、`cli-bridge-store` 两份测试；`D/card/dm-cards.ts:905` 注释里提到 `cli-bridge/cards` 的那句跟着改。
  - s02c5（约 1150 行）：删剩下的 `ipc.ts`、`parser.ts`、`keep-awake.ts`、`presence.ts`（PowerShell 离开检测）、`route.ts`、`types.ts` 和它们的五份测试，以及 `cli-bridge-config.test.ts`；删 `D/config/schema.ts` 里 `cliBridge` 的类型和读取函数（约 150 行）、`D/config/paths.ts` 的 `cliBridgeSocket` 和它的命名管道分支。`preferences.cliBridge` 到这一片才从类型里去掉，旧文件里的这个键照旧留着、没人读；`coffee-retired.test.ts` 里写 `cliBridge` 的那条配置改成不靠类型。`D/cli-bridge/` 到这里删空。
- s02c1 做法（协议）：Agent 设置的 `cliBridge` 一节和 `cliRuntime`、本机设置的 `runtime.coffee`，`setCliBridgeEnabled`、`repairCliHooks`、`setHostCliRoute`、`repairHostCliHooks` 四个写操作，从协议、`D/admin/settings.ts`、`host-settings.ts`、`settings-parse.ts`、`settings-service.ts` 里删了。只给它们用的 hook 状态、生效时机 `next-hook` 和 `next-presence-check`、写操作结果 `diverged` 一起删；本机设置没有写操作了，写操作的结果里也就不再带本机视图。RPC 收到这四个写操作或存 `cliBridge` 这一节，按无效请求拒。`vonvon settings` 不再过滤 `cliBridge`，`--json` 里也没有了；`settings set cliBridge.…` 还是回"咖啡一下第一版已拿掉，不能改。"。
- s02c1 做法（旧数据）：`config.json` 里的 `preferences.cliBridge` 和 `cli-bridge-route.json` 不迁移、不删。读设置时不看它们，存别的设置时原样留在文件里；`vonvon hook` 照旧读它们，s02c2 以后就没人读了。测试用一份带全套旧字段的 `config.json` 读一次、存一次别的设置，再比对文件。
- s02c1 做法（协议版本）：`PROTOCOL_VERSION` 不升，和 s12 删 `compact` 一节一样。网页由 daemon 自己发，和 daemon 总是同一版。新的桌面端连旧 daemon 时，多出来的 `cliBridge`、`cliRuntime` 被丢掉，照常显示；旧的桌面端连新 daemon 时，读 Bot 设置会因为少了 `cliRuntime` 解析失败，只有把 app 换回旧版、或者 daemon 单独升级了才会碰到。升版本号反而会让刚装的新 app 拒绝连还在跑的旧 daemon，s08b 之前它不会自动重启旧 daemon。
- s02c1 做法（顺带）：`packages/ui/src/reference/styles` 里的 `coffee-*` 样式（grep 过，没有组件用）和没人调用的 `D/cli/commands/doctor.ts` 删了。同一处还有一条没人用的 `handoff`（接力设置）选择器，没动。
- s02c2 做法（空命令）：`vonvon hook` 在 `packages/daemon/bin/vonvon.mjs` 里、加载命令行主包之前就答完：主包连依赖要加载大半秒（JP-VPS 上 `--version` 0.7 秒），空命令 0.07 秒。什么参数都收，不认识的 agent、多出来的选项、没有 `--agent`、`--help` 都一样；不建数据目录、不拿锁、不写日志。标准输入读到结束再退，免得 Claude Code、Codex CLI 写事件时碰上关掉的管道；标准输入是终端就不读，一直不关最多等 2 秒。什么都不输出，退出码总是 0。主包里的 `hook` 命令删了：装进去的 hook 写的是 daemon 自己的入口（`process.argv[1]`），桌面端、后台服务和 npm 都从 `bin/vonvon.mjs` 起，不会直接跑 `dist/cli.js hook`。
- s02c2 做法（删的）：`D/cli-bridge/index.ts`、`protocol.ts`、`hooks.ts` 和四份测试；`route.ts` 里只给 hook 挑 bot 的 `selectCliBridgeHookBot` 一起删了，读写 `cli-bridge-route.json` 的留到 s02c5。`parser.ts` 的 `parseHookPayload`、`ipc.ts` 的 `sendCliHookMessage` 已经没有产品代码调用，只剩测试在用，随 s02c3、s02c5 删。`coffee-retired.test.ts` 去掉 mock 以后，最后一条只看带着旧的"已开"设置 bot 能起能停：`D/bot/` 早已不引用 `D/cli-bridge/`。
- s02c2 做法（测试）：`hook-command.test.ts` 起真的 `bin/vonvon.mjs`，喂 Claude 和 Codex 的 PermissionRequest、Stop，旧的 PostToolUse，空输入、截断的 JSON、二进制，各种多余选项，8 MB 的事件（写的一方不能报错），和一直不关的标准输入（2 秒后退）；每条都看标准输出、标准错误是空的，退出码 0，临时 `HOME` 里什么都没写。另有一条把入口拷到没有 `dist/` 的目录，`hook` 照样成功、别的命令加载不了主包，证明 `hook` 不碰主包。标准输入是终端的情况在 JP-VPS 上用 `script` 手工跑过，立刻退出。
- s02c2 留下的：打包版的 daemon 跑在 Electron 里，那时装的 hook 写的是 Electron 本身加 `bin/vonvon.mjs`，不带 `ELECTRON_RUN_AS_NODE`，Claude Code、Codex 跑它时起的是桌面端而不是这个空命令。没在 Mac 上看过会怎样；M1 预览版装过、又在咖啡一下里修过 hook 的 Mac 才有这种 hook，卸掉归 s62。2026-10-15 在 owner 的 Mac 上只读查过：`~/.claude/settings.json` 和 `~/.codex/hooks.json` 里都没有 vonvon 的 hook，这台 Mac 不受影响。

### M2 首次运行清单和开机自动运行

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s03 | Codex 版本检查和 Claude 登录检测 | Codex 定最低版本和验证过的版本，状态分够用、太旧、比验证过的新；Claude 登录分已登录、未登录、无法确认；本机环境页显示（3.11） | 380 | — | 子进程、错误路径、macOS 原生 | Codex.app 自带和 npm 装的 CLI 版本都判断对；Claude 登录检测和真实跑一轮一致，退出登录后显示未登录 |
| [x] | s04 | 首次运行清单 | 桌面端和网页共用的清单：扫码、开权限、长连接、事件订阅、发布、Codex 和 Claude；每步轮询，失败给原因和按钮（3.1 第 4 条） | 650 | s01、s03 | 错误路径 | 无（JP-VPS 上无头看各状态） |
| [x] | s05a | 删掉 daemon 里的 Windows 服务实现 | 删 `windows.ts`、`win-startup.ts`、三份 Windows 服务测试和 `__win-relaunch` 命令及其两份测试；没有用户可见变化，理由见本文第 6 节 | 1370 | — | — | 无 |
| [x] | s05b | 删掉服务定义和注册里的 win32 分支 | 删 `identity.ts`、`definitions.ts`、`registration.ts` 里的 win32 分支和 Windows 注册测试，以及桌面端跟着要删的 Run 键读取；没有用户可见变化，理由见本文第 6 节 | 520 | s05a | — | 无 |
| [x] | s06 | 注册服务后只由服务管理器拉起 daemon | 从 #285 搬启动路由（约 120 行源码加测试）：拿锁前先读注册，`daemon start` 改请服务管理器启动；修 #287（3.10） | 1000 | s05b | 子进程、并发、关闭清理、错误路径 | 已注册服务时 launchd 拉起的多余进程退出 0、不反复重启；持锁进程被 kill -9、PID 被复用后服务仍会重试 |
| [x] | s07 | vonvon service install、uninstall、status | darwin 用 launchd、linux 用 systemd；装服务前先排空自己起的分离 daemon；快照和 RPC 读真实状态（3.10） | 700 | s06、s02、e06 | 子进程、错误路径、关闭清理、macOS 原生 | 打包版执行 install：plist 写入并起来，`daemon stop` 后不再拉起，注销再登录会起来，没有 Dock 图标，已有分离 daemon 时马上接管 |
| [x] | s07a | 终端里用 vonvon 管 bot 和群 | vonvon bot list、bot status（清单各步的状态）、group list、group joined（查已加入的群）、group pending、group bind（文件夹、Codex 或 Claude、会话方式）、settings get 和 settings set（bot、群、会话的各节设置）；走网页端同一套本机接口和本机凭据，人看的输出加 --json；不做 agent 的令牌那条路（3.7 第 1 条、3.10） | 1111 | s07 | 错误路径 | 无 |
| [x] | s08a | 网页里的"登录电脑时启动"和清单里的这一步 | `vonvon service install`、`uninstall` 加 `--keep-running`；daemon 的 machine RPC 先回复、再起分离的助手进程跑这条命令（只在 macOS）；快照带服务状态、"跳过"和最近一次操作的结果；清单在"执行工具"后加"后台运行"："登录电脑时自动运行 bot（推荐）"，跳过就记下来并提示；"应用与启动"页的开关网页里也能用，只在 macOS 显示；Linux 上这一步只读，写明终端命令；`vonvon bot status` 也列这一步（3.1 第 4 条、3.10） | 880 | s07、s04 | 子进程、并发、错误路径、macOS 原生 | 只用网页端，`npm i -g` 装 PR 的打包 CLI，临时 `VONVON_HOME`：打开后页面重连到原地址，`launchctl print` 的 PID 和 `daemon status` 一致；关掉后 launchd 里没有这个任务，原端口上起了分离 daemon；新数据目录点跳过不写 plist；在"允许在后台"里关掉后显示"已在系统设置里关掉"；两个标签页同时点打开，一个提示正在进行；`npm run build` 的开发版显示"开发版不能装"；服务里跑着时关掉，助手进程挺过 bootout，结果是已卸载 |
| [x] | s08b | 桌面端的"登录电脑时启动"，app 挪走或换新版后修好服务，删桌面端的 Windows 代码 | 桌面端用自己的 Electron 起同一个助手命令，等它做完再接回 daemon；启动时发现 app 挪过位置、换了新版本或定义是旧格式，先停 daemon 再重装服务；删桌面端按注册读 `loginItem` 的覆盖和 Windows 代码；本文第 10 节写卸载步骤（3.10） | 875 | s08a | 子进程、macOS 原生、错误路径 | 装在"应用程序"里的打包版、真实 HOME 加临时 `VONVON_HOME`（本文第 7 节）：窗口里开关没有"连接断开"弹窗，和 `launchctl print` 一致；退出 app 后服务还在跑；服务跑着时把 app 挪到 `~/Applications` 再打开，plist 重写、服务恢复，挪回来也恢复；换成升了版本号的包后打开，`daemon status` 是新版本、新 PID；签名版在"允许在后台"里显示什么 |

开工要点：
- s03：nvm 装的 codex 从 Finder 打开时，PATH 里没有那个 Node 版本的目录，`#!/usr/bin/env node` 起不来。已改：起 codex 子进程（查版本、app-server、装完托管副本后的版本检查）时，PATH 补上 codex 所在的目录和 s02 的工具目录。
- s03：Codex 的最低版本定成 0.139.0。vonvon 用到的 app-server 方法 0.131.0 就都有，但 vonvon 依赖的行为（`turn/interrupt` 以 `turn/completed(interrupted)` 收尾、目标自动开始和目标状态）实际跑过的最老版本是 0.139。验证过的版本跟托管安装锁定的版本走，现在是 0.156.1。e05 做完后在 s39 抬高。
- s03 留下的，给 s39：e05 实测 0.139.0 用 ChatGPT 登录，试过的模型都被服务端拒了（它列出的 5 个里试了 gpt-5.5 和 gpt-5.4-mini）；0.148.0 跑不了 gpt-6-luna；0.156.1 各项都过。最低版本抬到 0.156.1，和验证过的版本相同，版本检查不用改结构。只改常量和测试，不必等 s39，下一个碰 `version.ts` 的片可以顺手改。服务端按客户端版本放行模型，这条线还会上移，所以回合里报"requires a newer version of Codex"时，s19 的诊断页也按版本太旧提示。
- s03：Claude 登录只用 SDK 自带的运行时查：起一个不跑回合的 query，读 initialize 返回的 account；查不了（没下载 SDK、超时、报错）就看环境变量，有 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_AUTH_TOKEN` 算已登录、没验证过，没有就是无法确认，不报未登录。没用 `claude auth status`：它是另一个 CLI，版本和 SDK 自带的不一定一样，查到了也说明不了 bot 的回合能不能跑。account 是 CLI 从本地凭据读的，不问服务器，所以过期的登录也显示已登录，直到真跑一轮失败。
- s03：#301 的 Mac 检查发现 owner 的 Mac 上没有 Codex.app，ChatGPT.app 里自带一份 codex（`Contents/Resources/codex-cli/bin/codex`，版本是预发布号，例如 0.162.0-alpha.17.2）。已加进候选，排在 nvm 之后，用户自己装的优先。
- s03 留下的：Claude 的两个辅助查询（取模型列表、生成标题）用 `settingSources: []`，不读用户设置。凭据写在 `~/.claude/settings.json` 的 `env` 里时（owner 的 Mac 就是这样），这两个查询会报未登录，回合本身（读 user 和 project）和登录检测（读 user）不受影响。下一个碰 Claude 后端的切片改，改之前先在 Mac 上看现象；只读 user 会把用户的 CLAUDE.md 带进生成标题的提示，要一起考虑。s16 已改，见 M3 的开工要点。
- s03 留下的：首页只显示上一次查到、还没过期的 Claude 登录结果，daemon 不在后台自己查（快照每 60 秒刷一次，没开窗口时也刷，每次都起 CLI 太重）；没查过或过期了显示未确认，查完马上刷新首页。已登录的结果留 30 分钟，终端里退出登录后，首页最长 30 分钟还显示已登录，点"检查登录"才马上更新。s19 做状态页时，回合因为没登录而失败，就清掉这个缓存。daemon 由 LaunchAgent 起来时（s07）可能读不到钥匙串，探测会报未登录；e06 测钥匙串时一并跑一次登录检测，读不到就在 s07 改成无法确认。
- s04：没装 Node 的 Mac 上托管副本装不了也跑不了，Codex 那一步写明三条路：本机环境里装托管副本（要 Node 和 npm）、装 ChatGPT 或 Codex 桌面应用、用 Homebrew 装。
- s04：JP-VPS 上实测 npm 11.19.0：全局 `--prefix` 安装会跳过 claude-code 和 lark-cli 自己的 postinstall（npm 提示 allowScripts 没覆盖），两个 `--version` 仍能跑；加上 `--allow-scripts=<包名>` 后 postinstall 照常跑。托管安装已加这个参数，npm 10.9 不认识它也照常装。
- s04：清单是侧栏里的"首次运行清单"页，没有 bot 时打开 app 先到这一页；首页和 bot 设置的"连接与权限"里也有入口。每个 bot 的顺序按飞书后台走：凭据、权限、长连接、事件订阅、卡片回调、发布。长连接排在事件前，因为事件页要先连上才能保存"长连接"方式；凭据被飞书拒绝时，后面几步显示"等第 1 步"，不重复报同一个错；只是连不上飞书（断网、超时、5xx）时，凭据显示"无法确认"，不给"重新授权"。写了"企业租户里新权限可能要管理员审核"（e13）。
- s04：卡片回调没有只读接口可查，由主人点"我已配置"勾上，存在每个 bot 目录的 `setup.json` 里，不放进 `bots.json`：重新扫码时注册表里的那条记录会整条替换。清单用到的飞书请求都加了 10 秒超时，卡住的接口不会让清单一直转。"登录电脑时自动运行"由 s08 加，"从 bridge 导入"由 s63 加。
- s04 留下的，M2 验收时在真实飞书上看：权限只看 `grant_status`，不看 `scope_type`，只开了用户身份的权限也可能算开了；版本列表只认 `status` 为 1 的版本；没发布过版本的应用，权限和版本两个读接口能不能用，没实测；"打开开发者后台"打开应用首页 `/app/<id>`，版本管理页的地址没核实。
- s05：开工时量出约 1,890 行，超过上限，拆成 s05a 和 s05b。
- s05a：删 `D/cli/index.ts:15` 白名单里的 `__win-relaunch` 和 `:57` 的命令本体。`D/service/control.ts:91` 正则里的 `__win-relaunch` 是识别 bridge 的兼容标识，保留。
- s05b：删了 `WindowsRunObservation` 和 Run 键常量后，桌面端 `daemon-dependencies.ts` 的 `parseWindowsRunQuery`、`observeWindowsRun` 和 `windows-native.test.ts` 里的 Run 注册测试编译不过，一起删，不留到 s08。桌面端在 win32 上读注册时报"不支持的平台"。
- s06：开工时先量，超过 1300 行就把 #287 的修复和测试单独成片（s06a、s06b）。合入后在已关闭的 #285 下补一条评论，写明代码去了哪里，再关闭 #287。
- s06：#287 的修法是用 host 互斥锁认人，不再只看 PID。活着的 daemon 拿着 `daemon.pid` 时一定也拿着 host 互斥锁，所以拿到互斥锁以后，PID 还活着的锁只可能是死掉的 daemon 留下、PID 又被别的进程复用了，直接接管，不碰那个进程。拿不到互斥锁时，等持锁的 daemon 就绪并通过本地凭据认证才退出 0，认证不了就退出 1，让服务管理器重试。Windows 的 Run 值读取随 s05 删掉，不搬。
- s07、s08：参考 #110 拆分表的第 13、14 块和它的 `login-item.ts`，去掉 Windows 部分。
- s07：s06 起，服务拉起的进程读到 `unrecognized` 的注册（比如旧版本写的、和现在生成的格式不一致的 plist 或 unit）会退出 1，由管理器每 5 秒重试一次。升级以后要先重写服务定义，再让服务起来，否则换版本后 bot 起不来。
- s07：服务定义里的 PATH 用 s02 的 `withToolDirectories` 补全。自带的 npm 由 daemon 自己找，服务定义里不用写 `VONVON_NPM_CLI`。
- s07：POSIX 上的互斥锁是 `127.0.0.1` 上按数据目录哈希出来的端口（20000 到 49999），和 Linux 的临时端口重叠。#295 的 CI 撞过一次（`host-service-shutdown` 测试报 busy），开工时看要不要改成 Unix 域套接字。#296 的 CI 也失败过一次，可能是同一个原因：`daemon-cli.test.ts` 的"concurrent detached starts return the same ready owner"两个启动都退出 1，日志里没有子进程的输出，重跑通过。开工时让这个测试失败时打印子进程输出。
- s07：e06 实测（`docs/research/2026-10-15-v1-spikes/e06-launchagent-keychain.md`）：LaunchAgent 起的进程拿到真实 HOME 和 USER、PATH 只有系统目录，Claude 和 Codex 的登录检测和终端一样是已登录。owner 的登录不走钥匙串，钥匙串那条路没验证到，所以 s03 留下的"读不到钥匙串时改成无法确认"照做，并在用钥匙串登录的账号上验证。用户在系统设置"App 后台活动"里关掉这一项时，服务从 launchd 里消失（`launchctl print` 退出码 113，表现和卸载一样），`service status` 把"plist 在、服务找不到"显示成"已在系统设置里关掉"。不用 `sfltool`（不加 sudo 时卡住）。产品 plist 的 `SuccessfulExit=false` 和 5 秒节流没测，放进 s07 的 Mac 检查。
- s07：`D/admin/host.ts:194` 的 `resolveCliBinPath` 还指向 `bin/feishu-codex-bridge.mjs`，包里只有 `bin/vonvon.mjs`（`D/service/common.ts` 的同名函数是对的）。查清 `host.ts:210` 那条路径还用不用，用就改成调 service/common 的。
- s07 的做法：服务名跟着数据目录走。默认的 `~/.vonvon-bot` 仍是 `com.vonvon.bot.daemon` 和 `vonvon-bot.service`；别的 `VONVON_HOME` 在名字后面加数据目录路径哈希的前 12 位（如 `com.vonvon.bot.daemon.<12 位>`），plist 和 unit 的文件名也一样。测试和 Mac 检查用临时 `VONVON_HOME` 就有自己的 label，碰不到 owner 的服务，不用另设变量。
- s07 的做法：`service install` 先停掉 `daemon start` 起的分离 daemon（等它排空退出），再写定义、让服务起来，端口沿用分离 daemon 的，网页地址不变。定义已装好、服务空闲时只 `kickstart`（systemd 是 `start`）。停了分离 daemon 以后装失败，结果是 `install_incomplete`，并写明"运行 vonvon daemon start"，不自动把分离 daemon 起回来。
- s07 的做法：自己名下的 `unrecognized` 定义（旧版本写的、格式对不上的普通文件）当作旧格式：install 重写、uninstall 删除，回滚时写回原字节。符号链接、目录和别的数据目录的定义仍然拒绝。服务正在跑时换定义仍要先 `vonvon daemon stop`。
- s07 的做法：`service status` 分七种：未安装、在运行、已停止、已关掉、分离运行、要处理、查不到。"定义在、launchd 里没有这个任务"显示为已关掉，提示去系统设置的"登录项与扩展"打开（e06）。`--json` 输出完整状态。网页的机器状态、`daemonStatus` 的 installed 和快照里的 `loginItem` 都读真实状态；`loginItem` 随工具检查每 60 秒读一次。
- s07 的做法：服务定义里的 PATH 是执行 install 时的 PATH 补上 s02 的工具目录。daemon 由 launchd 起来时（`VONVON_SERVICE=launchd`），Claude 登录检测报未登录就改成无法确认，提示可能读不到钥匙串。
- s07 的做法：互斥锁没改成 Unix 域套接字。换算法会让升级那一刻新旧版本的互斥失效：旧 daemon 占着旧端口，新进程拿到新的锁，以为没人持锁，接管 `daemon.pid`。`daemon-cli.test.ts` 的并发启动测试失败时会打印两个 CLI 的输出和 `daemon.log`；准入锁只等 1.5 秒，CI 负载高时也可能是原因，下次失败看输出再定。`D/admin/host.ts` 里指向 `bin/feishu-codex-bridge.mjs` 的 `resolveCliBinPath` 已删，改用 `D/service/common.ts` 的；用到它的 `buildDaemonControlCommand` 只有测试在用。
- s07 的 Mac 检查（未签名打包版、临时 `VONVON_HOME`）：接管分离 daemon、plist 内容、`daemon stop` 后 30 秒不拉起、卸载都通过。kill -9 后被拉起，launchd 记下 `last terminating signal = Killed: 9`；连续两次时第二次约 4 秒后看到新进程（每秒采样，没测准 5 秒节流）。Dock 用 Computer Use 没查成（超时），`lsappinfo` 里没有服务进程。在"App 后台活动"里关掉后 `service status` 显示已关掉，这时 `daemon start` 仍能把服务起来，系统设置里的开关还是关的；未签名打包版在那里显示为"Vonvon Bot"、"身份不明的开发者"。install 成功时原来把服务自己的 daemon 写成"Left behind"，已改成"running under the service"。
- s07 留下的，给 s08：服务正在跑时 install 拒绝替换定义，桌面端换新版本后要先 `daemon stop` 再 `service install`，或者在 s08 给 install 加"替换运行中的服务"。开关读 `service status --json` 的 `state`，`disabled` 就是系统设置里关掉了。网页和桌面端的 machine RPC 里 install、uninstall 仍然拒绝，s08 接到 CLI。系统设置里显示成什么，s08 看要不要在 plist 里加 `AssociatedBundleIdentifiers`（会改定义格式，旧定义变成 `unrecognized`，install 会重写）。
- s07 留下的，给 s17：`service status` 还不显示 launchd 的 `last exit code` 和 `last terminating signal`，崩溃记录做的时候一起加。
- s07 留下的，给 s20a：Linux 的 install 没处理 linger；没有用户 systemd（比如容器里）时 `service status` 显示查不到，install 报 `User manager unavailable`。
- s07a：放在第二条线上尽快做，因为 Linux 先行的验收要用它（本文第 1 节）。owner 2026-10-15 说："改配置也不一定非要网页端改。也可以 vonvon-bot 命令行改。我感觉命令行实现验收的快一些。你自行考虑。当然网页端的验收肯定也要的。"命令只调网页端已经在用的 RPC（快照、`listJoinedGroups`、`listPendingGroups`、`bindGroup`、各设置页的读和存，以及清单的 `admin setupStatus`、选文件夹的 `directory choose` 和群设置页的会话列表 `settings sessions`），走 `@vonvon/client` 的 `connectLocal` 和本机凭据，不改 daemon 的行为。本机凭据这条路和网页端同一级，给在终端里的主人用，不交给 agent，设置 skill 也不走它。s47 以后在同一套命令代码上另加 agent 那条路（从环境变量读地址和会话令牌，按 3.7 校验私聊和触发人）。`vonvon bot add`（终端扫码）仍在 s20a。行数和风险都是估的，开工时先量。
- s07a 的做法：命令是 `vonvon bot list`、`bot status [bot]`（也可以写 `--bot`）、`group list`、`group joined`、`group pending`、`group bind <群 id> --folder <路径> [--name] [--tool codex|claude] [--conversation threads|shared]`、`settings get [节]` 和 `settings set <节.项=值…>`。`--bot` 填 bot 的 id 或名字；`settings` 用 `--group`（群 id 或项目名）或 `--session`（话题 id）选范围，都不填就是 bot 的设置。人看的输出和报错是中文，去掉飞书名字里的控制字符，`--json` 打一行 JSON，原样保留，出错退出 1。
- s07a 的做法：这三组命令只走 RPC，不建数据目录，不拿数据租约，在 `D/cli/index.ts` 的钩子里和 `service` 一样跳过。daemon 没在跑就提示先 `vonvon daemon start`，不自动起：看状态不该把 bot 跑起来。
- s07a 的做法：每次调用都有超时，本机 30 秒，要调飞书的（清单、查已加入的群、绑群）75 秒，比 supervisor 的 60 秒 IPC 超时长，daemon 自己的报错先到。绑群、存设置超时或断线时，提示可能已经完成和怎么查。存设置撞上别处的修改不自动重试。
- s07a 的做法：清单各步的判断从 `packages/ui/src/setup/setupPresentation.ts` 挪到 `packages/protocol/src/setup-steps.ts`，网页和 `bot status` 用同一份，字不会对不上。清单读失败时和网页一样，照样列出「检测失败」、连接和工具几步，再退出 1。
- s07a 的做法：只有一个 bot 时可以不填 `--bot`，多个时必须填；名字重了（s01 预填的都叫 Vonvon Bot）要填 id。不用 `bots.json` 里旧的"当前 bot"。
- s07a 的做法：`group bind` 的项目名先用 `--name`，没给就用待绑定记录里的群名，再没有就翻已加入的群（最多 20 页、1000 个群）。文件夹在命令行这边展开 `~`、转成绝对路径、查存在，daemon 照旧要求在主目录里。
- s07a 的做法：Linux 上用 Codex 绑完群，多打一行提示运行 `vonvon settings set --group <群 id> permission.mode=full`。只提示，不自动改，默认档留给 s20a、s20b。
- s07a 留下的，给 s47：agent 那条路在 `D/cli/daemon-client.ts` 里加第二种连接（从环境变量读地址和令牌），传给 `withDaemon`，命令函数照用。
- s07a 留下的：本机那一节（`codexBin`）和设置里走 `act` 的操作（管理员、群成员、评论提示词、语音）没进命令行，s47 或以后要用再加。
- s07a 留下的，给 s02b、s02c：`cliBridge`（咖啡一下）在人看的输出里不显示，`settings set` 拒绝改，`--json` 里还在，等 s02b、s02c 删掉。s02c1 已删，`--json` 里也没有了。
- s07a 留下的：`D/cli/commands/doctor.ts` 也是没人调用的旧代码，随 s02c 或 s58 删。s02c1 已删。旧的 `commands/bot.ts`（直接读 `bots.json`）和 `checkbox.ts` 已在本片删掉。
- s08：e06 发现系统设置"App 后台活动"里也有一个开关，用户在那里关掉时服务从 launchd 里消失。桌面端的"登录电脑时启动"要读 s07 的状态，显示"已在系统设置里关掉"，不能只看自己存的值。未签名的 Electron 在那里显示为"Electron"、"身份不明的开发者"；签名后的预览版显示什么，s08 的 Mac 检查时看。
- s08：按 Linux 先行（本文第 1 节），开关放在网页端和桌面端共用的清单里，daemon 调的也是同一个 `vonvon service` 命令，所以先在 Mac 网页端查；桌面窗口里的部分，等网页端封装成桌面端时再查。
- s08 的做法：拆成两片，合起来约 1750 行，超过 1500 行的上限。s08a 做 daemon、协议和网页端共用的界面，Linux 先行；s08b 做桌面端接线、app 挪走和换新版后的修复、删 Windows 代码和卸载步骤，依赖 s08a。
- s08 的做法：daemon 不能在自己的进程里装卸服务：`service install` 要排空的分离 daemon 正是在回网页请求的这个，`uninstall` 会把服务里的 daemon 停掉。所以交给另一个 CLI 进程（助手）跑 `vonvon service install` 或 `uninstall --keep-running`，可执行文件和入口用 daemon 自己的 `process.execPath` 和 `process.argv[1]`。助手用 `detached` 起（setsid），输出写进 `daemon.log`，环境里去掉 `VONVON_SERVICE`。网页端由 daemon 的 machine RPC 起助手，先回复再动手，页面断开几秒后在原地址重连；桌面端（s08b）用自己的 Electron 起同一条命令，等它结束再接回 daemon。桌面端 bridge 仍拒绝 machine `service`，每个界面只有一个起助手的地方。
- s08 的做法：`--keep-running` 是公开选项：结束时之前在跑的 daemon 没了，就按原来的端口起一个分离的 daemon（已注册服务时请服务管理器起）；那个 daemon 还没公布端口的，不换新端口起，结果里记"没重新起"。不加时还是 s07 的行为。关掉开关后 bot 改成分离运行，网页也就有 daemon 可连。
- s08 的做法：`service` 互斥锁串起终端、网页和桌面端的装卸。它是端口锁，进程死了就释放，不会留下陈旧的锁；拿不到就报"另一个后台服务操作正在进行"，不写结果文件。daemon 起助手前也先查：自己的助手还活着，或者结果文件说在跑、那个 PID 还活着，都直接回 busy。助手死后 PID 可能被别的进程用上，所以 PID 属于别的用户（发不了信号），或者"在跑"已经超过 10 分钟（比助手最长的一次还久），都当它已经结束。助手没写结果就以非零退出（没拿到锁，或者中途崩了），由起它的 daemon 补一条失败结果，开关旁边写出原因；这时另一个助手正在跑的，就不覆盖它的"在跑"。
- s08 的做法：`<root>/service-action.json`（权限 600）记最近一次装卸：运行中时写助手的 PID，做完写成败、原因、留下的东西，以及有没有按原端口重新起 bot。原因由 `classifyServiceFailure` 按 s07 的报错文字归类，每条文字都有测试钉住。"跳过"记在数据目录根下的 `setup.json`（`{service: {skipped, at}}`），是整台机器的选择，和每个 bot 目录里的 `setup.json` 不是一个文件。打开前清掉"跳过"，关掉开关时记上，主人特意关掉以后清单不再催。
- s08 的做法：界面只读快照。`application.service` 带 s07 的状态、为什么不能装（开发版、App Translocation；认不出安装方式的不拦，交给安装时再判断）、是否跳过和最近一次操作；结果文件和跳过标记在每 5 秒的重建里重读，launchctl 只在启动时、每 60 秒、助手退出后、"重新检测"和"跳过"时问，几次问询重叠时以最后发出的那次为准。`loginItem` 仍按 s07：在运行、已停止和分离运行都算开着。清单、桌面端和 `vonvon bot status` 用同一个 `serviceStep`（`packages/protocol/src/setup-steps.ts`），这一步不算进"还有几步"。最近一次操作 10 分钟内失败的，清单和开关旁边写出原因。
- s08 的做法：只有 macOS 能在界面里装卸。Linux 上清单这一步只读，写明终端命令，"应用与启动"页不显示开关，machine RPC 也拒绝装卸；linger 在 s20a 做。这样也避开了 systemd 的问题：服务里的 daemon 起的助手会跟着 unit 一起被停掉。
- s08 的做法：app 从 App Translocation 的临时位置运行时，install 拒绝，提示先把 app 拖进"应用程序"再打开：不然装进去的定义下次就找不到 app。
- s08 的做法：install 不加"替换运行中的服务"（没有 `--replace`）。定义要换时（app 挪过位置、换了版本），桌面端（s08b）先 `daemon stop` 再 `service install`，s07 审过的安装事务不动。
- s08 留下的：版本号相同的两次构建分不出新旧，预览版要升补丁号，构建号以后再加；不拒绝从 `/Volumes` 运行；plist 里加不加 `AssociatedBundleIdentifiers`，等 s08b 的 Mac 检查看签名版显示什么再定；网页重连后回到默认页，记住当前页约 6 行，需要时再加。s47 加 agent 令牌时，不能让它们调 machine `service`。
- s08b 的做法：app 挪走或换新版后，桌面端启动时在接 daemon 之前修服务。只在 macOS 上的打包版、不在 App Translocation 里时做，不看 `VONVON_DESKTOP_TEST_HOME`（Mac 检查要用它）。判断是一个纯函数 `planStartupRepair`，看三件事：服务定义属于桌面版（`ours`，安装方式 `desktop`）而它记的 Electron 或 CLI 入口已经不在了（挪过位置）；正在跑的 daemon 比 app 自带的旧；自己名下的定义是旧格式（`unrecognized` 里的普通文件；符号链接或目录 install 不替换，就不修，这个判断用 daemon 的 `isIrreplaceableDefinition`，桌面端不匹配英文原文）。服务定义属于桌面版、在跑的 daemon 比 app 旧时，先 `daemon stop`（等 60 秒），再 `service install --keep-running`（等 180 秒）；只是挪过位置或定义是旧格式时，先直接 install，install 回"服务自己的 daemon 挡着"（`replace-running`）才 `daemon stop` 再装一次，这样 install 一直被拒（比如系统设置里关了后台运行）时，不会每次打开 app 都把 bot 停一次。然后照常接 daemon；没有注册服务、只是 daemon 比 app 旧时，`daemon stop` 后照常起 app 自带的新版本。npm 装的服务和别的数据目录的服务都不动。挪过位置时停了 daemon 以后，launchd 里的任务没有 PID，install 能重写定义；原地换新版时定义的字节不变，install 回 `already-installed`，接下来的 `daemon start` 把新版本拉起来。两份 app 不会来回抢：只有记的路径没了，或者在跑的版本更旧，才修。同一个数据目录上 npm 起的旧版分离 daemon 也会被换成 app 自带的版本，这种情况少，接受。
- s08b 的做法：修服务失败的原因留着。之后接 daemon 也失败时，致命错误框里写修服务的原因，不写"等待就绪超时"；接上了就弹一个不挡操作的提示"后台服务没能更新到这个位置的 Vonvon Bot：<原因>"。`daemon stop` 失败时不往下修，接回旧 daemon，提示"没能停下旧版本的 daemon：<原因>。先用着旧版本，稍后在「应用与启动」里重启 daemon。"
- s08b 的做法：新旧只比版本号（`D/service/update.ts` 的 `isNewer`）。app 自带的版本读 `Resources/daemon/package.json`，不用 `app.getVersion()`，那是 stage 包的 0.1.0。只升不降：在跑的 daemon 比 app 新时不动。版本号相同的两次构建分不出新旧，所以每出一次预览版都要升补丁号。
- s08b 的做法：helper 可能还在换 daemon 时，窗口等它做完再接上，不另起 daemon。窗口里开关等了 3 分钟超时、或者另一个 helper 占着锁（busy）而 daemon 已经停了，窗口等到 helper 的报告不在跑（或 pid 没了）或新 daemon 出现，再走 `ensureReady` 接上。app 开着时从网页（`vonvon open`）或终端装卸服务，daemon 自己起的 helper 会停掉窗口连着的 daemon：bridge 收到断开时只要有活着的 service helper，就跟着它重连，不弹"连接断开"，接不上才弹。
- s08b 留下的：plist 里加不加 `AssociatedBundleIdentifiers` 还没定，等 s08b 的 Mac 检查第 B5 项看签名版在"允许在后台"里显示什么。要加的话，旧的 plist 成了旧格式，启动时的修复会重写它，不用另做迁移。
- s08b 留下的：两个版本之间协议版本变了时，启动时的修复认不出正在跑的服务 daemon（它的锁过不了协议校验），不会替换它，窗口最后弹"无法验证 daemon"。这种升级要先用旧版的 `vonvon daemon stop` 停掉，再打开新版。以后要修的话，让启动修复在登记是我们的、类型是桌面版、只差协议版本时，按 launchd 任务停掉旧 daemon。

### M3 群里的上下文

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s09 | 真名和水位 | 按 open_id 换真名并缓存，拉历史带 `with_sender_name`；修水位：话题第一条不再重放、bot 开话题写水位、插话和排队推进水位、话题补拉翻页（3.5 末尾第 4 到 8 条） | 500 | s01、e10 | 并发、错误路径 | 无 |
| [x] | s10 | 连续群的话题单独成会话，被迫换会话时说一声 | 话题消息一律按 thread_id 分会话（3.5 末尾第 1 条）；resume 失败或目录变了而重建会话时，运行卡上说明 | 250 | — | 错误路径 | 无 |
| [x] | s11 | 空闲超时 10 分钟、重试按钮、群里都能领文件 | 看门狗默认 600 秒，加暂停接口给 s30 用；超时和网络失败分开写、带［重试］；本群能用 bot 的人都能领文件（3.12） | 360 | — | 错误路径、并发 | 无 |
| [x] | s12 | 自动压缩一直开，上下文仪表常驻 | 去掉"关闭自动压缩"，已存的 false 读时忽略；运行卡头部一直有仪表，压缩时写"已压缩 85% → 20%"（3.5"压缩"） | 470 | — | 数据迁移 | 无 |
| [x] | s13 | 话题登记表 | 每个 bot 每个群一份，记话题 id、第一条、谁开的、几点、标题、有没有会话；SessionRecord 加可选字段，旧文件不迁移（3.5"daemon 在本机记什么"）；没有用户可见变化，s14、s15、s48 要读它 | 380 | s09 | 并发、数据迁移 | 无 |
| [ ] | s14 | 对话记录块：主区补拉、话题开场带主区、引用行 | 统一的记录块；主区按水位补拉，开场最多 20 条；话题开场带回指和主区 10 条；引用行带两边会话 id；压缩后主区下一次开口附"本群最近 5 个活跃话题"；缺 `im:message:readonly` 时只带触发消息（3.5） | 850 | s09、s13、e10 | 错误路径、并发 | 无（M3 验收前，预览版任务按 3.5 时间线第 1 到 6 步核对日志） |
| [ ] | s15 | /new、/compact 排队和撤回说明 | 加 `/new`；主区 `/new`、`/clear` 只限主人和管理员，话题里不换；`/compact` 忙时排队；订阅撤回事件，进过会话的下次开口加一行说明（3.5"命令""撤回和编辑"） | 660 | s10、s13、s14 | 并发、关闭清理、错误路径 | 无 |
| [x] | s16 | 手填模型 id | Claude 查模型列表用和跑回合一样的设置源；`/model` 卡和默认模型能手填 id（3.11） | 350 | — | 错误路径 | 无（owner 在用 DeepSeek 或 Kimi 的话，M3 验收时顺手试一次） |

开工要点：
- s09：e10 实测拉历史带 `with_sender_name=true` 拿得到真人和 bot 的名字，不用为换名再申请 `contact:user.base:readonly`。真人用 `sender_name`，它和客户端显示的一致，`sender_i18n_names.zh_cn` 可能是另一个名字；bot 多一个 `open_bot_id`，能和事件 `mentions` 里的 open_id 对上。open_id 按应用区分，不能拿 lark-cli 看到的 id 去比 daemon 收到的。换名缓存用拉历史的结果填，查不到再走通讯录，再查不到写 open_id 尾号。
- s09：e10 这次测到断线期间的消息补推了，但在消息发出约 5 分钟后才到，daemon 重连后 3 分多钟里一条都没收到，所以补推可能晚于按水位补拉、甚至晚于回复。补推的消息按 message_id 和水位比对，进过记录块或回复过的跳过；今天的去重只在内存里（`RecentIdCache` 和 SDK 自带的），重启就没了，要持久化或直接比水位。晚到很久的 @ 要不要回、怎么说明晚了，在这片定。只有一个样本，补推时连着的是监听脚本，开工时用 daemon 自己的长连接再测断线 2 分钟和 10 分钟。
- s09 做法（真名）：每个 bot 在内存里一份 open_id → 名字的缓存（open_id 按应用区分，不跨 bot 共用），12 小时过期，查不到的 10 分钟内不再查。缓存从三处填：收到消息里的 @ 列表；拉历史和查引用的结果，都带 `with_sender_name`，真人取 `sender_name`，bot 按 `open_bot_id` 记；群成员列表。触发人不在缓存里时，依次查这条消息本身（带 `with_sender_name`）、通讯录（报 99991672 以后这个 bot 半小时内不再查，主人可能这期间开了权限）、群成员首页。3 秒内没查到就照旧写"某用户"，查到的留给下一轮。SDK 的接口调用没有超时，查了 15 秒还没回的这次算查不到，这个人后面的消息不再跟着等。代码在 `D/bot/names.ts`，管理员卡用的两个查名函数也搬了过去。
- s09 做法（话题第一条）：话题里只有 `parent_id` 不等于 `root_id` 才当引用（e10），直接发在话题里的消息不再每轮带上第一条；主区的回复照旧带引用。新的话题会话开场带一次话题第一条，bot 发的也带；拉到的列表里没有它时，单独查一次。
- s09 做法（水位）：`SessionRecord` 加可选的 `seen`，记水位之后已经送进会话的消息 id 和时间，最多 64 条；旧记录没有这一项，照常读，不迁移。补拉只拉比触发消息早的。补拉成功才把水位推到触发消息，水位只增不减；失败时只记下触发消息，下一轮从原水位重拉，新会话失败则从 0 重来。这些都等宿主接下这一轮（`turn_started`）才写：turn/start 被拒，或者进程在这之前崩了，触发消息和补拉到的上文都留给下一轮，重启后补推来的触发消息也照常回。新建和重建的会话登记时先写成什么都没见过（水位 0）。插话在发出之前记下，ACK 丢了也算送到，明确被拒的撤回；排队的消息在它那一轮开始时记下；下一轮补拉跳过这些。bot 开的话题在登记会话时，把触发消息的时间写成水位。`/clear` 和网页的清空把水位设在这一刻。水位都用 `patchSession` 的函数形式写，几处同时写不会互相覆盖。
- s09 做法（翻页）：话题补拉按 `page_token` 往前翻，翻到水位所在的那页为止，最多 10 页；新会话开场找够 20 条就停。仍只带最近 20 条，话题第一条另算。返回值带出补拉成没成功、有没有翻完，给 s14 写"更早还有 N 条"用。
- s09 做法（补推）：收到发出已超过 1 分钟的消息时，先查这条会话。话题里已在水位之内或送达过的、主区送达过的，跳过，记 `late-redelivery-skipped`。没见过的照常回；晚到 2 分钟以上的，发信人那一行写"这条消息 N 分钟前发出，bot 断线重连后才收到"。
- s09 留下的：
  - 断线补推，2026-10-15 在 JP-VPS 上用 daemon 自己的长连接复测：停 2 分钟期间发的两条（主区一条、话题一条），重连 3 分多钟后补推到了，离发出约 5 分 17 秒，发信人一行带上了"这条消息 5 分钟前发出…"，都回了；停 10 分钟期间发的两条，重连后 12 分钟里都没补推（推断飞书按约 15 秒、5 分钟、1 小时重试，没核实）。没补推的话题消息在下一轮按水位补拉进了记录块，只进一次；主区那条丢了，等 s14 的主区补拉。两次都没出现 `late-redelivery-skipped`，重复补推没在真流量里碰到。
  - `message.get` 带 `with_sender_name` 拿不拿得到名字没实测，e10 只测了列表；拿不到时走通讯录和群成员。
  - 主区还不补拉（s14），主区的水位照旧推到触发消息。主区里开话题的触发消息不查水位，处理过的消息在重启后又被补推时，会再开一个话题。
  - 别的 bot 卡片的正文（`card_msg_content_type`）留给 s14。
  - bot 开话题后、话题 id 绑定之前到的话题消息，仍会另起一条会话（旧问题）。
  - 水位之后记下的 id 超过 64 条时，最早的几条会在下一轮补拉里再出现一次；和触发消息同一毫秒、又没送到的消息算已读。
  - 两条话题消息乱序到达（早发的后到）时，先到那条的补拉会带上早发的那条，早发的那条到了照常成轮或插话，模型会看到两次。不按水位跳过它：列表还没拉到它时，跳过就整条丢了。
  - 插话被拒、转去排在一条新开的回合后面时，那一轮的补拉已经把它当送过的跳过，水位也推过了它；这时队列再被丢掉，它不会在补拉里回来，只靠"N 条排队消息未执行，请重发"的提示。
- s10：已有连续群里的旧话题，从下一条消息起建自己的会话，旧数据不搬。
- s10 做法：连续群（代码里的 `single`）只有主区消息走整群会话，带 `thread_id` 的消息和多话题群一样走话题路径，会话键是话题 id；旧话题的下一条消息建新会话，开场按新会话补拉话题历史。话题里 `/clear` 不换会话，提示开新话题。点表情"继续"按会话键判断回在主区还是话题。`resolveThread` 带出重建原因（恢复失败、工作目录变了），第一张运行卡的顶部写一行说明，终态卡保留，日志记 `session-changed`；说明在卡真正发出后才算用掉，建卡失败或目标模式某轮没出卡时，留给失败回复或下一张卡。
- s10 留下的事：工作目录变了时旧记录被新会话覆盖，旧会话只能从原生历史里找；目标模式整个运行都没出卡、也没报错时，这行说明不显示；连续群话题里的 `/help` 卡仍写"回到主群区 @我 + 内容"开新话题，s15 改命令时一起改。
- s11 做法（超时）：只改默认值，600 秒；存过的值照旧，包括手点过的 120。私聊设置卡的按钮改成"关闭""5 分钟""10 分钟"，点按钮也按 10 到 3600 钳位。运行卡上写"10 分钟没有输出，已自动停止"；`/goal` 超时写"30 分钟没有输出，已自动停止"（`GOAL_IDLE_MS` 不变）；云文档评论超时，在回复末尾写"N 分钟没有输出，已停止"；回复超长时先截答案，这句保留。
- s11 做法（暂停接口）：`withIdleTimeout` 多一个 `IdlePause` 参数。`hold()` 返回一个释放函数，可以嵌套，只能释放一次；最后一个释放之后，重新计满一个窗口。普通回合每轮新建一个；`/goal` 整个运行共用一个，每轮开始和结束时调 `reset()`，没释放的 hold 作废，旧的释放函数不再生效。都挂在 `ActiveState.idlePause` 上。s30 等卡时调 `active.get(sessionKey)?.idlePause?.hold()`，卡片答完或超时再释放。
- s11 做法（网络失败）：错误事件加了 `kind`（`network`、`auth`、`quota`）。Codex 取 `codexErrorInfo`：连不上、流断开、重试太多次、过载、5xx 算 `network`。Claude 取 SDK 的错误码：`overloaded`、`server_error` 算 `network`。没有错误码时按文字猜，规则在 `D/agent/error-kind.ts`。卡片上，`network` 写"🌐 网络失败：…"，别的照旧写"agent 失败"。Claude 的 `system/api_retry` 以前被丢掉，现在显示"瞬断，自动重试中…"；`/goal` 的结束卡不拿它当原因。
- s11 做法（重试）：
  - 空闲超时和 `network` 失败的终态卡带［🔁 重试］，看收尾后的卡片状态定：⏹ 停下的卡不带，哪怕停的那几秒里空闲计时到了。只出现在会话最新的终态卡上，而且要排队为空。重试记录只在内存里：这个会话再收下任何输入（新消息占住会话、排进队、插话、开 `/goal`），或者换了会话（`/clear`、`/resume`、桌面端的清空和恢复、改项目目录或群类型），或者 daemon 重启，按钮就失效，点了会回一句说明并去掉按钮。失效时把重试记录本身标上，点的时候、等失败那一轮收尾之后、真正占住会话前各查一次。
  - 谁能点和 👍 继续一样：发起人或管理员，并且还在本群名单里。会话真的收下这次重试才算用掉，卡上这时才改成"已重试"。同一张卡连点两下，第二下回"正在重试"。
  - 不收的时候：群已解绑，回"本群还没绑定为项目"并去掉按钮；项目停用、正在修改、正在恢复历史会话、会话在跑 `/goal`，或者会话被 `/compact`、`/clear`、`/resume` 占着，回一句说明，按钮留着。等失败那一轮收尾的时候变成这些情况，也一样回。
  - 点了以后，把这一轮的原输入前面加一行"上一轮因为…中断，先看看做到哪了"，当成一条回复失败卡片的新消息，走正常管线。失败那一轮还在收尾时，等它收完再开一个新的运行，不排进它的队列（停下的运行会丢掉队列）；不插话。重试失败再点重试，原输入外面仍只包一层。图片超过一小时被清掉的，就不带。
  - 顺带：👍 继续在未绑定或停用的群里不再续轮；没绑定项目时，消息管线不再起或恢复会话（没有权限档的会话在后端等于完全权限）。
- s11 做法（领文件）：`fileClaimMode` 去掉了"只有发起人或管理员"，本群能用 bot 的人都能领；项目停用时谁也领不了。点的人用自己的权限档，和文件写出时的档取交集，所以访客领不到完全权限档写在工作区外面的文件；这时只回点的人一句，不在共享卡上标错。
- s11 留下的事：
  - 给 s30：云文档评论没有 `ActiveState`，看门狗没接 `IdlePause`，s30 接评论的卡片时要自己加。
  - 给 s60：bridge 里存着 `runIdleTimeoutSeconds: 120` 的用户，多半是点过当时的默认按钮。换算时要不要去掉这个值，由 s60 定。
  - ［重试］只重放这一轮最初的输入。运行中插话补进来的内容不在里面，只在会话历史里。
  - 进程中途死掉（"agent 进程异常退出"）不算网络失败，没有重试按钮。
  - 登录失效的提示仍然写 `codex login`，Claude 会话也是这句；运行卡不知道后端是哪个，留给 s19 诊断页一起改。
- s12 做法（去掉开关）：网页的"会话压缩"、群设置卡和私聊项目设置卡上的开关、设置里的 `compact` 这一节（协议、RPC、daemon 校验）、`setAutoCompact` 写操作和 Codex 的 `model_auto_compact_token_limit` 覆盖都删了，管理面的项目快照不再带 `autoCompact`。`vonvon settings set --group … compact.autoCompact=…` 回"自动压缩现在一直开着，不能关了。"，RPC 存这一节按无效请求拒。已经发出去的旧卡上的开关还能点：不写盘，把卡刷新成没有开关的样子，顶部写一行"自动压缩现在一直开着，这个开关已经去掉了。"。
- s12 做法（已存的 false）：`projects.json` 里旧的 `autoCompact: false` 不迁移、不删，没有代码读它；存别的设置时原样留在文件里，等 s60 换算时丢掉。
- s12 做法（Claude 也一直开）：bot 的 Claude 会话在 flag 层设置里传 `autoCompactEnabled: true`，并把 `DISABLE_AUTO_COMPACT`、`DISABLE_COMPACT` 设成空。JP-VPS 实测（SDK 0.3.296，看 `getContextUsage().isAutoCompactEnabled`）：用户设置里关掉，或者进程环境、设置文件的 `env` 里设了这两个变量，都会关掉自动压缩；flag 层盖得过它们，空值算没设。用户自己终端里的 Claude Code 不受影响。Codex 不传阈值，用它自己的默认。
- s12 做法（仪表）：每张运行卡（包括 `/goal` 的）第一行是上下文仪表，运行中和终态都有。低于 70% 是灰色的"上下文 43% · 86k/200k"，70% 以上按档位着色，不再劝 `/compact`；不知道窗口时写"上下文 已用 86k"，还没有读数时写"上下文 —"。每一轮从这个会话上一次的读数（内存里的 `lastUsage`）起步，接着聊的会话一开始就有数；新会话的第一轮和 daemon 重启后的第一轮，在第一条读数到之前是"—"。换会话（恢复失败重建、目录变了）时清掉旧读数。读数从哪来：Codex 是每次请求后的 `thread/tokenUsage/updated`（`last.totalTokens` 和 `modelContextWindow`）；Claude 是主 agent 每个请求的 assistant 消息里的 usage（input、cache_read、cache_creation 相加），回合末用 `getContextUsage()` 校准，窗口用上一次的 `maxTokens`，没有就按模型 id 猜。以前 Claude 的仪表只在回合末动。原来 70% 以上才在卡底出现的那行，和单独发的"上下文已自动压缩"卡，都去掉了。
- s12 做法（压缩行）：过程区在压缩发生的位置写一行，进行中是"正在压缩上下文…"，完成后是"已压缩 85% → 20%"；终态卡里折在过程面板里，卡片容量不够时也不省略这一行。Codex 用 `contextCompaction` 项的 started 和 completed 夹住一次压缩。压缩前取开始时的仪表读数，这一轮还没有读数时取压缩中的第一条（总结请求本身，带着旧历史）。压缩后取压缩中的最后一条（codex 压完按新历史重算一次），比压缩前低才算，否则取结束后的第一条，还不低就只写"已压缩，压缩前 85%"。旧的 `thread/compacted` 也认，跟在项的结束后面时去重；codex main 已经不发给 v2 客户端，0.156.1 发不发没看。Claude 用 `status: compacting` 开始、`compact_boundary` 结束，直接用其中的 `pre_tokens` 和 `post_tokens`，有 `post_tokens` 时仪表马上降下来；`compact_result: failed` 写"上下文压缩失败"。压缩行的百分比用这张卡最新读数的窗口，和仪表一致：Claude 会话第一轮中途的窗口是按模型 id 猜的，回合末 `getContextUsage()` 校准仪表时，这一行也跟着改。Codex 的压缩失败时，项只有 started 没有 completed（codex-rs 装好新历史后才发 completed），终态卡写"上下文压缩没有完成"。
- s12 留下的：
  - 仪表读数只在内存里，daemon 重启后第一轮先是"—"。要落盘的话，s13 给 SessionRecord 加字段时一起考虑。
  - Claude 会话的第一轮（新会话、恢复的会话、daemon 重启后）还没调过 `getContextUsage()`，回合中途的仪表和压缩行按模型 id 猜窗口。用户设了 `autoCompactWindow`，或者 1M 窗口的模型 id 里没有 `1m`，就会猜错，回合末才校准。
  - Claude 空闲时也会自己压缩（`idleCompaction`），那时没有运行卡，这一行看不到；下一轮的读数会把仪表校准。
  - 手动 `/compact` 仍是单独的"压缩中 → 压缩完成"卡，s15 做排队时再看要不要也改成过程里的一行。
  - 两家真压缩时的事件顺序是按源码和 SDK 类型推的（Codex 看 codex-rs main 的 `core/src/compact.rs`，Claude 看 `docs/native-capabilities.md` 第 19 到 20 条），没有真把会话压满测过。M3 验收时跑一个长会话看一眼，Codex 那边顺便看 0.156.1 还发不发 `thread/compacted`。
- s13 做法（登记表）：每个 bot 每个群一个文件，放在 bot 目录下、和 `sessions.json` 在一起的 `topics/<群 id>.json`，代码在 `D/bot/topic-registry.ts`。每个话题记：话题 id；第一条消息（话题挂在它下面，即 `root_id`）的 id、发送人和时间；标题，取第一条的前 30 个字，去掉文件标记、压成一行；谁开的、几点开的；最近一次活跃的时间。只有标题是聊天内容，别的不存。
- s13 做法（谁开的）：bot 自己用 `reply_in_thread` 开的话题（主区 @ 开话题、`/goal`、`/resume` 和桌面端恢复开的）记 bot 自己；别的话题记 bot 在里面收到的最早那条消息的发送人，话题群的帖子就是发帖人。bot 开了话题、还没拿到话题 id 时已经有人在里面回了，先记成那个人，拿到 id 后改成 bot 自己，之后不再改。事件里 `sender_type` 是 `app` 的记成别的 bot。
- s13 做法（什么时候记）：绑定了项目、没停用的群里，每条话题消息都记，不管是不是 @ bot、bot 回不回。第一次见到的话题如果不是从第一条开始见到的，用 `message.get` 查一次第一条（每个话题每次启动最多查一次，10 秒没回算查不到），补上发送人、时间和标题。没带 `root_id` 的消息，也没带 `parent_id` 时才当第一条（话题群的帖子）；只带 `parent_id` 的不记第一条，等后面带 `root_id` 的消息补上。`/resume` 开的话题第一条就是 `/resume` 那条消息，标题改用恢复的会话的名字。
- s13 做法（有没有会话）：登记表里不另存。读的时候从 `sessions.json` 取这个 bot 在这个群里的绑定，键是话题 id，分了档时是话题 id 加 `#admin`、`#guest`，摘掉的（`detached`）不算。所以建会话、恢复失败重建、`/resume`、桌面端清空都不用再写登记表，两个文件对不上的情况不会出现。给出的是现在绑着的会话 id，重建前的旧 id 不在里面。
- s13 做法（读接口）：`createTopicRegistry({ dir })` 返回 `note`、`list`、`get`。`list(群 id, { limit })` 按最近活跃从新到旧，`get(群 id, 话题 id)` 取一个，都带 `sessions`（键、会话 id、后端）。s14 写引用行和"本群最近 5 个活跃话题"、s15 看话题开在 `/new` 之前还是之后、s48 列话题和放行会话 id，都读这里。daemon 里由 `bridge.ts` 建一个交给 orchestrator，没交的时候什么都不记（单测就是这样）。跨 bot 读用 `botPaths(appId).topicsDir`。
- s13 做法（并发和失败）：每个文件一把进程内的锁，读、合并、写在同一个临界区里，合并基于最新的盘值，和 `patchSession` 的函数形式一样，同一个群几轮同时写不会互相覆盖。合并的规则：谁开的取最早的，bot 自己开的记上以后不改；第一条的几项只补空的，不覆盖，只有标题例外：bot 自己开话题时带的标题盖过先查到的那个，只盖这一次，所以 bot 拿到话题 id 之前有人回了、先查到了 `/resume` 那条，标题最后还是会话名；最近活跃只往后走，差满 1 分钟才写，话题里连着聊不会每条都写盘。写盘先写临时文件再改名，写或改名失败时删掉临时文件。写失败只记日志（`topic-registry-write-failed`），这一轮照常跑；读失败当成空的。日志里的群 id 只写末 6 位。
- s13 做法（格式和大小）：文件带 `version: 1`。不认识的字段原样留着，缺字段的照常读，没有话题 id 的条目丢掉。文件解析不了时，读的时候当空的、记日志；下一次写的时候把它改名成同名的 `.corrupt` 留着，从空的重新记，以后的消息会把话题再记回来。每个群留最近活跃的 200 个话题，再加上更早但还绑着会话的（只在超过 200 个时读一次 `sessions.json`），所以 s48 放行的会话在登记表里都找得到；多了先丢最久没动静、没绑会话的。晚到的消息所在的话题比留下的都旧、又没绑会话，就不记。
- s13 做法（仪表落盘）：`SessionRecord` 加可选的 `usage`（会话 id、已用、窗口），每轮和每个 `/goal` 结束时写。daemon 重启后，会话的第一张运行卡从它起步，不再是"—"。只在 `usage` 里的会话 id 和现在跑的会话一样时才用，所以重建、`/clear`、`/resume` 以后不会拿到旧会话的读数。旧记录没有这一项，照常读，不迁移。
- s13 留下的：
  - 升级前就有的话题，要等里面再来一条消息才进登记表，谁开的记成那条消息的发送人。
  - 没开"接收群内所有消息"（`im:message.group_msg`）的 bot 只收得到 @ 它的消息，"谁开的"就是第一个在话题里 @ 它的人，不一定是开话题的人。别的 bot 开的话题也一样，它的消息推得到这个 bot 才记得到。
  - 话题开出来那一刻的主区会话 id 没记（3.5 的回指要用）。s14 在话题会话开场时取当时的主区会话；开话题之后、话题会话开场之前主区 `/new` 过的，回指会指向新的主区会话。
  - 仪表只在一轮结束时写：`/compact` 以后、下一轮结束以前重启，第一张卡先显示压缩前的读数，第一条读数到了就对了。`/context` 卡、网页上的上下文和 `/goal` 的卡，重启后在第一轮之前仍是空的。
  - 私聊里的话题不进登记表（3.5 只要群里的）。
  - JP-VPS 自验时看到，s13 之前就有：`daemon.log` 给收到的每条消息记了完整的话题 id 和正文前 40 个字（`D/bot/handle-message.ts` 的 `intake recv`），和 3.5"除了话题标题，群里的聊天内容不存到本机磁盘"不一致。s19 整理日志时去掉正文、id 截短，顺带查一遍别的日志有没有带正文。
- s14：拉别的 bot 的卡片回答要带 `card_msg_content_type`（e10）。不带时 2.0 卡片和 CardKit 流式卡片只返回标题和"请升级至最新版本客户端"，今天 daemon 发的正是这两种。`user_card_content` 返回发送时的卡片 JSON，比 `raw_card_content`（`D/bot/card-content.ts` 已在用的 `json_card` 包装）好解析。拉历史和查引用都要带。
- s14：话题里的引用（e10）：在话题里回复某一条时，`parent_id` 是被回复的那条，`root_id` 是话题根；直接在话题里发的消息，`parent_id` 是话题根。所以只有 `parent_id` 不等于 `root_id` 时才放引用，这就是 3.5"今天的代码和这里不一样"第 4 条的修法；引用话题根的那条分不出来，按普通消息处理。客户端里在话题中"回复"某条发出的是不是同一种消息，由 owner 在客户端里回一次，Claude 看 `parent_id`。"同时发送到群"收几次事件还没测（e10 第 5 项），s14 开工前请 owner 在客户端里发一条。
- s16 做法（设置源）：Claude 的三个辅助查询（登录检测、模型列表、生成标题）共用一套选项：只读 user 层设置，和回合是同一个 CLI、同一份 `env`，关掉 hooks、MCP 和 claude.ai 连接器，用 `claudeMdExcludes` 排除个人 CLAUDE.md。没读 project 层，因为模型列表按后端缓存，不按项目。
- s16 实测（JP-VPS，SDK 0.3.296）：传 `model: 'default'` 或调 `setModel(undefined)` 都用账号的默认模型，不看 `ANTHROPIC_MODEL`，只有不传 model 才用它。bot 的会话总是传一个明确的模型，所以用户设置里 `env.ANTHROPIC_MODEL` 指定的模型排到列表第一、当默认（其次是 daemon 自己的 `ANTHROPIC_MODEL`，再其次是设置里的 `model`）；列表里没有就补一行，SDK 失败时的兜底列表也一样。配了 `ANTHROPIC_MODEL` 时，SDK 的列表末尾会多一行 "Custom model"。
- s16 做法（手填）：手填的 id 只挡空白、控制字符、反引号、尖括号、`-` 开头和超过 200 字，不对模型列表校验，填错了在回合里报错。`/model` 卡总有一个手填表单，提交会锁卡，结果发一张新卡接管；会话记 `modelCustom`。默认模型卡的下拉多一项"自定义模型 ID…"，项目记 `defaultModelCustom`，`pickDefault` 见到它就原样用。网页的"新会话默认模型"和"本话题模型"也能手填，协议的 `ModelSelection` 加了可选的 `custom`；评论模型不开放。顺带：没有会话时 `/model` 卡不再显示"已切换"；群设置里默认模型选得不对时，带提示重发表单，不再不声不响地回到群设置卡；Codex 返回空列表时不再把兜底列表缓存一辈子。
- s16 留下的：改了用户设置里的 `ANTHROPIC_MODEL` 要重启 daemon 才进模型列表（列表按进程缓存）。手填 id 的推理强度给后端协议的全部档位，第三方模型认不认没实测。owner 用 DeepSeek 或 Kimi 的话，M3 验收时试一次手填和默认。

### M4 崩溃恢复、诊断和 Linux 命令行版

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s17 | 崩溃记录、整机暂停和 daemon restart | 崩溃前写 `~/.vonvon-bot/crash/` 记录，被强制结束的下次补一条；10 分钟 3 次进入暂停；加 `vonvon daemon restart`，`daemon status` 显示最近崩溃（3.10） | 800 | s07、e06 | 错误路径、关闭清理、并发、子进程 | launchd 下 10 分钟内 kill -9 三次：进入暂停、网页能开、每次都补了记录，`daemon restart` 能恢复 |
| [ ] | s18 | 单个 bot 暂停和崩溃通知 | 单个 bot 10 分钟崩 3 次只停它；用应用身份直接给主人发私聊，每个 bot 每 10 分钟最多一条；daemon 主进程崩溃时只由最早加入的 bot 发，列出受影响的 bot；诊断页列崩溃记录，红条带"恢复运行"（3.10） | 900 | s17、s19、e10 | 并发、错误路径、子进程 | 无（M4 验收时看私聊和红条） |
| [ ] | s19 | 状态与诊断页 | 按 bot 列连接状态、Codex 和 Claude 的版本与登录、缺的权限；每个 bot 记最近没回的消息和原因（3.1 第 8 条） | 450 | s03、s01 | 并发 | 无 |
| [ ] | s20a | Linux 命令行版（上）：平台、open --print、linger、终端扫码 | 平台枚举加 linux、去掉 windows，界面显示"这台 Linux 主机"；`vonvon open --print`；`service install` 处理 linger；`vonvon bot add` 终端扫码；Linux 的首次运行清单加"Linux 上 Codex 只能用完全访问"一步（3.10） | 750 | s07、s04 | 子进程、错误路径 | 无 |
| [ ] | s20b | Linux 命令行版（下）：Codex 只能完全访问，删 windows-job | Linux 上的 Codex 遇到只读、读写档不起会话，回一句说明，设置里置灰；删 `codex-appserver/windows-job.ts`；在这片的 head 上做 Linux 验收（3.8、第 8 节第 5 条） | 400 | s20a | 子进程、关闭清理、错误路径 | 无（Linux 在 JP-VPS 上验） |

开工要点：
- s17：e06 实测 `kill -9` 后约 1 秒被拉起，两次启动至少隔 `minimum runtime`（默认 10 秒；产品 plist 的 `ThrottleInterval` 是 5，实际间隔没测）；`launchctl print` 的 `last exit code` 和 `last terminating signal` 分得清正常退出和被杀。"重新登录过"用 Security 框架 `SessionGetInfo` 取的安全会话 id 判断（e06 只查了资料），开工时先在 Mac 上注销再登录验证一次；区分重启再加开机标识。
- s17：2026-10-15 在 JP-VPS 上发现：网页端点"重启"（`restartHost`）时，关闭阶段的清理失败会取消重启，手动启动的 daemon 就此停掉；AggregateError 里面的各条错误没写进日志，看不出是哪一步失败。做 `daemon restart` 时一起处理。
- s18：机器人能不能给没开过会话的主人发私聊，e10 没测到：owner 已经私聊过测试 bot。s18 开工前请 owner 找一位没和测试 bot 说过话的同事（本文第 8 节）：Claude 用应用身份按 open_id 给他发一条私聊、记返回码，同事在客户端里看收没收到、有没有通知。在那之前 3.10 的崩溃通知仍按推断做。给主人发私聊要用这个应用下主人的 open_id（从主人发给 bot 的消息事件里取），或者用 `user_id`、`union_id`，不能用 lark-cli 应用下的 open_id。
- s20a：清单里那一步写明"Linux 上 Codex 只能用完全访问"，由主人自己选要不要把 bot 默认档改成完全访问，不自动放开（本文第 5 节）。
- s20a：Linux 的首次运行清单还要查 Claude 只读、读写档要的沙箱：有没有 `bwrap` 和 `socat`，以及 Ubuntu 23.10 以后 AppArmor 是否挡住了非特权的用户命名空间（`kernel.apparmor_restrict_unprivileged_userns`）。缺了就写明 Claude 只能用完全访问或要先装、先放开，给出命令，不自动改系统设置。2026-10-15 JP-VPS 上实际遇到，见本文第 7 节。
- s20b：被拉进的已有群默认只读，在 Linux 上用 Codex 时起不来：bot 回一句说明，等主人改（product.md 第 11 节第 24 条）。今天的代码在绑定之前就抛错（`D/project/lifecycle.ts:206` 附近），要改成照常绑定、回合开始时再回说明。`windows-job.ts` 被 `owned-process.ts` 和 `environment/service.ts` 引用，属于子进程的代码。
- s20b 的 Linux 验收：Claude 在 JP-VPS 上的普通用户账号里，用这片 PR 的 head 走一遍 npm pack、装到临时前缀、`service install`、kill -9 后被拉起、`daemon stop` 后不再拉起、`service uninstall`。不重启 JP-VPS，linger 看 loginctl 的状态。结果写进本文第 10 节。

### M5 智能模式

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s21 | 群的智能/规则开关和运行中来了消息 | 群加智能或规则模式和"运行中来了消息"覆盖，缺省按规则读；切主区方式时回复方式不变（3.2、3.4） | 360 | — | 数据迁移 | 无 |
| [ ] | s22 | 三条底线：点名、接着聊、bot 消息 | 入站先判断对谁说；话题里只看 @；规则模式"仅 @"下引用我的消息不算点名（3.4 第 1 条的例外）；多 bot 群主区命令要 @；从群信息读 chat_mode 认出话题群，加一个单测（3.4"三条底线"） | 550 | s21、s15、e10 | 错误路径 | 无 |
| [ ] | s23 | 判断模型：订阅里的小模型 | 判断层三选一加原因；Codex 用常驻的 utility 进程，Claude 单轮、不带工具；出错算不回，主区被 @ 的出错算回在主区（3.4） | 550 | — | 子进程、错误路径 | 真实 Codex 用 gpt-6-luna 跑判断：结果格式对，超时按不回；合入后接着做 e12 |
| [ ] | s25 | 智能模式的入站：判断回不回、回在哪里 | 主区底线定不下来时调一次判断；话题里只判断回不回；每群每小时上限 60 次；进群说一句；新群默认智能；"不回"的原因进诊断页；话题里只有一个真人在和我聊时不调判断、直接回（3.4"控制成本"） | 800 | s21、s22、s23、s14、s19、e12 | 并发、错误路径 | 无（M5 验收前，预览版任务按 3.4 例子第 3、4 行跑一遍） |
| [ ] | s26 | 本机几个 bot 合成一次判断，只放行一个 | supervisor 里加协调器，按 message_id 收齐本机各 bot 的报名，智能 bot 合成一次判断，"全部回复"的也只放行一个；界面提示不同电脑上的 bot 可能抢着回（3.4） | 680 | s25 | 并发、子进程、关闭清理、错误路径 | 无 |
| [ ] | s27 | bot 之间互相 @ | 智能模式下收别的 bot @ 我的消息，只看对方最终回答；没有真人插话时最多来回 3 轮（3.4"bot 之间"） | 420 | s22、s25、e10 | 错误路径、并发 | 无 |
| [ ] | s28 | 群详情页的模式设置和用量页的判断次数 | 群详情页加模式、主区方式、回复方式、运行中来了消息，没设的显示"继承 bot 默认"；用量页按天显示判断次数（3.1 第 7、8 条） | 480 | s21、s25 | — | 无（JP-VPS 上无头检查） |

开工要点：
- s21：新建和新绑的群先也写规则模式，等 s25 接上智能入站再改成默认智能，中间不出现半成品的智能群。Claude 不支持插话，照样排队。
- s22：话题群和话题形式群在 s25 里不判断开不开话题，靠这里读到的 chat_mode 认出来。查询失败时，没点名的消息一律不回。
- s22：引用按 s14 的规则认：`parent_id` 不等于 `root_id` 就是引用了话题里的某一条，按 `parent_id` 查是谁的消息；话题里引用话题根分不出来，算没引用。e10 只测了普通群里的话题，话题群（`chat_mode=topic`）里的引用这片补测一次。
- s23：读 `SMART.md` 的那一小段先写在这里，s38 的 bot 文件模块合入后改成调它。
- s23：Codex 的判断用 gpt-6-luna，推理强度取最低档。测试、Mac 检查和 M5 验收里，判断都用它（owner 2026-10-15："测试的时候就用 gpt-6-luma 去判断"，按 gpt-6-luna 理解）。Claude 的 bot 用 Claude 订阅里的小模型。
- s23：gpt-6-luna 用 ChatGPT 登录时，Codex 0.148.0 被拒、0.156.1 能用，中间的边界没查（e05）。最低版本定 0.156.1 时够用，和 s03 留下的一致。
- s24 不做了：填 key 的判断模型（Decisions API、Jev）移到 product.md 第 10 节（owner 2026-10-15）。编号空着，不挪别的片。
- s25：每群每小时的上限先按 60 次做，e12 量完再调。
- s26：单独跑一个 bot（`--bot`）时退化成单 bot；子进程退出或请求超时，退回由各 bot 自己判断。
- s27：别的 bot 的最终回答按 s14 带 `card_msg_content_type` 拉，不然只拿到"请升级至最新版本客户端"（e10）。

### M6 提问卡片、权限档和子 agent

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s29 | 提问的事件和卡片 | 用 ask 事件换掉占位的 approval_request；三种卡一个版面，写清后果；空提交提示"至少选一项"（3.8"卡片"） | 640 | — | 并发、错误路径 | 无（渲染在 s31 的 Mac 检查里看） |
| [ ] | s30 | 卡片的发送、谁能点、等待和超时 | 同一条会话同时一张卡；单独发一条并 @ 能回答的人；daemon 按点击人判断谁能点；15 分钟超时；等卡时看门狗暂停；普通回合、`/goal`、云文档评论三处都接上（3.8） | 900 | s29、s11、e09 | 并发、关闭清理、错误路径 | 无（真实卡片在 s31 一起看） |
| [ ] | s31 | Claude 的权限档换算，提问接上 | 只读用 default、读写用 acceptEdits、完全访问照旧；加 canUseTool：提问出卡，越权拒绝并说明，完全访问下 Claude 自己要问的出卡（3.8 换算表） | 440 | s30、e02、e03 | 子进程、并发、关闭清理、错误路径 | 真实 Claude 三档各跑一遍：越权被拒带原因，关网 curl 被拒、开网 WebFetch 能用，选项卡能答、能超时，等卡时能停止 |
| [ ] | s32 | Codex 发来的请求不再报错 | 服务端请求进同一个通知队列；提问变选项卡，审批回 decline，不认识的方法仍回 -32601（3.8） | 320 | s30 | 子进程、并发、错误路径 | 真实 Codex：普通回合不发请求，审批请求回 decline 后这一轮不卡 |
| [ ] | s33 | 打字回答、旧卡自愈、敏感问题去私聊 | 有卡在等时，能回答的人发的消息就是答案；点到失效的卡改成"已失效（后台服务重启过）"；要填密码的题去私聊答（3.8"等待和超时"） | 520 | s30 | 并发、关闭清理、错误路径 | 无 |
| [ ] | s34 | 子 agent 的事件 | 加子 agent 事件；Codex 收子线程的通知并刷新看门狗，Claude 子 agent 的步骤不再混进主过程；能单独停一个（3.9） | 650 | — | 并发、错误路径 | 真实 Codex 跑带子 agent 的任务：子线程通知送到，父线程不被看门狗杀，单停有效 |
| [ ] | s35 | 运行卡上的子 agent 区 | 一行一个子 agent，点开看最近 5 步，每行能停；都结束卡才收尾；子 agent 发起的卡片发在父运行卡的位置，写"子 agent X 问……"；Claude 会话打开 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（3.9、3.8） | 500 | s34、s30、e01 | 并发、关闭清理 | 真实 Claude 的子 agent 跑完前卡不收尾（子 agent 区和停止按钮在飞书客户端里的样子，M6 验收时 owner 看） |

开工要点：
- s30：要不要另发一条带 @ 的文字，按 e09 的结果定；结果出来前默认另发。
- s31：e02 用到的字段，s02 锁定的 SDK 0.3.296 里都有，e02 这边不用抬版本；e03 的结果还可能要抬。同时改掉 `permission.ts` 顶部那段注释。
- s31：按 e02 的结果做：所有会话启动时都带 `allowDangerouslySkipPermissions: true`，中途升到完全访问才不用重开会话；resume 时明确传档，档不从记录里恢复；拒绝时不用 `interrupt`，不然原因会丢、这一轮按出错结束；提问的答案放进 `updatedInput.answers`。启动时带上这个参数后，升档只能走两条路：daemon 调 `setPermissionMode`，或者回调返回带 `setMode` 的 `updatedPermissions`。两处都只按权限档的设置来，回调不照搬 `suggestions` 里的 `setMode`。回调拿不到"这是在联网"的标记，关网时 Bash 联网靠沙箱挡，看 e03。
- s31：owner 2026-10-15 定（选了 B）：两家的连接器和 Claude Code 自己的工具第一版都留着，不关，Codex 也不传 `features.apps: false`。当时问的是：bot 的会话要不要关掉 claude.ai 连接器，和推送、远程触发、定时任务这类 Claude Code 自己的工具（e02 第 7 节）。建议用内置工具白名单，连接器默认关。Codex 一侧的同一类问题一起问：用主人的 ChatGPT 登录时，每条会话都挂着 `codex_apps`（主人账号的连接器，0.162.1 上 197 个工具，含合并 GitHub PR 这类写操作），会话层 `features.apps: false` 能关（e05），在 s37 的 profile 里传。
- s31：e02 没测完的两件，开工时补测：完全访问下，Claude 设置里的 ask 规则、删除关键目录会不会走到回调；vonvon 真实的 `['user', 'project']` 下，用户层的权限规则会不会改变哪些调用走回调。e02 用的是空的 `settingSources`。
- s31：顺手修会话标题的读法：`readSessionTitle` 只认记录里 `custom-title` 的条目，不用 `customTitle` 字段，因为它会退回 CLI 自动起的标题（e02 第 8 节）。放在这一片，是因为 s31 本来就要改 `D/agent/claude-agent/` 下的后端代码；约 40 行，算进这一片的行数。
- s32：vonvon 不开计划模式，Codex 的提问实际上不会来。这一片主要是不再回报错，不让回合卡住。
- s35：e01 测过，变量有效，不做备选，前提是开工时补测的 ⏹ 没问题。运行卡在这一轮唯一的 result 到达时收尾，子 agent 区用 task_* 消息和 `parent_tool_use_id`（e02 第 4 节）。开工时补测两件事：前台子 agent 跑着时按 ⏹ 多久能停下；设了变量后 Monitor 还能不能用。

### M7 个性、记忆和多工作区

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s36 | bot 默认和群覆盖的数据，新群自动建目录 | bot 默认项和群覆盖进存储，生效值按 3.2 的表算；bot 默认档取读写、开网（本文第 5 节）；新群目录自动建在 `projects/<bot 名>/groups/<群名>/`（3.3） | 820 | s21 | 数据迁移 | 无 |
| [ ] | s36b | 被拉进已有的群就绑定 | 不再私聊发绑定卡：bot 被拉进群就绑定，默认只读、关网（3.8），目录按 3.3 自动建；Linux 上用 Codex 时照常绑定，回合开始时再回说明（s20b） | 250 | s36、s20b | 错误路径、数据迁移 | 无（M7 验收时把 bot 拉进一个群看） |
| [ ] | s37 | 会话参数统一由 profile 给，关掉两家自带的记忆 | 起会话和恢复会话都带一份 profile：指令、额外根、skill、MCP、给子进程的环境变量、原生设置；关掉 Claude 的 auto memory 和 Codex 的 memories（3.6） | 460 | e04、e05 | 子进程、错误路径 | bot 的 Codex 会话不读写 `$CODEX_HOME/memories`（Claude 一半在 JP-VPS 上看） |
| [ ] | s38 | 个性和记忆生效 | bot 文件模块（原子写、字数上限）；按 3.6 的顺序拼指令，第一层加"不提别的群的内容"；记忆按位置组合，A 群的不进 B 群；云文档评论只带公共记忆 | 960 | s36、s37 | 错误路径 | 无（指令压不压得住仓库自己的 AGENTS.md，由预览版任务用两家各看一次） |
| [ ] | s39 | 多工作区和代码仓库交给 Codex 和 Claude | Codex 传 runtimeWorkspaceRoots 并按根配读写，失败直接报错，按 e05 抬高 s03 的最低版本；Claude 传 additionalDirectories，沙箱按档配根（3.6） | 430 | s37、s36、s03、e03、e04、e05 | 子进程、错误路径 | 真实 Codex：第二个根能写、根外被拒、仓库里 `git commit` 能不能成功；真实 Claude：额外目录能读写，只读档哪个根都写不进 |
| [ ] | s40 | 说"记住"就写进记忆，卡片上能撤销 | agent 直接写自己那份记忆，daemon 一轮前后比对，卡片显示"已记到本群记忆：…［撤销］"；超上限回滚（3.6） | 420 | s38、s39 | 并发、错误路径 | 只读档下 agent 能写记忆文件、写不到别处（"已记到本群记忆"的卡片 Claude 用 lark-cli 读，撤销 M7 验收时 owner 点） |
| [ ] | s41 | Bot 页：个性、规矩、智能提示词、记忆、工作区和仓库 | 编辑 SOUL.md、AGENTS.md、SMART.md（显示内置默认值）、工作区、代码仓库和公共记忆（3.1 第 6 条） | 550 | s36、s38 | — | 无（目录选择器在 M7 验收时看） |
| [ ] | s42 | 群详情页的覆盖项 | 个性补充或替换、工作区和仓库、本群记忆、智能提示词、权限档和访客档、网络、后端和模型的覆盖（3.2） | 400 | s41 | — | 无 |

开工要点：
- s36：群没设工作区时只用群自己的目录，不带 bot 的其余工作区，代码仓库照常继承（本文第 5 节）。仓库只收本机已有、带 `.git` 的目录。旧项目的 cwd 原样当作主工作区覆盖，不搬目录。
- s37：给子进程的环境变量在这一片定下，s46 的令牌也走它，所以 e04、e05 要先做完。
- s37：e05 实测，profile 在 `thread/start` 和每次 `thread/resume` 都要整份重传：`runtimeWorkspaceRoots`、`mcp_servers`（含禁掉用户的全局 MCP）、`skills.config`、`skills.bundled`、`projects.<cwd>.trust_level`，以及 memories 的两个键加 `features.memories: false`。memories 这三个 resume 后保不保留没查清：只带 cwd resume 后那一轮没重新注入记忆，`memory_mode` 和整合任务没单独查，按保险重传。只关两个键时，用户开着 memories 的话，bot 会话的第一轮仍会用 bot 的配置起一次全局整合任务，花主人的额度。不重传时用户的 MCP 和个人 skill 会悄悄回来。`skills/extraRoots/set` 对整个进程生效，预热池的进程在取出后、`thread/start` 前调。
- s37：resume 时传新的 `developerInstructions` 不生效（e05，4 个版本）。改过的个性、群的 `SOUL.md` 和记忆，要用 `thread/inject_items` 或 `turn/start` 的 `additionalContext` 放进去，或者开新会话。product.md 3.6"记忆在会话开始或恢复时放进去"的 Codex 一半按这个做，先按本文 4.2 改 product.md。
- s37：今天的 `thread/start` 会把 bot 的工作区写进用户 `config.toml` 的信任记录（e05），和 3.6"不改用户的全局配置"不符。会话层传 `projects.<cwd>.trust_level` 就不写；`untrusted` 会跳过项目里的 AGENTS.md（读源码，没实测），要加载就传 `trusted`。但 `trusted` 还会加载工作区和仓库里 `.codex/` 的项目配置、hooks 和 exec policy（读源码，没实测），会话层没覆盖的设置会被它们改掉，比如多出 MCP；开工时定怎么处理。拼错的字段和配置键都被静默忽略，实验字段生没生效要自己核对：`runtimeWorkspaceRoots` 看回包回显，MCP 看 `mcpServerStatus/list`，skill 看 `skills/list`。
- s39：按 e05 把最低版本抬到 0.156.1（见 s03 留下的）。起会话和恢复会话都传 `runtimeWorkspaceRoots`，不靠 0.156.1 起 resume 会保留它；回包回显的和传的不一致就报错。第二个根能写、根外被拒、`.git` 只读时 `git commit` 会不会失败，JP-VPS 上测不了（bwrap 起不来），只在 Mac 检查里看；macOS 上 `feishu` 权限配置加 `runtimeWorkspaceRoots` 时经沙箱读 AGENTS.md 正不正常，也一起看。第二个根里的 AGENTS.md 不会加载（e05），照 3.6 在指令里写"先读该仓库的 AGENTS.md"。
- s40：product.md 没定写入方式。这里选"agent 直接写文件，daemon 前后比对"，不在群里另开记忆命令，和 3.7"群里不能用设置命令"一致。公共记忆只在私聊里由 s54 的设置命令写。

### M8 skill、MCP 和查飞书上下文

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s43 | 本机 skill 库和 MCP 库 | skill 从三个目录或本机文件夹拷进来，校验 SKILL.md，记下带不带脚本；MCP 从 Codex、Claude 的配置导入或手填；都不收 git 地址（3.6） | 970 | s38 | 错误路径 | 无 |
| [ ] | s44 | skill 和 MCP 按名单交给会话，新 bot 不带 Claude 的个人指令 | 按位置算生效名单，交给 Codex 和 Claude 的会话层参数；向导新建的 bot 不带 Claude 的个人指令和两家的个人 skill，Codex 的 `~/.codex/AGENTS.md` 照常带上，指令里声明 bot 的规矩优先；导入的不变（3.6） | 740 | s43、s37、e02、e05 | 子进程、错误路径 | 真实 Codex：用得上 bot 的 skill、看不到个人 skill、MCP 起得来、resume 后还在；新 bot 的 Claude 会话不读 `~/.claude/CLAUDE.md`；`~/.codex/AGENTS.md` 里和 bot 冲突的规矩，bot 的指令压得住 |
| [ ] | s45 | skill 和 MCP 页面，bot 和群的启用名单 | 两个库页面，删除时列出还在用的 bot 和群；Bot 页的启用名单，群详情页的增减（3.6） | 550 | s43、s41、s42 | — | 无 |
| [ ] | s46 | 会话令牌和 agent 调 vonvon 的入口 | 每条会话一个令牌，经环境变量交给 agent；host 加一个只接 POST 的路由，子进程依次校验令牌、私聊、触发人、开关（3.7） | 520 | s37、e04 | 子进程、并发、关闭清理、错误路径 | agent 调不调得到 vonvon、带不带得上令牌：Codex 只读、读写、关网各一次，Claude 沙箱一次 |
| [ ] | s47 | vonvon settings 和 vonvon feishu 命令行框架 | 在 s07a 的命令上加：两组命令从环境变量读地址和令牌，不拿数据租约，输出 JSON；飞书组先做群列表和群成员（3.7） | 380 | s46、s07a | 错误路径 | 无 |
| [ ] | s48 | vonvon 飞书 skill：列话题、读另一条会话、读飞书消息 | 列本群话题、按会话 id 读另一条会话、按话题或时间读消息；只放行同一个 bot、同一个群、档不高于自己的会话；卡片写"读了话题 T1、T2 的会话"（3.5"查飞书上下文"） | 950 | s47、s44、s13、e02、e11 | 子进程、错误路径 | 无（M8 验收前，预览版任务按 3.5 时间线第 7 步跑一遍） |

开工要点：
- s44：`~/.codex/AGENTS.md` 按会话关不掉（e05，4 个版本；会话层 `project_doc_max_bytes: 0` 只关项目里的那份）。owner 2026-10-15 定（选了 A）：接受，带上它，在 bot 的指令里声明 bot 的规矩优先；product.md 3.6 已跟着改。`thread/start` 回包的 `instructionSources` 列出实际加载的文件，可以显示在桌面端。
- s44：bot 的 MCP 在 `feishu` 权限配置（`approvalPolicy: never`，工作区可写）下不配 `default_tools_approval_mode: "approve"` 时调用被拒（e05，0.162.1，只见过一次），和第 9 节第 2 项的推断一致；只读档和完全访问档不配会怎样没测，开工时补测。用户的个人 skill 先 `skills/list` 列出，再用 `skills.config` 逐个禁；系统 skill 用 `skills.bundled.enabled: false` 关。按名字禁会连同名的 bot skill 一起禁，按 `path` 禁没实测，开工时补测。中途换 skill 名单从 0.148.0 起下一轮生效，最低版本 0.156.1 时不用为这个开新会话。
- s44：Claude 一侧按 e02 第 6 节：新建的 bot 用 `claudeMdExcludes`（经 `options.settings` 传）或只给 `settingSources: ['project']`，导入的 bot 照旧。
- s46：变量名避开 TOKEN、KEY、SECRET，Codex 默认会滤掉含这些词的变量。e04 证明连不上时，按 product.md 第 9 节第 2 项的退路，把同一组命令做成 vonvon 自己的 MCP 工具，这一片照那个做。
- s48：飞书 skill 的 SKILL.md 随 daemon 包发，每个会话都装。
- s48：读 Codex 的会话按 e11：用常驻的 utility 进程发 `thread/turns/list`，带 `itemsView: "summary"`，服务端只留用户消息和 `phase: "final_answer"` 的回答；按 `nextCursor` 翻页，要最近几轮就用默认的 `desc` 加 `limit`。不用 resume、不花额度、不传 cwd。`thread/read` 带 `includeTurns: true` 在 0.162.1 上已标过时，`thread/items/list` 读不了旧格式，都不用。今天的 `mapTurn`（`D/agent/codex-appserver/backend.ts:723`）把 commentary 也拼进回答，不能直接复用；仓库里生成的协议比 0.162.1 旧，没有 `ThreadTurnsListParams`、`TurnItemsView`，按 s03 定的版本重新生成或手写这几种类型。今天的 `readHistory`、`readSessionTitle`（`backend.ts:597-641`）也用 `thread/read`，每次多一条 `deprecationNotice`，顺手换掉。
- s48：e11 读到的几种特殊情况：正在跑的会话最后一轮显示 `interrupted`、只有用户消息，和真被打断的一样，utility 进程看到的状态永远是 `notLoaded`，所以按 daemon 自己的记录写"这一轮还在进行"；还没跑过回合的会话报 `thread not loaded`，和 id 不存在的错一样，s13 登记表里有的按空会话返回；压缩单独算一轮、条目为空，跳过；`status` 不是 `completed` 的轮单独标出。
- s48：读 Claude 的会话时，把那条会话记下的 cwd 作为 `dir` 传给 `getSessionMessages`，自己滤掉工具步骤、思考块和合成的通知条目；子 agent 的消息不在里面（e02 第 5 节）。

### M9 私聊

原 s52 并进了 s51a 到 s51c，编号 s52 不再使用。

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s49 | 主人和管理员私聊直接干活 | 私聊走单会话的回合路径，用 bot 的主工作区、名单和默认档；私聊里能 `/new`、`/resume`；私聊里的话题单独成会话（第 4 节、3.5） | 500 | s37、s36、s38、e10 | 并发、错误路径 | 无（M9 验收时看主人和另一个管理员各有一条会话） |
| [ ] | s50 | 陌生人私聊卡片和私聊设置页 | 不是管理员的人私聊，回"在群里 @ 我"并列出共同的群；设置页能改私聊用的工作区、skill、MCP、权限档、后端和模型（第 4 节） | 520 | s49 | 错误路径 | 无（陌生人收到的卡片和群链接，M9 验收第 2 步由 owner 请同事看） |
| [ ] | s51a | 拿掉私聊控制台（一）：菜单和运维卡 | 删私聊首页菜单（含"安装桌面版 · Windows x64"按钮）、bot 菜单事件的路由和引导文案里的 menu_v6，以及体检、重连、重启、更新、用量和分享这些私聊卡（第 4 节） | 900 | s49 | — | 无 |
| [ ] | s51b | 拿掉私聊控制台（二）：项目和权限卡 | 删新建项目、项目列表、话题、删除确认、项目设置、权限、默认模型、白名单、管理员这些私聊卡，以及被拉进群时私聊发的绑定卡（第 4 节） | 950 | s51a、s36b | — | 无 |
| [ ] | s51c | 拿掉私聊控制台（三）：设置卡 | 删全局设置、语音、云文档评论、会话标题、看门狗和完成提醒这些私聊卡和它们的测试（第 4 节） | 950 | s51b | — | 无 |
| [ ] | s53 | 飞书应用的所有者、管理员和开发者都能管 bot | 开了 self_manage 时读所有者和协作者名单，缓存 10 分钟；管理员判断读"飞书名单 ∪ 扫码人 ∪ 本机名单"；设置页标出来源（第 6 节） | 640 | s01 | 并发、错误路径 | 开了 self_manage 的测试 bot 在真实租户里读出所有者和协作者 |
| [ ] | s54 | 私聊里改个性、记忆、skill 和 MCP | 设置命令改 SOUL、AGENTS、SMART、三种记忆、skill 和 MCP 名单，只限这个 bot；设置 skill 只放进私聊会话；加"聊天改设置"开关，默认开（3.7） | 700 | s47、s49、s43、s44 | 并发、错误路径 | 无（M9 验收前，预览版任务用真实 Codex 和 Claude 各让 bot 调一次设置命令） |
| [ ] | s55 | 私聊里改工作区、模式和权限档 | 设置命令加仓库和工作区、智能或规则模式、权限档、访客档和网络（3.7） | 300 | s54、s36 | 并发 | 无 |
| [ ] | s56 | 改完的卡片、撤销和扩大能力的标记 | 改完在私聊发卡写改前改后；装 MCP、装含脚本的 skill、加目录、升档、开网单独标出；［撤销］只有主人和管理员能点（3.7、3.8） | 380 | s54、s55 | 并发、错误路径 | 无 |
| [ ] | s57 | 建群和拉人 | `group create` 建群（默认完全访问）并把触发人拉进来；`group invite` 按 open_id 拉人；已有的群只回拉 bot 进群的步骤（3.7） | 260 | s54、e10 | 错误路径 | 无（M9 验收时 owner 让 bot 建群并把自己拉进去） |

开工要点：
- s49：私聊里有话题（e10）：用户开的和 bot 用 `reply_in_thread` 开的，事件里都带 `thread_id`，按 `thread_id` 单独成会话，和群里一样。
- s51a 到 s51c：开工前先在草稿上用 `git diff --stat` 量，超过 1500 行再拆。每个 PR 里列一张"私聊卡片 → 网页上的对应页面"对照表；s51b 删之前逐项确认网页有替代：新建项目、绑群、权限、白名单、管理员；s51c 也一样：语音、云文档评论、会话标题、看门狗、完成提醒。其中语音、云文档评论、完成提醒是 3.12 要保留的，看门狗按 3.12 改成 10 分钟（s11）。网页上没有对应开关的，先在同一片里补上再删卡。群里 `/settings` 用的 GS 卡，`tierLabel`、`permissionSummary` 这些共享函数，以及群里 `/usage` 等命令要用的卡片都保留。
- s51a 到 s51c 和 s54 改 `handle-message.ts` 的同一段，不要同时在飞。
- s53：从飞书来的人不能在本机删。缺权限或接口出错时保留上一次的结果，从来没拿到过时退回"扫码人加本机名单"。
- s57：拉人要 `im:chat.members:write_only`，它现在在可选的进群权限组里。e10：机器人能自己进公开群（`PATCH /im/v1/chats/:chat_id/members/me_join`），私有群回 HTTP 400、`code 232008`。lark-cli 建的群默认私有；客户端建群的默认值没查，开了入群审批的公开群能不能进也没测，开工时补。product.md 3.7 写的是"机器人自己进不了已有的群"，改成"公开群 bot 自己进"是承诺变强，属于本文 4.2 第 3 类：owner 2026-10-15 定（选了 B）：不用 `me_join`，已有的群一律发拉 bot 进群的步骤；product.md 3.7 的承诺不变，只改了事实。自己进群也会推 `im.chat.member.bot.added_v1`，操作人是 bot 自己，今天的 `onBotAddedToChat` 把它记成 `bot-added-nonadmin`、什么也不做；要和别人拉它进群（s36b）分开处理，绑定不靠这个事件触发。`me_join` 靠哪个权限，开工时用只开一个权限的应用试一次。

### M10 从 bridge 迁移

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s58 | 迁移前的清理：删掉没上线的改名迁移 | 删从没上线的改名迁移（cli-bridge 和它的 Windows 分支由 s02c 删） | 450 | — | — | 无 |
| [ ] | s59 | 导入预检 | 从 #226 移植预检、本地文件读取和旧密钥库，去掉准入互斥锁和 Windows 部分；每个 bot 只读地查第 5 节第 2 步那几项 | 1180 | s58 | 数据迁移、macOS 原生、错误路径 | 用 bridge 0.6.14 的数据副本和隔离的 HOME：预检和实际一致，真实主机名能解开密钥，launchctl 看得出 bridge 在跑 |
| [ ] | s60 | 把 bridge 的数据换算成第一版的形状 | 一个纯函数：bot 照搬，管理员进本机名单，个人指令照旧带上；每个群变成规则模式下的覆盖，cwd 原地引用（第 5 节） | 320 | s59、s36、s21、s12 | 数据迁移 | 无 |
| [ ] | s61 | 导入事务（上）：停 bridge、占锁、复制、回滚 | 第 5 节第 3 到 5 步：调 bridge 自己的 stop，按 bridge 的格式占锁，复制并用新密钥重新加密；任何一步失败就倒序回滚，再 start bridge | 650 | s60、e07、e08 | 子进程、并发、关闭清理、错误路径、数据迁移、macOS 原生 | 在 Mac 的测试用户账号里装 bridge 0.6.14：前半段后 plist 被删、手动 run 被拒；复制后故意失败，回滚后 bridge 重新起来 |
| [ ] | s62 | 导入事务（下）：Codex 兜底、hook、启动、回执 | 第 5 节第 6 到 9 步：找 codex，备份后卸掉 bridge 的 hook，启动全部 bot，写迁移标记和回执；之后每次启动都占 bridge 的锁 | 450 | s61 | 子进程、并发、错误路径、macOS 原生 | 同一个测试用户账号里从头导入：旧会话接得上，卸掉 hook 后审批回到终端里问；第 8 步故意失败能回滚；导入后手动 run 被拒 |
| [ ] | s63 | 导入页 | 发现 bridge 就显示导入页：预检表、"会感到的变化"和"失去"两张清单、进度、回执；清单加"可选：从 bridge 导入"，只在 macOS 显示（第 5 节） | 520 | s62、s04 | 错误路径 | 无（M10 验收前，预览版任务在测试用户账号里走一遍导入页） |
| [ ] | s64 | bridge 最后一版（feishu-codex-bridge 仓库） | 从 0.6.14（`6698118`）开分支：看到迁移标记就拒绝启动，stop 和 status 给提示，第一次启动给主人发通知（第 5 节、第 8 节第 4 条） | 200 | s62 | 错误路径 | 无（发布前由 owner 在飞书客户端里看通知） |

开工要点：
- s58、s59 不依赖 M3 到 M9，M4 之后在第二条线上做。
- s58：从没上线的改名迁移（`data-root-migration.ts` 等）生产路径调不到，做法又和第 5 节"复制数据、旧目录原地引用"相反，留着会让 s59 的预检读到两套说法，所以在迁移前删掉。`~/.vonvon-bridge` 的识别在 s59 里按预检的需要重写。
- s59：合入后在 #226 里写明移植了哪些代码，先不关。
- s59：预检只直接导入有 `bots.json` 的安装。没有它的老式平铺安装，bridge 下次运行时会把顶层的 `processes.json` 改名到 `bots/<appId>/processes.json`，盖掉 vonvon 写的锁（e07 第 8 条）。用过 0.6.x 的应该都有；遇到没有的怎么办（比如提示先让 bridge 跑一次升级目录）开工时定，要是变成不导入，按本文 4.2 第 3 条问 owner。
- s61：按 e07：bridge 的锁每个 bot 一把，在 `~/.feishu-codex-bridge/bots/<appId>/processes.json`，`appId` 要和目录名完全一致，调 v2 的 `acquireSingleInstanceLock` 时显式传这个路径。持有者是同一用户下、活过整个事务的进程，由它自己写锁，不复用旧记录、不自己拼 `startedAt`。`stop` 以后 bridge 还在优雅退出，要轮询重试到抢到为止并设上限；抢不到时持有者已不是预检看到的那个 bridge，就按失败回滚。回滚时先放锁再 `start` bridge，不然被拉起的 `run` 会被自己的锁拒掉。抢锁本身是原子的，不用另加互斥。
- s61、s62：锁挡得住 `run`，挡不住 `start`（e07，读代码）：`start` 不看锁，照样写 plist、bootstrap，被拉起的 `run` 反复被拒，第 3 步去掉的自启就装回来了。写迁移标记前再查一次 bridge 的 plist 和 launchd 任务，还在就再 `stop` 一次。多 bot 模式下 supervisor 的子进程被拒后按 1 到 30 秒退避一直重启，一放锁最多 30 秒就连上，所以 s62 的"之后每次启动都占 bridge 的锁"要保留。product.md 第 5 节第 4 步先按本文 4.2 改。
- s62：长期占锁时，0.6.14 的报错会叫用户 `kill <pid>`，那个 pid 是 vonvon 的 daemon。用户照做后 bridge 抢到锁，vonvon 再起来时抢锁抛 `BridgeAlreadyRunningError`：这时这个 bot 不启动，告诉主人 bridge 正在跑它。一次给多个 bot 占锁时共用一个 exit 回调，免得 11 把以上时 Node 打 `MaxListenersExceededWarning`（e07）。
- s62：卸 hook 的代码和认 bridge hook 的规则从 #226 分支的 hook 改写代码移植，和 s02c 删不删 `D/cli-bridge/` 无关。合入后在 #226 里补上这部分，再关闭它。
- s61、s62：Mac 检查放在测试用户账号里，因为那个账号有自己的 launchd 域，停 bridge 时不会碰到 owner 账号里同名的任务。
- s64：PR 在 feishu-codex-bridge 仓库，不占本仓库的在飞名额。下载地址等 M11 定下来再填，什么时候发布由 owner 定。先看迁移标记再拿锁，换掉 0.6.14 那句叫人 `kill` 的提示（e07）。

### M11 公开发布准备

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s65 | 公证的 universal dmg、更新源和许可证 | universal 包，hardened runtime 和 entitlements，公证；版本号统一写入；生成更新清单和 feed；许可证改成 UNLICENSED（第 8 节第 1、3 条） | 370 | — | macOS 原生 | 用 owner 的证书签名并公证：Gatekeeper 放行，Apple Silicon 和 Rosetta 下都能启动，能检查并装上新版 |
| [ ] | s66 | 公开版里 Claude 只用 API key（要不到书面确认时才做） | 公开构建里 Claude 不复用本机登录，只用主人填的 API key；开发版和自用版不变（第 8 节第 2 条） | 250 | s03 | 错误路径 | 公开构建里 Claude 只用 API key、不读钥匙串里的登录（要 owner 给一个 key） |
| [ ] | s67 | 发布前的 Mac 验收 | 第 8 节第 5 条的 Mac 一半：在没有 bridge 的 macOS 用户上，用公开的 dmg 从零安装、扫码、开权限、第一次对话；结果写进本文第 10 节 | 30 | s65、s63；s64 已准备好即可 | — | 全部在真机和真实飞书里做，扫码由 owner 来做 |

开工要点：
- s65：今天 `build.mjs` 写死版本 0.1.0，而更新比较用的正是它。bridge 和 Paseo 的许可声明（NOTICE、LICENSE.bridge、LICENSE.paseo）今天已经随 npm 包和桌面包发，只改 license 字段。
- s67：先由预览版任务装好，Codex 走一遍不需要扫码的部分，再交 owner 验收。Linux 那一半在 s20b 做。

## 4. 实验清单（M0）

### 4.1 实验

第 9 节要实测的事，按下表做。结果放进 `docs/research/` 下新的日期目录（例如 `<日期>-v1-spikes/`），按那里 README 的规矩加一行。一个实验一个纯文档 PR，同时出结果的可以合成一个；不占在飞名额。临时脚本不进仓库。Mac 上的实验先开它的文档 PR，PR 里写清要测什么，再在 PR 里贴检查提示词，往 #322 贴一个检查任务指过去（`AGENTS.md`"工具和同步"）。一个检查任务只接约 30 分钟能做完的事，做不完就拆成几个任务，或拆成几个实验。Mac 上的实验和各切片的 Mac 检查都排在 #322 里，Codex 一个一个做，不同时做。e03 在 Mac 上跑 Claude SDK 是测产品，见本文第 7 节。

| 状态 | 编号 | 测什么 | 在哪做 | 怎么测 | 挡住 | 最晚在 |
|---|---|---|---|---|---|---|
| [x] | e01 | 第 1 项：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 经 Agent SDK 能不能让主回合等子 agent | JP-VPS | 用 SDK 0.3.296 和已有的 Claude 登录，带和不带这个变量各跑一次：并行起两个 Task 子 agent 加一个后台 Bash，看 result 是不是等子 agent 都结束才来，后台 Bash 是不是被关掉 | s35 | s35 之前 |
| [x] | e02 | 第 11、12 项里不要沙箱的部分，第 18 项的 Claude 一半，加上 claudeMdExcludes | JP-VPS | 用记录每次调用的 canUseTool 看哪些请求走到回调；今天 AskUserQuestion 是否被拒；运行中 setPermissionMode 和重开 resume 的差别；agentID 等字段从哪个 SDK 版本有；getSessionMessages 能否读别的 cwd 下的会话；claudeMdExcludes 能否排除 `~/.claude/CLAUDE.md`（不改这个文件） | s31、s44、s48 | s31 之前 |
| [ ] | e03 | 第 11、12 项里要 macOS 沙箱的部分 | Mac | 只读用 default、读写用 acceptEdits，加今天的 Seatbelt 沙箱和记录回调的 canUseTool，看 cwd 外的读写、不在名单里的主机、WebFetch 哪些走到回调；今天的 bypassPermissions 下关网能否 curl 出去、能否写到 /tmp。Mac 上没有 Claude 登录时回"卡住了" | s31、s39 | s31 之前 |
| [ ] | e04 | 第 2、4 项：沙箱里调 vonvon 命令行，`.git` 只读 | Mac | Codex 只读、读写、关网三种设置下和 Claude 的沙箱里，从 agent 的 shell 连 127.0.0.1 上的测试服务（TCP 和 Unix socket 各一个），看能否连上、能否从环境变量读到令牌；workspace-write 下在 git 目录里 `git commit` 会不会失败 | s37、s39、s46 | s37 之前 |
| [x] | e05 | 第 3 项：Codex 会话级配置 | JP-VPS | 用 s03 定的最低版本和 JP-VPS 上装的当前 Codex CLI 各测一次，最低版本那次用 npm 另装一份旧的 codex：会话级 mcp_servers、runtimeWorkspaceRoots、skills/extraRoots/set 能不能用，resume 后还在不在，中途能否换 skill 列表；memories 的两个键能否在会话层关掉；`~/.codex/AGENTS.md` 能否按会话不加载。结果决定 Codex 的最低版本，在 s39 写回 s03 的常量。Mac 上应用里带的也是 codex 程序（ChatGPT.app 里有一份，装了 Codex.app 的也有），s39 的 Mac 检查顺带用应用里的那份确认一次 | s37、s39、s44 | s37 之前 |
| [x] | e06 | 第 5 项：LaunchAgent 和钥匙串 | Mac | 手写一个 LaunchAgent，用打包版 app 里的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑小脚本：能否用钥匙串里的 Claude 和 Codex 登录；"允许在后台"里显示什么，关掉后 `launchctl print` 显示什么；kill -9 后多久被拉起，退出码在哪个字段；怎么判断用户重新登录过。测完卸载 | s07、s17 | s07 之前 |
| [x] | e07 | 第 10 项（预查）：bridge 的锁 | JP-VPS | 临时 HOME 下用 v2 的 acquireSingleInstanceLock 写一份 bridge 格式的锁，再用 bridge 0.6.14（`6698118`）的同名函数去抢，应该抛 BridgeAlreadyRunningError；再看持有者退出后锁失效、startedAt+15s 那条判断 | s61 | s61 之前 |
| [ ] | e08 | 第 10 项（真机） | Mac | 在 Mac 的测试用户账号里装 bridge 0.6.14，用数据副本和测试 bot：写入锁后 run 被拒，`start` 本身不被拒、会重新装好 plist 和 launchd 任务，被拉起的 run 反复被拒（e07 读代码的结论）；stop 删掉 plist 和 launchd 任务，bridge 多久退干净；持有者退出后锁失效；多 bot 模式下子进程也被拒；macOS 的 `ps -o etime=` 是否和 Linux 一样。没有测试用户账号时回"卡住了" | s61 | s61 之前 |
| [ ] | e09 | 第 13 项：卡片里的 @ 会不会提醒人 | JP-VPS 和 owner | 测试 bot 往测试群发一张带 `<at>` 的卡片和一条带 @ 的文字。JP-VPS 上看消息数据：卡片里的 `<at>` 算不算提到了人。两条在飞书客户端里有没有"有人@我"的标记和通知，由 owner 看 | s30 | s30 之前 |
| [x] | e10 | 第 6、14、15、16 项和第 17 项后半：飞书平台（"同时发送到群"和给没开过会话的人发私聊没测，留给 owner，见下） | JP-VPS（客户端里看的由 owner 看） | 用测试 bot 的应用身份调接口，lark-cli 以 owner 的用户身份发消息：机器人能否自己进已有的群；`with_sender_name` 拿不拿得到名字；能否拉到别的 bot 卡片回答的正文；话题里的引用分不分得出是哪条；"同时发送到群"收几次事件；私聊里的话题；能否给没开过会话的人发私聊；断线期间的消息重连后会不会补推。只有客户端里才看得到的，留给 owner 找同事看：没开过会话的人收到的私聊在客户端里怎么显示、有没有通知。测"同时发送到群"要有人发一条这样的消息，lark-cli 发不出来时，改在客户端里发 | s09、s14；s18、s22、s27、s49、s57 也用它的结果 | s09 之前 |
| [x] | e11 | 第 18 项的 Codex 一半 | JP-VPS | 用真实 Codex 起两条线程、关掉一条，再用 utility 进程发 thread/read，看不加载线程能不能读到用户消息和最终回答 | s48 | s48 之前 |
| [ ] | e12 | 第 9 项：判断的延迟和额度 | JP-VPS | s23 合入后，用 Codex 订阅的 gpt-6-luna 和 Claude 订阅的小模型各跑 50 次判断，记延迟分布和额度变化，用来定 s25 每群每小时的上限。额度看各自的账户页面，跑之前和跑完由 owner 各读一次 | s25 | s25 之前 |
| [ ] | e13 | 第 7 项：企业租户的权限审核 | — | 不单独做，现在没有企业租户。清单里写一句"企业租户里新权限可能要管理员审核"；M11 时 owner 手里有企业租户，就顺手看一次 | — | — |
| [ ] | e14 | 第 8 项和第 17 项前半 | JP-VPS | M3 验收时在 JP-VPS 上看：用 `codex resume` 和 `claude --resume` 打开 bot 的群会话，看到的和 bot 是否一样，两边同时写会怎样；手动 `/compact` 后摘要里引用行还在不在。Codex 应用里打开是什么样，可以在 Mac 上顺带看，不是必做。只影响说明文字和"最近 5 个活跃话题"那张表 | — | M3 验收时 |

e01、e02 已做完，结果在 `docs/research/2026-10-14-v1-spikes/`。e02 没测完的两件写进了 s31 的开工要点。

e05、e06、e07、e10、e11 已做完，结果在 `docs/research/2026-10-15-v1-spikes/`，对各片的影响写进了开工要点（s03、s09、s14、s18、s22、s23、s27、s31、s37、s39、s44、s48、s49、s57、s59、s61、s62、s64）。没测完的：e05 的第二个根能不能写归 s39 的 Mac 检查；e07 的真机部分在 e08；e10 的"同时发送到群"在 s14 之前、给没开过会话的人发私聊在 s18 之前由 owner 做，断线补推在 s09 开工时用 daemon 自己的长连接再测。和 product.md 不一致的几处按 4.2 处理。

按 Linux 先行（本文第 1 节），只有 e03、e04（macOS 沙箱）和 e08（Mac 的测试用户账号）整个留在 Mac 上，e09、e10 只把客户端里看的部分留给 owner，Codex 不碰 owner 的飞书客户端。

Mac 上按最晚期限排：e03、e04、e08，一次一个。e10 留给 owner 的两项在 s14、s18 之前，e09 在客户端里看的部分在 s30 之前，Claude 分别请 owner 做。

JP-VPS 上剩下的按最晚期限排：e14（M3 验收时）、e12（等 s23 合入）、e09 看消息数据的一半。

### 4.2 实验结果和 product.md 不一致时

1. 先开一个只改 `docs/product.md` 的纯文档 PR，写清改了什么、为什么，以及属于下面哪一类。产品切片等它合入后再按新说法做。
2. 不改用户能感到的承诺：照 owner 的回答改写；或者实测发现某个接口做不到、某个版本才有，换一种做法仍能兑现 product.md 的承诺。Claude 找另一个模型审查后合入，不等 owner 认可。依据：owner 在被请求认可 #294（按 owner 第 19 到 29 题改的 product.md）时说"不是每条 PR 都要我认可吧？"。实测修正事实这一种是 Claude 照这句话补的，owner 可以改。
3. 改了承诺或范围：用户能感到的承诺变弱或变强，或者多做、少做某件事，不管起因是不是实测。用【需要你决定】通知 owner，等 owner 定。例如 s44：`~/.codex/AGENTS.md` 关不掉，"新建的 bot 默认不带个人指令"（3.6）就做不到，算这一类（owner 2026-10-15 已定，见 s44）。

product.md 开头的状态说明按这三条写（s01 改的）。

## 5. Claude 定的默认值

product.md 没给值、由 Claude 定的。owner 可以在任何时候改。

| 项 | 默认值 | 理由 | 用在 |
|---|---|---|---|
| bot 默认权限档 | 读写、开网。只给私聊用，群在建立时有自己的默认档（3.8） | 管理员包含飞书应用的开发者（第 6 节），他们都能私聊 bot。私聊默认完全访问，等于把主人 Mac 上执行任意命令的权限交给所有开发者。读写档下 agent 只能写工作区，越权直接拒绝，和 owner 第 23 题"超出权限就直接拒绝"一致。主人要完全访问，在桌面端或网页里改 | s36、s49 |
| Linux 上用 Codex 时的私聊 | Linux 的首次运行清单加一步，写明"Linux 上 Codex 只能用完全访问"，由主人自己选要不要把 bot 默认档改成完全访问，不自动放开 | 读写档在 Linux 上的 Codex 起不来（3.8） | s20a |
| 群没设工作区时 | 只用群自己的目录，不带 bot 的其余工作区；代码仓库照常继承 | 每个群的文件和记忆分开（3.3） | s36 |
| 每群每小时的判断上限 | 60 次，e12 量完再调 | 3.4 要求有上限，没给数 | s25 |
| 许可证 | UNLICENSED | 第一版闭源，第 8 节第 3 条要求发布前改掉 MIT | s65 |
| Linux 验收在哪做 | JP-VPS 上的普通用户账号，做完卸载 | 第 8 节第 5 条要一台 systemd 主机 | s20b |
| 被拉进群时 | 直接绑定，不再私聊发绑定卡 | 第 4 节拿掉私聊控制台；被拉进的群用什么默认档，3.8 已经给了 | s36b |
| 记忆怎么写 | agent 直接写自己那份记忆文件，daemon 在一轮前后比对，卡片显示写了什么 | 3.6 只说"记住"能写、带撤销，没说怎么写；不在群里另开记忆命令，和 3.7"群里不能在聊天里改设置"一致 | s40 |
| 改设置卡片上的［撤销］谁能点 | 主人和管理员 | 3.7 只说带撤销；和 3.8 里"Claude 自己要问的"卡一样 | s56 |
| Codex 最低版本 | 0.139.0，比它旧显示"版本太旧"、按钮是更新 | vonvon 依赖的行为实际跑过的最老版本（第 3 节 s03 开工要点）。e05 测出它用 ChatGPT 登录，试过的模型都跑不了，要抬到 0.156.1，见 s03 留下的 | s03、s39 |
| Codex 验证过的版本 | 跟托管安装锁定的版本，现在是 0.156.1；比它新的照常用，只在本机环境页写一句"比验证过的新" | 只有这个版本完整跑过；新版本大多兼容，拦住反而让用户装旧版 | s03 |
| 首次运行清单多久查一次飞书 | 10 秒，只在清单页开着时查，只查还没做完的 bot，一个一个查；全部变绿就停，点"重新检测"马上查 | 每查一个 bot 要调四五个飞书接口；长连接状态直接从快照来，不用查 | s04 |
| Claude 登录结果留多久 | 已登录留 30 分钟，其他留 5 分钟；点"检查登录"马上重查 | 每查一次要起一个约 250 MB 的 CLI，本机环境页每次打开都会问。daemon 自己不查，首页只显示上一次查到、还没过期的结果 | s03 |
| 预览版 | 只出 Apple Silicon，不公证 | 只装在 owner 自己的 Mac 上验收；universal 包和公证在 M11（第 8 节第 1 条） | 本文第 7 节 |

## 6. Windows 代码去留

第一版不做 Windows（product.md 第 7 节），不写新的 Windows 专属代码，CI 不跑 Windows（#290）。已有的代码要删，但不为 Windows 单独铺开改动，分三类。

**一、专门开两片来删：s05a、s05b**（约 1,890 行，没有用户可见的变化）
- 要删的：`D/service/windows.ts`、`win-startup.ts` 和三份 Windows 服务测试；`definitions.ts`、`identity.ts`、`registration.ts` 里的 win32 分支；`D/cli/index.ts:15` 白名单里的 `__win-relaunch` 和 `:57` 的命令本体。`D/service/control.ts:91` 正则里的 `__win-relaunch` 是识别 bridge 的兼容标识，保留。
- 理由：这些代码没有调用方，而 s06、s07 要改的正是这几个文件。先删，后台服务那两片就只剩 macOS 和 Linux 的逻辑，审查更集中，以后也少维护约 1,300 行。

**二、跟着本来就要改这些文件的切片一起删**
- s08b：`cli-registration.ts` 的 Windows PATH 注册和 `.cmd` 入口，命令行注册只认 macOS；`windows-native.test.ts`；electron-builder 的 win nsis 和 linux AppImage 目标；`daemon-dependencies.ts` 的 `windowsHide` 和两份桌面端测试里的 win32 小分支。删完以后桌面端（`packages/desktop`）不再有 Windows 代码。issue #288 按 product.md 3.10 以"第一版不做 Windows"关闭。
- s20a：`open.ts` 的 `cmd /c start`；协议平台枚举里的 windows，以及界面上的"这台 Windows 电脑"。
- s20b：Codex 只读、读写档的 win32 分支；`codex-appserver/windows-job.ts`、它的两处引用和两份测试。
- s51a：私聊菜单里的"安装桌面版 · Windows x64"按钮。
- s02c：cli-bridge 整个删掉，它的 cmd.exe 引号、命名管道、PowerShell 离开检测和 Windows 提示跟着没了；`config/paths.ts` 的命名管道分支。分在 s02c2 到 s02c5，见第 3 节的 s02c 拆法。
- s58：从没上线的改名迁移（`data-root-migration.ts`、`legacy-data-root.ts`、`host/migration.ts`）；`data-compatibility.ts` 的 Windows 分支。`isBridgeGetter` 还有人用，留下。
- s59：`D/service/control.ts` 里检测 bridge 的 Windows Run 键和计划任务。导入只做 macOS。

**三、先留着**
- `provider/process` 下的 windows-supervisor、windows-job-probe、windows-command-line，以及 `test/provider/windows-*` 测试。它们属于 ProcessHost；main 上 ProcessHost 只在启动时清理孤儿进程，第一版没有切片要改它，这些代码也只在 win32 上会走到。要删它们，得先定那层没接线的 provider 代码留不留，放到第一版之后一起定。
- Codex 协议生成的 `Windows*.ts`，这些是生成文件。
- 约 40 个文件里零散的 `process.platform === 'win32'` 小分支和 `windowsHide` 参数，都在 daemon 和 `scripts/` 里，桌面端的已随 s08b 删掉。以后改到这些文件时顺手删，不专门开 PR。

## 7. 预览版怎么出

一个里程碑按这个顺序验收（本文第 1 节"Linux 先行"）：
1. **先在 JP-VPS 上验。** 里程碑的片都合入后，Claude 用 main 的 head 先做完不需要 Mac 的步骤，用验收用的数据目录：飞书里的聊天步骤（建测试群、把 bot 拉进群、@ 它、看回复和卡片）用 lark-cli 以 owner 的用户身份做，改设置用 `vonvon` 命令行和无头打开的网页端。结果写进给 owner 的通知（owner 2026-10-15 要求）。发现问题就开 `claude/*` PR 修，合入后这一步重来。
2. **再在 Mac 上验网页端。** Claude 往 #322 贴预览版任务（见下面"Mac 上怎么打包"）。Codex 构建好之后先不打包：用隔离的数据目录在 Mac 上起 daemon 和网页端，查网页端连 Mac 上的 daemon，以及不打包也能查的 Mac 专属项，比如 launchd、钥匙串、Seatbelt 沙箱。要真 bot 的项第 1 步已经验过，这一步不注册新 bot。有问题 Codex 就停下贴结果，不打包，也不 push；Claude 开 `claude/*` PR 修，合入后再贴一个预览版任务。
3. **最后打包给 owner。** 第 2 步过了，Codex 才打包、装好 .app。装好后，Codex 用 Computer Use 打开装好的 app，做本文第 2 节标"Codex 先查"、要用装好的 app 的步骤，比如窗口、托盘、菜单、退出 app；要 @ Mac 上的 bot 时，Claude 用 lark-cli 接着做。这些都过了，Claude 才通知 owner；标"接着做""接着查"的步骤等 owner 做完前一步再做（本文第 2 节开头）。要用装好的 app 的步骤，用的是 owner 账号里真实装好的 app 和它的数据，所以只在预览版任务里做；Claude 的任务按里程碑和步骤号列出这次做哪几步，没列的不做，其余的查用隔离的数据目录。Mac 锁屏时 Computer Use 会失败（getpaseo/paseo#3346），按 `AGENTS.md`：停下，不重试，结果评论第二行写"卡住了："。owner 只做要人来做的：手机扫码、飞书开发者后台、在飞书客户端里点卡片按钮和看显示、注销再登录、要第二个人的步骤，以及 M10 什么时候迁移每天在用的 bridge。每个里程碑留给 owner 的是哪几步，写在本文第 2 节各里程碑的"怎么验收"后面。

**JP-VPS 上的验收环境。**
- 验收用一棵单独的 worktree，detach 在要验的提交上；用它自己的 `VONVON_HOME`，里面注册一个测试 bot。
- Codex CLI 装在 `~/.local/bin` 下，由 owner 登录；Claude 已登录。
- lark-cli 发的消息以 owner 的名义发出，bot 把它当主人的消息；要第二个人的步骤，仍按本文第 8 节找同事或第二个账号。JP-VPS 上的 lark-cli 没有 owner 的用户授权、授权过期或权限不够时，退回由 owner 手工做，并在通知里说明。只碰为验收建的测试群，不读 owner 别的聊天；群号、名字不写进仓库。
- 以用户身份 @ bot 要用 bot 的 open_id：用 lark-cli 的 `im +chat-messages-list --format json` 列出群消息，从 bot 自己发的那条取 `sender.open_bot_id`。
- 私聊也能做：用这个 open_id，`im +messages-send --as user --user-id <open_id>` 以 owner 的身份给测试 bot 发私聊，`im +chat-messages-list --as user --user-id <open_id>` 读出 bot 在私聊里回的消息和卡片。2026-10-15 在 JP-VPS 的测试 bot 上试过，发出去 bot 收到了，回的管理台卡片也读得到。M4 第 1 步和 M9 的私聊步骤靠这一条；授权过期、读不到时，和群里的步骤一样退回 owner 手工做。
- 用接口建群时把 bot 一起放进去，不会触发 `im.chat.member.bot.added_v1`。要测"机器人进群"的提示，先建群，再用 lark-cli 的 `im chat.members create`（`member_id_type=app_id`）把 bot 加进去。"查找已经加入的群"两种群都找得到。
- Claude 的只读、读写档在 Linux 上要 Claude Code 的沙箱，就是 `bubblewrap` 和 `socat`；没装时回合失败，报"Sandbox required but unavailable"。
- Ubuntu 24.04 上光装好还不够：`kernel.apparmor_restrict_unprivileged_userns = 1` 挡住了非特权的用户命名空间，bwrap 报"setting up uid map: Permission denied"或"loopback: Failed RTM_NEWADDR: Operation not permitted"，Claude 的 Bash 在只读、读写档下都失败。JP-VPS 上的办法：加一份 AppArmor profile，只给 `/usr/bin/bwrap` 开 `userns` 权限（和 Ubuntu 自己给浏览器的 profile 一个样子），用 `apparmor_parser -r` 加载；不全局关掉这个 sysctl。
- 2026-10-15 owner 经 SSH 加载了 bwrap 的 AppArmor profile（`/etc/apparmor.d/bwrap`）。`bwrap` 和 `socat` 已经装好；`kernel.apparmor_restrict_unprivileged_userns` 仍是 1，没有全局关掉。加载以后，在 JP-VPS 上跑 `bwrap --ro-bind / / --unshare-net true` 和 `bwrap --ro-bind / / --dev /dev --unshare-all --die-with-parent true`，都以 0 退出。所以 JP-VPS 上能验 Claude 的只读、读写档了，M6、M7 里这些步骤不再退回 owner 在 Mac 上验。还没用真 bot 的回合从头到尾再验一遍：第一次用到时，先在测试群里各跑一轮只读档和读写档；跑不通就退回 owner，并在通知里写明。
- Linux 上的 Codex 只能用完全访问（product.md 3.8，`D/agent/codex-appserver/backend.ts`），JP-VPS 上用 Codex 的测试群要明确改成完全访问。访客档没设时跟着管理员的档走（3.8"访客档照旧"），所以改成完全访问的测试群，访客也是完全访问；这种群里不放别人。

**Mac 上怎么打包。**
1. Claude 往 #322 贴一个预览版任务，提示词整份写在任务里，不再另开 `Mac 预览版 <里程碑名>` issue。Mac 上没有会话在处理队列时，Claude 请 owner 在 Mac mini 上新开 Codex 会话，模式选 full access（owner 2026-10-15），发一次"按 modelzen/vonvon-bot#322 正文做"。规则见 `AGENTS.md`"工具和同步"。
2. Codex 在临时 worktree 里取 Claude 给的 main sha，`npm ci`，`npm run build`，先按上面第 2 步查网页端，过了再在 `packages/desktop` 下用 `electron-builder --config electron-builder.yml --dir` 打包，也就是今天的 `package:dir` 脚本。electron-builder 会自动用钥匙串里的 Developer ID 签名。不公证，只出 Apple Silicon。
3. 打好的 .app 装进 /Applications，按上面第 3 步先做标"Codex 先查"的步骤，再由 Claude 通知 owner 验收。
4. 具体命令以仓库脚本为准。M1 预览版（2026-10-14）按第 2 条做通了，打包前补跑 `node node_modules/electron/install.js`，打包后验签，用 `ditto` 装进 /Applications。

下面几条来自 #296 的 Mac 检查和 M1 预览版：
- Mac 上的仓库，本地 main 可能是旧的（M1 预览版时停在 d90f4d4）。提示词里写明先 `git fetch`，核对 main 或分支的 sha 和 Claude 给的一致，再从那个 sha 建临时 worktree 构建。
- 打包和验签直接跑。以前用 auto 模式时，沙箱里打包跳过了签名（`0 valid identities found`），`codesign --verify` 报 `invalid signature`、`Authority=(unavailable)`，应该是沙箱看不到钥匙串，只好到沙箱外跑；full-access 没有这层沙箱。打完仍看 electron-builder 的输出里签上了没有，`codesign --verify` 要通过。
- `npm ci` 之后第一次打包缺 Electron 的二进制，原因没查（Mac 的 npm 版本没记）。打包前先跑 `node node_modules/electron/install.js`。
- auto 模式下，联网（`npm ci`、`gh`）、沙箱外的命令、打开 app、用 Computer Use 操作 app 都会发申请，没人批就一直等，#296 的检查卡在这里将近一小时。full-access 下没有这些申请，Claude 不用再盯着批；这次做什么、用哪些隔离目录、哪些不碰，都写在提示词里（`AGENTS.md`"工具和同步"）。
- 在终端里用 `open` 启动 app，会继承终端的长 PATH。要模拟从 Finder 打开，显式加 PATH：`open -n --env PATH=/usr/bin:/bin:/usr/sbin:/sbin --env HOME=<临时目录> ... <app>`。
- 测 Claude 时，隔离 HOME 下读不到 owner 的 Claude 凭据：owner 的凭据写在 `~/.claude/settings.json` 的 `env` 里，不在钥匙串。要测已登录，那一条命令用真实 HOME，VONVON_HOME 仍用临时目录。
- 退出桌面端不停 daemon（product.md 3.10）。测完用包里的命令行 `daemon stop` 停掉隔离 HOME 里的 daemon。
- 测后台服务（launchd）时不换 HOME，只换 `VONVON_HOME`，任务名就带上数据目录的哈希。launchd 拉起的 daemon 拿的是账号真实的 HOME，按它找自己的 plist；HOME 换成临时目录时 plist 写进了临时目录，daemon 找不到注册，按"没有注册"以 0 退出，安装等到超时回滚（#320 的第二轮 Mac 检查）。这时 plist 会写进真实的 `~/Library/LaunchAgents`，只许有那一个带哈希的文件，测完用 `service uninstall` 去掉。打开 app 时另带 `VONVON_DESKTOP_TEST_HOME`，免得往 PATH 里注册 `vonvon` 命令。

测 Claude 后端时，用 owner 本机的 Claude 登录跑少量回合。这是测产品，不是在 Mac 上开 Claude 的开发会话。

## 8. owner 要提前准备的事

这些不是问题，是提醒：要 owner 去办，多数要等很久，现在开始办才不会卡住。

| 事 | 什么时候要 | 说明 |
|---|---|---|
| Apple 开发者的公证凭据 | M11（s65） | 申请和配置要时间 |
| 公开的下载和更新地址 | M11（s64 的通知、s65 的更新源） | product.md 第 8 节第 1 条 |
| 向 Anthropic 要 Claude 登录的书面确认 | 公开发布前 | product.md 第 8 节第 2 条，可能要几周；要不到就做 s66 |
| 一位同事或第二个飞书账号 | e10（s18 之前）、M3 第 7 步、e09（s30 之前）、M6 第 4 步、M9 第 2 和第 6 步 | 验收时要有另一个人点卡片、私聊 bot |
| JP-VPS 上再加两个测试 bot | M5 之前 | M5 要同一台机器上三个 bot（一个规则模式、两个智能模式），JP-VPS 上现在只有一个。Claude 扫不了码，要 owner 扫码、在开发者后台发布 |
| JP-VPS 上给 bwrap 加载 AppArmor profile | 已做（2026-10-15） | owner 经 SSH 加载了，结果见本文第 7 节。M6 第 1 到 3、5 步和 M7 第 3 步不再退回 owner |
| bridge 最后一版什么时候发 | M10 之前定 | product.md 第 8 节第 4 条，s64 按这个时间发 |
| Mac 上的一个测试用户账号 | M10 之前（e08、s61、s62） | 不用等，但要 owner 用管理员身份建。停 bridge 会碰 launchd 里同名的任务，只能在另一个用户账号里测 |

## 9. 开发时的做法

只写 `AGENTS.md` 里没有的，或者容易忘的：
- 审查前先用 code-simplifier 把 diff 过一遍，再交给审查的子代理。
- 写网页和桌面端界面时用 frontend-design。
- 网页界面在 JP-VPS 上用 playwright 无头打开，截各种状态看。
- 新 worktree 跑 typecheck 前，先 build `@vonvon/protocol` 和 `@vonvon/client`，不然找不到它们的 dist。
- JP-VPS 上的 npm 11.19 默认不跑依赖的安装脚本，`npm ci` 后 electron 的二进制不在。要在 JP-VPS 上打 Linux 目录包（`electron-builder --dir --linux`）验证打包结果时，先跑 `node node_modules/electron/install.js`。Mac 上打包也缺过这个二进制，原因没查，见第 7 节。
- 行数可能超过 1500 的片（s06、s51a 到 s51c、s59），开工后先用 `git diff --stat` 量。

## 10. 记录

切片合入时在这里补。

**卸载步骤**（s08b 填）

macOS：
1. 在"应用与启动"页关掉"登录电脑时启动"，或者在终端运行 `vonvon service uninstall`。这会删掉 `~/Library/LaunchAgents/com.vonvon.bot.daemon.plist`；用开关关的，bot 改由一个分离的 daemon 接着跑。
2. 从菜单栏退出 Vonvon Bot。要先退出：app 开着时停 daemon，窗口会弹"连接断开"。
3. 运行 `vonvon daemon stop`。
4. 把 app 拖进废纸篓。到第 6 步删完数据之前别再打开它，打开会重建 `~/.vonvon-bot`、装回命令行入口并起一个 daemon。
5. 运行 `rm ~/.local/share/vonvon-bot/bin/vonvon`，再删掉 `~/.zshrc`、`~/.zprofile`（设了 `ZDOTDIR` 的，是 `$ZDOTDIR` 下的这两个）、`~/.bash_profile`（或 `.bash_login`、`.profile`）和 `~/.bashrc` 里 `# >>> Vonvon Bot CLI >>>` 到 `# <<< Vonvon Bot CLI <<<` 之间的几行。
6. 数据：`rm -rf ~/.vonvon-bot`（凭据、会话和记忆都在里面，删了找不回来），再删 `~/Library/Application Support/vonvon-bot-desktop`。这个目录名是 Electron 按 app 里 `package.json` 的 `name` 取的（stage 包没写 `productName`），还没在 Mac 上核对，s08b 的 Mac 检查顺手看一眼。
7. 先删了 app、没关开关的：运行 `launchctl bootout gui/$(id -u)/com.vonvon.bot.daemon`，再删掉上面那个 plist。
8. 可选：在飞书开发者后台删掉这个应用。

Linux：`vonvon service uninstall`，`vonvon daemon stop`，`npm rm -g vonvon-bot`，`rm -rf ~/.vonvon-bot`。linger 那一行由 s20a 补。

**Linux 验收**（s20b 填，product.md 第 8 节第 5 条的 Linux 一半）：待填。

**发布前的 Mac 验收**（s67 填，product.md 第 8 节第 5 条的 Mac 一半）：待填。
