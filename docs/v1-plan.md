# Vonvon Bot 第一版计划

这份计划把定稿的 `docs/product.md` 拆成里程碑、切片和实验。第一版做什么以 product.md 为准，本文不加它没有的功能，两者冲突时以 product.md 为准。每合入一片，就在本文第 3 节的清单里把它勾掉，写上 PR 号。本文随代码 PR 一起改，不为它另开文档 PR。同时最多两个产品 PR 在飞（`AGENTS.md`），所以切片分两条线做，见本文第 1 节。

切片和实验的 PR 不用 owner 认可：按 `AGENTS.md`，由 Claude 找另一个模型审查、CI 通过后合入。product.md 的修订按本文 4.2 分两类，只有改了承诺或范围的才等 owner。owner 出面的时候：里程碑验收；被叫去做决定；本文第 8 节列的提前准备的事。

写法和 product.md 一样："主人"指 bot 的主人，"owner"指本项目的 owner；`D/` 指 `packages/daemon/src/`。不带"本文"的节号都指 product.md，比如"3.5""第 9 节第 5 项"；本文自己的节写成"本文第 3 节"。行数都是约数，不含 lockfile 和生成文件。

## 1. 两条线和第一片

**两条线。**
- 第一条线先补齐必要基础，优先交付完整私聊、个性和个人记忆，再交聊天文字设置与真实回执/撤销。里程碑编号继续表示验收范围，不要求按编号串行；具体顺序见下面“2026-10-17 采用顺序”。当前里程碑范围做完仍出预览版给 owner 验收，提前完成某片不代表整个里程碑通过。
- 第二条线做依赖已满足、不挡第一条线的片：当前里程碑里能并行的片；下一个里程碑里没有依赖的片，比如 M2 的 s07a（Linux 先行的验收要用）、M3 的 s10、s11、s12、s16；拿掉咖啡一下的 s02b、s02c；M4 之后的迁移准备 s58、s59（本文第 2 节 M10）。尽量挑和第一条线不改同一批文件的片。
- 实验 PR 是纯文档，不占在飞名额，随时可以开（本文第 4 节）。

**2026-10-17 采用顺序。** owner 已接受 [Rakazo 源码研究](research/2026-10-17-rakazo/report.md) 的建议，采用完整私聊路线，保留所有权限、记忆和个人能力隔离前置，不做临时无记忆私聊：
1. s36c2b、s36c2c 已合入。2026-10-18 起：M5 的 s23c → s25，s36d（含新建群的稳定目录和最小保护）汇总 s36，实验 e04/e03 → s37，再进第 2 条的 s38；建群结果不明时的恢复 s36c2c4b、c4c 移到 v1 之后（owner 2026-10-18）。依赖满足时并行推进 s31 和不冲突的 s33–35。Codex 接手期间（10-17 到 10-18）没做的真实 Claude 待验项，由 Claude 恢复后补做，不以 Codex 代替。
2. s38/s39 → s40，并完成从原 s44 拆出的基础隔离 s44a。随后完整交付 s49，提前到无关的 s43/s44b/s45/s48 之前；不必等 s41/s42，但保留它们作为查看、纠正和故障恢复入口。
3. s46/s47 → s56a 的真实 SOUL 修改/撤销 → s54a 的聊天文字设置；判断设置仍依赖 s23d 及其 s23c 前置。s51a 可跟随 s49，其他旧控制台删除仍先核对替代页面。
4. 再完成 s43/s44b、s45/s48，s56b 的真实能力名单修改/撤销 → s54b/s55，以及 s50/s51b/c/s53/s57 和所有验收尾项。每个修改入口连同对应回执/撤销一起交付，不先勾无人调用的 helper。

两条线和在飞上限不变。以上重排不取消 M7/M8/M9 原验收；新增本地聊天、定时任务和成果库仍留在 product.md 第 10 节。统计只数叶子，s36/s36c/s36c2/s44/s54/s56 总项不重复计数。

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

2026-10-16：第 2 步剩下的卡片回调由 Codex 在 owner 的客户端里点过（#322 任务 10），Bot 4、5 的清单都是"全部完成"；同一个任务看了 M1 第 6 步的运行卡，三个群都正常，没有错位、乱码或"请升级"。还剩第 4 步注销再登录。

### M3 群里的上下文（s09 到 s16）

**给 owner 什么：** 群里的对话更像同事（3.5、3.12）：
- bot 叫得出群里人的真名。
- 从主区开的话题里，bot 知道主区刚才在聊什么。连续群里有人开话题，bot 在话题里单独聊，主区那条会话不受影响。
- 话题里补拉完整，不再每轮重复话题第一条。
- `/new` 开新会话，`/resume` 换回去；bot 忙时 `/compact` 自动排队。撤回的消息 bot 不再用。
- 十分钟没有输出才算超时，超时或断网的卡片上有重试按钮。群里其他人也能领 bot 发的文件。
- `/model` 能手填模型 id；运行卡头部一直显示上下文仪表。

**怎么验收：** owner 不用做：第 4 步在卡上选回去改由 Codex 在 owner 的客户端里做（owner 2026-10-16）；第 7 步拿掉了。其余步骤 Claude 和 Codex 先做完，结果写在通知里。

在 M1 的测试群（规则模式，主区开话题）和一个新建的连续群里做：
1. Claude 先做：连续群主区先不 @ 说两句，再 @bot 问"刚才大家在说什么"。在开话题的群里 @bot 开一个话题，问同样的问题。
2. Claude 先做：话题里不 @ 说一句，再 @bot，看它知道你刚说的话、叫得出你的名字。
3. Claude 先做：在连续群里自己开一个话题聊几句，回主区问 bot 话题里的事，它应该不知道。
4. Claude 先做：在连续群里 `/new`，再问之前的事，它不记得。Codex 接着查：用 owner 的飞书客户端在同一个群里发 `/resume`，在卡上选回去（#322 任务 13）；Claude 再问，又记得。任务 13 选错了会话，10-16 在新建的群里重做，结果见下面。
5. Claude 先做：让 bot 跑一个两分钟以上没有输出的任务，不会被掐断。
6. Claude 先做：撤回一条 bot 读过的消息，再问它这条消息的内容。
7. 拿掉了（owner 2026-10-16）。它验的是 s11"群里能用 bot 的人都能领文件"，单测已经覆盖；访客档去掉以后（s15c），领文件的人和发起人用同一档，没有"访客领不到"的情况了。以后有同事在群里用到时顺带看。

2026-10-16：第 1 到 6 步都通过。Claude 在 JP-VPS 上用 lark-cli 以 owner 的身份做，第 4 步点卡由 Codex 在 owner 的客户端里做。连续群是整群一条会话的 Claude 群，开话题的群是主区 @ 开话题的 Codex 群。
1. 10-15，Bot 3。连续群主区先不 @ 发两句，再 @ 问"刚才大家在说什么？谁说的？"，bot 说出了两句话和发信人。开话题的群里 @ bot 开话题问同样的问题，话题里也答对了。
2. 10-15，Bot 3，第 1 步开的话题里。先不 @ 说一句，再 @ 问，bot 复述了刚才那句话，也叫出了真名。
3. 10-15，Bot 3。连续群里在主区一条消息下开话题说了一句，回主区问，bot 答"不知道，话题里的内容在另一条会话里"。
4. 10-16，Bot 6，新建的"Vonvon 验收 M3 连续群"。先让 bot 记暗号，`/new` 后再问，答"不知道"。Codex 在 owner 的客户端里发 `/resume`，点回那条会话（#322 任务 17 到 19）。任务 18 那次点击没送到 daemon，日志里没有 `card` 的 `action` 事件；任务 19 按坐标点，日志有 `resume.pick`。再问，bot 答出了暗号。恢复卡上有两处显示问题，s15d 修。
5. 10-15，Bot 3，Codex。跑 `sleep 150`，没被掐断，但等的时候 Codex 往卡上写过两句进度，算不上"没有输出"。10-16 用 Claude（Bot 6）重做：150 秒里卡上没有任何新内容，卡片用时 2 分 40 秒，答"done，实际用了 150.01 秒"。日志里第一个事件在 47 毫秒，下一段文字在 159 秒。
6. 10-16，Bot 6。主区不 @ 发暗号，@ bot 让它记下，回"收到"。撤回那条暗号，日志记 `recall`，`noted: 1`。再问，答"不知道"。Mac 上订阅了撤回事件的 Bot 4 同样答"不知道"。10-16 凌晨的 Bot 3 没订阅撤回事件，答出了被撤回的暗号，和清单里的提示一致。

### M4 崩溃恢复、诊断和 Linux 命令行版（s17、s17b、s18a、s18b、s18c、s18d、s18e、s18f、s19、s20a、s20b、s20c、s20e）

**给 owner 什么：**
- 崩溃恢复（3.10）：daemon 或某个 bot 崩溃后自动重启，主人在飞书私聊收到一行原因。10 分钟内崩溃 3 次就停下：网页和桌面端照常打开，诊断页顶上一条红条，带"恢复运行"按钮。只是某一个 bot 反复崩溃时，只停这一个。
- 诊断页（3.1 第 8 条）：按 bot 列出连接状态、Codex 和 Claude 的版本和登录、缺的权限，以及最近没回的消息和原因。
- Linux 命令行版（3.10）：用 npm 安装；`vonvon service install` 装 systemd 用户服务，并处理 linger；`vonvon open --print` 打印 ssh 转发的办法；`vonvon bot add` 在终端里扫码建 bot。Claude 已在 JP-VPS 上走完安装、崩溃重启、停止和卸载，记录在本文第 10 节。

**怎么验收：** owner 要做的：没有必做的步骤，第 4 步有 Linux 机器的话可以自己试。其余步骤 Claude 和 Codex 先做完，结果写在通知里。
1. Claude 先做：终端执行 `vonvon daemon status` 看 PID，再 `kill -9 <PID>`。几秒后 bot 回来，大约 30 秒后私聊里收到"刚才崩溃过一次，已自动恢复"，列出受影响的 bot。Codex 先查：在 Mac 的隔离数据目录里做前半，launchd 把 daemon 拉起来；隔离目录里没有 bot，私聊那一半只在 JP-VPS 上看。
2. Claude 先做：10 分钟内再 `kill -9` 两次：诊断页顶上出现红条，群里 @bot 不回，私聊里马上收到"10 分钟内崩溃了 3 次，已停止自动重启"（第二次崩溃那条在 10 分钟限额内，不发）。点"恢复运行"后恢复。Codex 先查：Mac 上同样三次以后，网页端和桌面端照常打开，诊断页有红条，点"恢复运行"后恢复。
3. Claude 先做：在诊断页看各 bot 的连接状态和版本；在一个没绑定的群里 @bot，诊断页里能看到没回的原因。
4. Claude 先做：Linux 部分 s20b 已在 JP-VPS 上走完，不用 owner 做；有 Linux 机器的话，owner 可以照本文第 10 节的记录试一次。
5. Claude 先做（s18c 合入、验收 daemon 升级以后）：重启时丢掉的排队消息。用 lark-cli 以 owner 的身份，在验收 daemon 一个绑定好的测试群里做：
   - 群的"运行中来了消息"默认是插话，插话不进队列。先 `vonvon settings set --bot <app id> --group <群 id> run.pendingPolicy=queue`，做完改回 `default`。
   - 在一个话题里 @bot 一件要跑一会儿的事（比如写一篇 1500 字的短文）；卡片在输出时，在同一话题再发一条，日志有 `intake queued`。马上 `vonvon daemon restart`，命令发出后立刻在另一个话题 @bot 一句"重启时发的"。日志有 `bridge dropped-recorded`。
   - bot 起来后（一般 30 秒内）：第二条下面有 bot 回的"刚才重启了，这条没处理，请再发一次。"，第一条的卡片是中断；这个 bot 数据目录里的 `dropped.json` 没了；诊断页这个 bot 的"最近没回的消息"多一条"重启或停止时这条还在排队，没处理"，下一步"已在原处回了一句请重发。"。
   - "重启时发的"那一句：几分钟内新进程收到它（e10 见过约 6 分钟），bot 照常回答。没收到时记下来，product.md 3.10"重启过程中新发来的消息不会丢"那一句要改。
   - 可选：在一轮输出时发 `/compact`（"等这一轮结束就压缩"），再 `daemon restart`，`/compact` 下面同样回一句。
   - 可选，owner 同意后做：撤回的消息回复接口回什么码没实测，代码按文档写的 `230011`。一轮在跑时在同一话题排一条，`daemon stop`，撤回排着的那条，再 `daemon start`：日志 `dropped-reply-failed` 的 `detail` 里是实际的错误码；是 `230011` 时诊断页不多这一条，不是时改 `replyFailure`。

2026-10-17：JP-VPS Codex 在 main `191980f` 升级隔离验收 daemon 后，第 5 步通过：真实 Codex 长任务中排队、重启，新进程在原话题回请重发，旧卡片显示中断，`dropped.json` 清除；构建后的网页诊断页显示原因和已回复的下一步。重启窗口另一个话题的新消息也补送并回答；这是一次成功样本，不保证补送时限。群排队设置已恢复 `default`。可选的 `/compact` 与撤回步骤未做，未调用真实 Claude 推理。记录：https://github.com/modelzen/vonvon-bot/pull/365#issuecomment-6229126717 。

Mac [任务 21](https://github.com/modelzen/vonvon-bot/issues/322#issuecomment-6229245321) 先通过隔离 launchd、网页崩溃暂停/恢复、签名和安装，Computer Use 超时留下桌面检查；[任务 22](https://github.com/modelzen/vonvon-bot/issues/322#issuecomment-6230058746) 在 Computer Use 正常时复现桌面断线、旧快照和 Desktop request failed。s18f（#372）已合入，[任务 23](https://github.com/modelzen/vonvon-bot/pull/372#issuecomment-6230322157) 在准确 head `7f7a746` 的临时 app 通过三次崩溃后的自动重连、第三次暂停红条和桌面按钮恢复，隔离 app 与服务清理完毕。[任务 24](https://github.com/modelzen/vonvon-bot/issues/322#issuecomment-6230533303) 从 main `0befaf8` 重建的隔离服务/网页三次崩溃与恢复通过，Developer ID 签名和安装通过。安装后 Computer Use 返回默认实例，无法可靠绑定隔离 PID/窗口；按规则停止，未做桌面三次崩溃或默认正常启动、窗口、托盘、菜单的完整验收。隔离 app、服务和哈希任务已清理，默认 daemon/bot 保持原 PID，未做崩溃或暂停操作；新 app 已装好、GUI 未留开。M4 桌面验收仍未完成，不能用任务 23 的临时 app 结果替代安装后的验收。

2026-10-17 Mac 任务 21：main `191980f` 的隔离 launchd 第一次崩溃自动恢复、三次崩溃后暂停、网页诊断与网页恢复均通过；M4 app 已在 Mac 本机构建、Developer ID Application 签名、严格验签并安装。Computer Use 在退出旧窗口、定位新装 app 的隔离窗口时超时，按规则停止、未重试；没有向默认 daemon 做崩溃操作。桌面三次崩溃流程和默认窗口、托盘、菜单、正常启动仍未验完，M4 桌面部分不记通过。隔离 app 与哈希服务已清理，默认 daemon 只读状态为运行。结果：https://github.com/modelzen/vonvon-bot/issues/322#issuecomment-6229245321 。

2026-10-16：第 1 到 3 步 Claude 先做的部分都通过；第 4 步不用做。Mac 上 Codex 先查的那一半放进 M4 预览版任务，等 s18c 合入后一起做（s18d、s18e 不等）。
- 环境：Claude 在 JP-VPS 上用验收 daemon（main 955a5c3，分离运行，三个测试 bot）做。这里没有服务管理器，每次 `kill -9` 后手动 `daemon start`，代替服务管理器拉起。私聊用 lark-cli 以 owner 的身份读，网页用无头浏览器看。
1. 17:58（UTC）`kill -9` 主进程再起来，bot 几秒内连上，30 秒后 Bot 6 私聊 owner："daemon 刚才崩溃过一次，已自动恢复。受影响的 bot：Vonvon Bot 6、Vonvon Bot 7、Vonvon Bot 8。原因：被系统强制结束（kill -9、内存不够，或者关机、注销时没来得及退出），运行了至少 2 分 0 秒。"发信的是最早加入的 Bot 6。
2. 10 分钟内又 `kill -9` 两次：
   - 第二次：30 秒后日志记 `crash-notify limited`，没有私聊（每个 bot 每 10 分钟最多一条，发信的还是 Bot 6）。
   - 第三次：起来就进入暂停，3 秒内私聊"daemon 10 分钟内崩溃了 3 次，已停止自动重启，bot 都没有启动：Vonvon Bot 6、Vonvon Bot 7、Vonvon Bot 8。最近一次的原因：……。查完原因后在状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。"
   - `daemon status` 有暂停行和三条记录，`bot list` 三个 bot 都是"daemon 已暂停 · 未连接"。
   - 暂停中在 M1 Codex 群 @ Bot 6，60 秒内没回。
   - 状态与诊断页顶上是红条"daemon 已暂停：10 分钟内崩溃了 3 次，bot 都没有启动。查完下面的崩溃记录后点「恢复运行」。"，带"恢复运行"按钮和三条崩溃记录。
   - 点"恢复运行"后 28 秒，换了新 PID，端口不变，三个 bot 都已连接。带恢复请求起来的，没有再发私聊。
   - 暂停中那条 @：恢复后约 2 分钟飞书重推了它（18:00 发，18:06 到，e10 记过的重推），bot 照常开话题答了。这条消息写着"应该不回"，Codex 没回文字，卡上是"（未返回内容）"。所以"群里 @bot 不回"只在暂停期间成立；恢复以后，重推来的消息照样会回。
3. 诊断页每个 bot 一节：连接、飞书设置、缺的权限、执行工具（Codex 0.163.0、Claude 已登录）、最近没回的消息、最近的崩溃。在没绑定的群里 @ Bot 7，它回"本群还没绑定为项目……"；诊断页 Bot 7 那一节多了"1 条没回"，写的是"这个群还没绑定，只回了一句提示"，带群和消息的尾号，以及"在 Bot 页点「加入飞书群」绑定这个群。"

顺带看到的：
- Linux 上主进程被 `kill -9` 时，bot 子进程没有跟着死（和 macOS 不同，见"s18a 做法（macOS 的进程组）"），各自走关闭，三个各记了一条带调用栈的 `daemon-shutdown fail`（`owned-work-report`："Owned-work IPC channel is closed."）。这和 s18c 的"收到 IPC 断开后排空"有关，s18c 开工时一并看这条报错要不要降级或吞掉。
- Bot 7、Bot 8 的首次运行清单停在"卡片回调：请手动确认"：飞书没有接口能查这一项，要在网页里勾"我已配置"。两个测试 bot 的回调已由 Mac 上的 Codex 配好（任务 16），只是没勾，不影响验收。
- s15d 在真实飞书上：
  - 网页"群内协作"里，"Vonvon 验收 M3 连续群"（Claude）的可恢复会话标题是"本会话中的暗号"，不带发信人和记录块。
  - 点"恢复"后，群里的恢复卡"🕘 已恢复历史会话"：bot 那一行写"🤖 Claude"，用户那一行只有人说的话，"上次停在"是 Claude 的原话。
  - 但新记下的会话摘要还是"(恢复会话)"，网页"当前会话"也显示它：Claude 的 `readHistory` 不给 `name`、`preview`，s15d 之前就这样。放进 s15e。

### M5 智能模式（先做 s14d、s15c、s15b，再做 s21 到 s23、s25 到 s28）

**给 owner 什么：**（3.4）
- 绑定群时能选"智能"：bot 自己判断接不接话、回在主区还是开新话题；选了以后在群里说一句"我会读群消息，合适时接话"。绑定卡、群详情页和命令行里，会话方式按 product.md 3.4 的顺序和文案列三项。
- 多 bot 群里只接对自己说的话：@ 了谁、引用了谁，就谁回；bot 不进别的 bot 的话题；主区命令要 @。
- 同一台 Mac 上几个智能 bot 合成一次判断，只放行一个回复。
- 智能 bot 之间能互相 @，没有真人插话时最多来回 3 轮。
- 群详情页能改会话方式、免 @ 和"运行中来了消息"。
- 用量页显示判断次数，诊断页显示"不回"的原因。
- 已有的群仍是规则模式，行为不变。
- M4 之后先做的三片（owner 2026-10-16 的决定）：话题里勾"同时发送到群"时 bot 只回一次；一个群只有一个权限档、一条会话；在终端或 Codex 应用里接着 bot 的会话聊过、压缩过，bot 下一轮接得上，Codex 的会话终端随时打得开。

**怎么验收：** owner 不用再扫码：JP-VPS 用的两个测试 bot（Vonvon Bot 7、Bot 8）2026-10-16 已建好（本文第 8 节）。第 1 到 7 步、第 9 步和第 10 步 Claude 先做完，第 8 步 Codex 在 M5 的预览版任务里先查，结果写在通知里。

装 M5 预览版之前，Codex 先确认 owner 默认的 daemon 不是 s20c 之前的版本，是的话先按服务的正常方式重启到当前装好的 app（本文第 7 节"Mac 上怎么打包"第 3 条，s20e）。

照 product.md 3.4 的例子：同一台 Mac 上至少两个 bot，一个规则模式、一个或两个智能模式，都在一个新建的测试群里。Claude 在 JP-VPS 上做时，三个测试 bot 都跑在 JP-VPS 上，一个规则模式、两个智能模式。
1. Claude 先做：@ 规则模式的 bot 问一句，只有它回。
2. Claude 先做：不 @ 说一个产品问题，比如"下周发布要不要先砍掉导出功能？"，智能 bot 里只有一个开话题回。
3. Claude 先做：说一句闲聊，没人回；诊断页能看到"不回"的原因。
4. Claude 先做：发一条 @所有人，没人回。
5. Claude 先做：在智能 bot 开的话题里，让它 @ 另一个智能 bot 帮忙看，对方会回复；来回 3 轮后停下。
6. Claude 先做：引用某个 bot 的回答说一句，只有它回。
7. Claude 先做：在群详情页把这个群从智能切成多会话，再切回来；在用量页看判断次数。
8. Codex 先查：在 owner 的客户端里，进一个话题，回复时勾"同时发送到群"并 @ bot，bot 只在话题里回一次（s14d）。
9. Claude 先做：用 `claude --resume` 在终端里接着 bot 的群会话聊一轮、再 `/compact`，回群里问终端里说的事，bot 知道，主区还附了话题表；用 `codex resume` 打开一个 Codex 群的会话，不被拒（s15b）。
10. Claude 先做：群内设置只剩一个「权限档」下拉；`vonvon settings set --group <群> permission.guestMode=qa` 被拒并说明（s15c）。

### M6 提问卡片、权限档和子 agent（s29 到 s35）

**给 owner 什么：**
- 提问卡片（3.8）：agent 向人提问或请人确认方案时，群里单独发一张写清后果的卡片，@ 能回答的人，只有发起人或管理员能点。等回答期间，这一轮不会被超时杀掉；15 分钟没人答，卡片收成一行结果。直接打字回复也算回答。重启后点旧卡，卡片会说明已失效。
- Claude 的权限档（3.8）：只读、读写档下不再写到工作区以外（M7 起记忆目录除外），关网时连不上网，开网时能用 WebFetch。
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
- Bot 页：能改个性（SOUL.md）、规矩（AGENTS.md）、智能提示词、判断模型、公共记忆、工作区和代码仓库。
- 群详情页：能给每个群补充或替换个性、换工作区、加仓库，覆盖智能提示词和判断模型，查看和修改本群记忆。
- 把 bot 拉进已有的群，私聊收到设置卡：选会话方式，工作区默认自动建，默认只读、关网（3.4、3.8）；设置好之前群里 @ 它只回一句"还没设置好"。
- 新群不用再选文件夹，自动建在 `~/.vonvon-bot/projects/<bot 名>/groups/<群名>/`。群没设工作区时只用自己的目录，bot 的代码仓库照常带上。
- 说"记住……"以后，卡片上显示"已记到本群记忆"，可以撤销；别的群看不到，同群的主区和别的话题下一轮就知道。
- 改了个性、规矩、智能提示词或记忆，已经在聊的群和私聊下一轮就用上，不用 `/new`（3.6）。
- bot 能同时在多个工作区和代码仓库里干活，用某个仓库前先读它的 AGENTS.md 或 CLAUDE.md。
- bot 的会话不再读写你自己 Claude 和 Codex 的自动记忆。

**怎么验收：** owner 要做的：第 5 步里在卡片上点撤销。其余步骤 Claude 和 Codex 先做完，结果写在通知里。第 3 步要读写档：Linux 上的 Codex 只能用完全访问，所以用 Claude 做，Claude 的读写档要沙箱。JP-VPS 上的沙箱 2026-10-15 能用了（本文第 7 节），这一步也在 JP-VPS 上做，不再退回 owner；还没用真 bot 的回合从头到尾验过。
1. Claude 先做：找一个已经聊过几轮的群，在 Bot 页给 bot 写几句个性，比如"说话简短，不客套"；不 `/new`，接着在这个群的主区和一个已有的话题里各 @ 它一次，语气都变了。
2. Claude 先做：在某个群的详情页给这个群补一句个性，不 `/new`，下一轮就生效，只在这个群生效。
3. Claude 先做：把 bot 拉进一个新建的群：主人私聊收到设置卡，会话方式按 3.4 的顺序列三项、不预选；设置前在群里 @ 它只回一句"还没设置好"；选了多会话、工作区留空，绑定后 @ 它能回。在群详情页把权限档改成读写，让它写一个文件；到 `~/.vonvon-bot/projects/<bot 名>/groups/<群名>/` 下能找到（JP-VPS 上换成它自己的 `VONVON_HOME`）。
4. Claude 先做：给 bot 加一个本机代码仓库，让它在仓库里改一处，再在工作区里写一个文件。Codex 先查：在 Mac 上加仓库时，目录选择器能选到本机的文件夹。
5. Claude 先做：在一个群的话题里说"记住：发版在周四"，卡片上出现"已记到本群记忆"；在同一个群的主区问什么时候发版，它知道；去另一个群问，它不知道。owner：自己说一次，点卡片上的撤销，再说一次。
6. Claude 先做：在 Bot 页查看并修改公共记忆，两个群都能用上。

### 提前体验检查：认识你的 bot

这是已完成切片的跨里程碑检查，不新增 M 编号，也不把其余里程碑勾掉。环境仍按第 7 节隔离；Claude 在 JP-VPS 上做能自动化的真实飞书步骤，Mac Codex 做原生专属检查，owner 只做客户端判断和点卡。两家后端分别记录。

**A，完整 s49 合入后：** 必须先完成 s36/s37/s38/s39/s40/s44a、e10 及它们的真实实验/权限前置。
1. 完成 provider、飞书和 daemon 就绪检查，主人直接私聊一项小任务；普通文本不被旧管理菜单吞掉。s51a 没完成前，不宣称全部旧菜单已退场。
2. 产出可核对的小文件，核对实际文件和飞书交付结果；分开记录生成、投递和内容检查，保持现有文件交付方式，不增加自动发送或成果库。
3. 任务中补充一句，并停止另一轮，分别核对两家已支持的插话/排队与停止；未知 ACK 不自动重放，旧重试不覆盖新输入。Claude 不支持 steer 时按排队验收。
4. 说“记住我的偏好”，核对个人记忆的真实变更、范围、版本和回执；开 DM 话题、`/new`、恢复旧会话后仍使用正确范围。另一管理员和群不能得到这份个人记忆。清空会话不删除记忆。
5. 通过已授权的实际编辑入口修改个性、记忆，不 `/new`，下一轮生效；s41 未完成时不宣称 Bot 编辑页已交付。s33–35 未完成时，也不宣称提问/子 agent 故事已验收。

**B，s56a+s54a 合入后：**
6. 私聊说“以后在测试群说话简短些”，读回真实提交与回执：目标群、前后值、版本、生效时机；不 `/new` 到目标群核对，其他群不受影响。
7. owner 在真实飞书客户端点一次撤销；自动化核对旧回执遇到新修改不覆盖、权限撤回拒绝、并发记忆等待其他回合结束。
8. 关闭聊天设置后仍能普通 DM 干活，修改立即拒绝；群、错误/缺失令牌、非授权触发人和旧 skill 均不能绕过当前 daemon 检查。
9. 在隔离夹具注入落盘失败、重复请求和回执发送失败，确认分别呈现实际状态，重发回执不重复变更，不捏造“已记住”；真实平台只做可控步骤，不损坏 owner 数据。

M9 第 1、3、7 步可引用这两次检查的准确版本证据，相关行为改变后复验；陌生人、能力扩大、建群和飞书管理员等原步骤仍单独完成。M7/M8 的页面、沙箱和真实 Mac 验收不因此跳过。

### M8 skill、MCP 和查飞书上下文（s43、s44a/b、s45–48）

**给 owner 什么：** 桌面端有本机 skill 库和 MCP 库（3.6）。skill 可以从 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 或任意文件夹导入；MCP 可以从 Codex、Claude 的配置导入，也可以手填命令或网址。导入后给 bot 启用，在某个群里另外增减；名单改了，等下一条会话或 bot 的后台进程重开后生效。新建的 bot 不再带你的 Claude 个人指令和两家的个人 skill，导入的 bot 不变。Codex 的 `~/.codex/AGENTS.md` 关不掉，新建的 bot 也带着，bot 的指令里写明 bot 自己的规矩优先。bot 能用 vonvon 飞书 skill 查本群的话题和另一条会话（3.5）：在主区问"两个话题的结论"，它去读了再答，卡片上写读了哪些。

**怎么验收：** owner 要做的：第 3 步里扫码新建一个 bot、照清单做到全绿，做完回一句。其余步骤 Claude 和 Codex 做，结果写在通知里。
1. Claude 先做：在 skill 页从 `~/.claude/skills` 导入一个 skill，给 bot 启用，在群里让 bot 用它；在另一个群的详情页把它移除，那个群里就用不上。
2. Claude 先做：从 Codex 配置导入一个 MCP，给 bot 启用，让 bot 调一次。
3. owner：在 Mac 上扫码新建一个 bot，照清单做到全绿。Claude 接着做：照 M1 第 4 步用 lark-cli 把它加进测试群，@ 它问有哪些 skill；Codex 接着查：列出 Mac 上 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 里的 skill 名。bot 的回答里没有这些名字。
4. Claude 先做：照 product.md 3.5 的时间线：在主区开两个话题，各聊几句；回主区 @bot 问"两个话题的结论"。卡片上写着读了 T1、T2 的会话，回答里有两边的内容。

### M9 私聊（s49、s50、s51a–c、s53、s54a/b、s55、s56a/b、s57）

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
| [x] | s02c | 拿掉咖啡一下（二）：daemon 代码 | 删设置协议里的咖啡一下、`D/cli-bridge/` 和它的测试；`vonvon hook` 留一个直接退出的空命令（3.12） | 5600，拆成 5 片（下面的 s02c 拆法） | s02b | 子进程 | 无 |

开工要点：
- s01：兼容标识不动：旧目录、`FEISHU_CODEX_BRIDGE`、`CLAUDE_CODE_ENTRYPOINT`、hook 正则、旧服务标签。不申请 `im:message.group_msg.include_bot:read`。补拉因为缺权限失败时，记一条带权限名的结构化日志；今天没有现成的诊断去处，诊断页上显示缺的权限在 s19 做。s19 已改，见 M4 的"s19 做法（缺的权限）"。
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
  - s02c3（约 1190 行，#330 已合入）：删 `cli-bridge-service.test.ts` 和 `cli-bridge-global-service.test.ts`。`service.ts` 连它的测试约 1700 行，一片放不下，所以测试先删；s02c2 以后 `service.ts` 已经没有调用方。测试只测 `service.ts`，别的测试没有引用它们；`service.ts` 本身和它对 `ipc.ts`、`store.ts` 等的引用留到 s02c4，所以这一片合入后 `D/cli-bridge/` 照样能过 typecheck。
  - s02c4（约 1360 行，#332 已合入）：删 `service.ts`、`cards.ts`（Windows 离开检测的提示在这里）、`store.ts`，和 `cli-bridge-cards`、`cli-bridge-store` 两份测试；`D/card/dm-cards.ts:905` 注释里提到 `cli-bridge/cards` 的那句跟着改。
  - s02c5（约 1150 行）：删剩下的 `ipc.ts`、`parser.ts`、`keep-awake.ts`、`presence.ts`（PowerShell 离开检测）、`route.ts`、`types.ts` 和它们的五份测试，以及 `cli-bridge-config.test.ts`；删 `D/config/schema.ts` 里 `cliBridge` 的类型和读取函数（约 150 行）、`D/config/paths.ts` 的 `cliBridgeSocket` 和它的命名管道分支。`preferences.cliBridge` 到这一片才从类型里去掉，旧文件里的这个键照旧留着、没人读；`coffee-retired.test.ts` 里写 `cliBridge` 的那条配置改成不靠类型。`D/cli-bridge/` 到这里删空。见下面的 s02c5 做法。
- s02c1 做法（协议）：Agent 设置的 `cliBridge` 一节和 `cliRuntime`、本机设置的 `runtime.coffee`，`setCliBridgeEnabled`、`repairCliHooks`、`setHostCliRoute`、`repairHostCliHooks` 四个写操作，从协议、`D/admin/settings.ts`、`host-settings.ts`、`settings-parse.ts`、`settings-service.ts` 里删了。只给它们用的 hook 状态、生效时机 `next-hook` 和 `next-presence-check`、写操作结果 `diverged` 一起删；本机设置没有写操作了，写操作的结果里也就不再带本机视图。RPC 收到这四个写操作或存 `cliBridge` 这一节，按无效请求拒。`vonvon settings` 不再过滤 `cliBridge`，`--json` 里也没有了；`settings set cliBridge.…` 还是回"咖啡一下第一版已拿掉，不能改。"。
- s02c1 做法（旧数据）：`config.json` 里的 `preferences.cliBridge` 和 `cli-bridge-route.json` 不迁移、不删。读设置时不看它们，存别的设置时原样留在文件里；`vonvon hook` 照旧读它们，s02c2 以后就没人读了。测试用一份带全套旧字段的 `config.json` 读一次、存一次别的设置，再比对文件。
- s02c1 做法（协议版本）：`PROTOCOL_VERSION` 不升，和 s12 删 `compact` 一节一样。网页由 daemon 自己发，和 daemon 总是同一版。新的桌面端连旧 daemon 时，多出来的 `cliBridge`、`cliRuntime` 被丢掉，照常显示；旧的桌面端连新 daemon 时，读 Bot 设置会因为少了 `cliRuntime` 解析失败，只有把 app 换回旧版、或者 daemon 单独升级了才会碰到。升版本号反而会让刚装的新 app 拒绝连还在跑的旧 daemon，s08b 之前它不会自动重启旧 daemon。
- s02c1 做法（顺带）：`packages/ui/src/reference/styles` 里的 `coffee-*` 样式（grep 过，没有组件用）和没人调用的 `D/cli/commands/doctor.ts` 删了。同一处还有一条没人用的 `handoff`（接力设置）选择器，没动。
- s02c2 做法（空命令）：`vonvon hook` 在 `packages/daemon/bin/vonvon.mjs` 里、加载命令行主包之前就答完：主包连依赖要加载大半秒（JP-VPS 上 `--version` 0.7 秒），空命令 0.07 秒。什么参数都收，不认识的 agent、多出来的选项、没有 `--agent`、`--help` 都一样；不建数据目录、不拿锁、不写日志。标准输入读到结束再退，免得 Claude Code、Codex CLI 写事件时碰上关掉的管道；标准输入是终端就不读，一直不关最多等 2 秒。什么都不输出，退出码总是 0。主包里的 `hook` 命令删了：装进去的 hook 写的是 daemon 自己的入口（`process.argv[1]`），桌面端、后台服务和 npm 都从 `bin/vonvon.mjs` 起，不会直接跑 `dist/cli.js hook`。
- s02c2 做法（删的）：`D/cli-bridge/index.ts`、`protocol.ts`、`hooks.ts` 和四份测试；`route.ts` 里只给 hook 挑 bot 的 `selectCliBridgeHookBot` 一起删了，读写 `cli-bridge-route.json` 的留到 s02c5。`parser.ts` 的 `parseHookPayload`、`ipc.ts` 的 `sendCliHookMessage` 已经没有产品代码调用，只剩测试在用，随 s02c3、s02c5 删。`coffee-retired.test.ts` 去掉 mock 以后，最后一条只看带着旧的"已开"设置 bot 能起能停：`D/bot/` 早已不引用 `D/cli-bridge/`。
- s02c2 做法（测试）：`hook-command.test.ts` 起真的 `bin/vonvon.mjs`，喂 Claude 和 Codex 的 PermissionRequest、Stop，旧的 PostToolUse，空输入、截断的 JSON、二进制，各种多余选项，8 MB 的事件（写的一方不能报错），和一直不关的标准输入（2 秒后退）；每条都看标准输出、标准错误是空的，退出码 0，临时 `HOME` 里什么都没写。另有一条把入口拷到没有 `dist/` 的目录，`hook` 照样成功、别的命令加载不了主包，证明 `hook` 不碰主包。标准输入是终端的情况在 JP-VPS 上用 `script` 手工跑过，立刻退出。
- s02c2 留下的：打包版的 daemon 跑在 Electron 里，那时装的 hook 写的是 Electron 本身加 `bin/vonvon.mjs`，不带 `ELECTRON_RUN_AS_NODE`，Claude Code、Codex 跑它时起的是桌面端而不是这个空命令。没在 Mac 上看过会怎样；M1 预览版装过、又在咖啡一下里修过 hook 的 Mac 才有这种 hook，卸掉归 s62。2026-10-15 在 owner 的 Mac 上只读查过：`~/.claude/settings.json` 和 `~/.codex/hooks.json` 里都没有 vonvon 的 hook，这台 Mac 不受影响。
- s02c5 做法（删的）：`D/cli-bridge/` 剩下的 `ipc.ts`、`parser.ts`、`keep-awake.ts`、`presence.ts`、`route.ts`、`types.ts`，和 `cli-bridge-ipc`、`cli-bridge-keepawake`、`cli-bridge-parser`、`cli-bridge-presence`、`cli-bridge-route`、`cli-bridge-config` 六份测试删了，目录删空。`D/config/schema.ts` 删了 `cliBridge` 的类型和 `getCliBridgePreferences`、`resolveCliBridgeTarget`、`canEnableCliBridge` 三个函数，它们早就只有 `cli-bridge-config` 在测；`D/config/paths.ts` 删了 `cliBridgeSocket` 和它的命名管道分支。`D/config/data-compatibility.ts` 的 `bridgePipeName` 是给 cli-bridge 算旧 bridge 的 Windows 命名管道名的，只有测试在用，也删了，它那条测试只留认旧 getter 路径的部分；这个文件别的 Windows 分支照旧归 s58（本文第 6 节）。
- s02c5 做法（旧数据）：`AppPreferences` 里没有 `cliBridge` 了，旧 `config.json` 里的这个键照旧留着，没人读。配置是整份 JSON 原样读进来、存设置时整份写回的，不按类型挑字段，所以类型删了，文件里的键也不会丢。`settings-owner.test.ts` 用一份照 daemon 的格式写的 `config.json`，带上类型删掉之前的每一项旧字段和别的未知键，读一次、存一次别的设置，再比对整个文件：只多了存的那一项，旧的那一节连键的顺序都没变。`coffee-retired.test.ts` 的配置改成一段 JSON，不靠类型；点过旧卡、bot 带着它起停以后，配置和原来一个字节都不差，也没写盘。`cli-bridge-route.json` 照旧留着，`host-settings.test.ts` 那条没改。
- s02c5 做法（留着的）：Claude 和 Codex 子进程带的 `FEISHU_CODEX_BRIDGE` 标记照旧带，bridge 装的 hook 靠它认出 bot 自己的会话（s02b）；`D/agent/claude-agent/` 里说谁读这个标记的注释改成 bridge 的 hook，不再指 `parser.ts`。旧卡按钮的 `COFFEE_RETIRED_ACTIONS`、`settings set cliBridge.…` 的拒绝，和 `import-core.json`（一次性的导入记录）里 `src/cli-bridge/` 的几条也都留着。
- s02c5 留下的：旧安装的数据目录里可能还有 `cli-bridge-route.json`，bot 目录里可能还有 `cli-bridge.sock`（s02b 以前咖啡一下的服务没正常退出时留下的），没人读，也不删。s02c2 留下的 Electron 里的 hook 照旧归 s62。到这里 s02c 做完了。

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
- s03：Codex 的最低版本定成 0.139.0。vonvon 用到的 app-server 方法 0.131.0 就都有，但 vonvon 依赖的行为（`turn/interrupt` 以 `turn/completed(interrupted)` 收尾、目标自动开始和目标状态）实际跑过的最老版本是 0.139。验证过的版本跟托管安装锁定的版本走，现在是 0.156.1。e05 做完后在 s39 抬高。s23b 已改：最低版本抬到 0.156.1。
- s03 留下的，给 s39：e05 实测 0.139.0 用 ChatGPT 登录，试过的模型都被服务端拒了（它列出的 5 个里试了 gpt-5.5 和 gpt-5.4-mini）；0.148.0 跑不了 gpt-6-luna；0.156.1 各项都过。最低版本抬到 0.156.1，和验证过的版本相同，版本检查不用改结构。只改常量和测试，不必等 s39，下一个碰 `version.ts` 的片可以顺手改。服务端按客户端版本放行模型，这条线还会上移，所以回合里报"requires a newer version of Codex"时，s19 的诊断页也按版本太旧提示。s19 已改（错误类别 `version`），最低版本没动。s23b 已改：`CODEX_MIN_VERSION` 是 0.156.1，测试和环境页的断言一起改了。
- s03：Claude 登录只用 SDK 自带的运行时查：起一个不跑回合的 query，读 initialize 返回的 account；查不了（没下载 SDK、超时、报错）就看环境变量，有 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_AUTH_TOKEN` 算已登录、没验证过，没有就是无法确认，不报未登录。没用 `claude auth status`：它是另一个 CLI，版本和 SDK 自带的不一定一样，查到了也说明不了 bot 的回合能不能跑。account 是 CLI 从本地凭据读的，不问服务器，所以过期的登录也显示已登录，直到真跑一轮失败。
- s03：#301 的 Mac 检查发现 owner 的 Mac 上没有 Codex.app，ChatGPT.app 里自带一份 codex（`Contents/Resources/codex-cli/bin/codex`，版本是预发布号，例如 0.162.0-alpha.17.2）。已加进候选，排在 nvm 之后，用户自己装的优先。
- s03 留下的：Claude 的两个辅助查询（取模型列表、生成标题）用 `settingSources: []`，不读用户设置。凭据写在 `~/.claude/settings.json` 的 `env` 里时（owner 的 Mac 就是这样），这两个查询会报未登录，回合本身（读 user 和 project）和登录检测（读 user）不受影响。下一个碰 Claude 后端的切片改，改之前先在 Mac 上看现象；只读 user 会把用户的 CLAUDE.md 带进生成标题的提示，要一起考虑。s16 已改，见 M3 的开工要点。
- s03 留下的：首页只显示上一次查到、还没过期的 Claude 登录结果，daemon 不在后台自己查（快照每 60 秒刷一次，没开窗口时也刷，每次都起 CLI 太重）；没查过或过期了显示未确认，查完马上刷新首页。已登录的结果留 30 分钟，终端里退出登录后，首页最长 30 分钟还显示已登录，点"检查登录"才马上更新。s19 做状态页时，回合因为没登录而失败，就清掉这个缓存。s19 已改，没有清掉，换成"未登录"并写明原因，见 M4 的"s19 做法（Codex 和 Claude）"。daemon 由 LaunchAgent 起来时（s07）可能读不到钥匙串，探测会报未登录；e06 测钥匙串时一并跑一次登录检测，读不到就在 s07 改成无法确认。
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
- s07：POSIX 上的互斥锁是 `127.0.0.1` 上按数据目录哈希出来的端口（20000 到 49999），和 Linux 的临时端口重叠（s20c 起换掉了，见 s20c 做法）。#295 的 CI 撞过一次（`host-service-shutdown` 测试报 busy），开工时看要不要改成 Unix 域套接字。#296 的 CI 也失败过一次，可能是同一个原因：`daemon-cli.test.ts` 的"concurrent detached starts return the same ready owner"两个启动都退出 1，日志里没有子进程的输出，重跑通过。开工时让这个测试失败时打印子进程输出。
- s07：e06 实测（`docs/research/2026-10-15-v1-spikes/e06-launchagent-keychain.md`）：LaunchAgent 起的进程拿到真实 HOME 和 USER、PATH 只有系统目录，Claude 和 Codex 的登录检测和终端一样是已登录。owner 的登录不走钥匙串，钥匙串那条路没验证到，所以 s03 留下的"读不到钥匙串时改成无法确认"照做，并在用钥匙串登录的账号上验证。用户在系统设置"App 后台活动"里关掉这一项时，服务从 launchd 里消失（`launchctl print` 退出码 113，表现和卸载一样），`service status` 把"plist 在、服务找不到"显示成"已在系统设置里关掉"。不用 `sfltool`（不加 sudo 时卡住）。产品 plist 的 `SuccessfulExit=false` 和 5 秒节流没测，放进 s07 的 Mac 检查。
- s07：`D/admin/host.ts:194` 的 `resolveCliBinPath` 还指向 `bin/feishu-codex-bridge.mjs`，包里只有 `bin/vonvon.mjs`（`D/service/common.ts` 的同名函数是对的）。查清 `host.ts:210` 那条路径还用不用，用就改成调 service/common 的。
- s07 的做法：服务名跟着数据目录走。默认的 `~/.vonvon-bot` 仍是 `com.vonvon.bot.daemon` 和 `vonvon-bot.service`；别的 `VONVON_HOME` 在名字后面加数据目录路径哈希的前 12 位（如 `com.vonvon.bot.daemon.<12 位>`），plist 和 unit 的文件名也一样。测试和 Mac 检查用临时 `VONVON_HOME` 就有自己的 label，碰不到 owner 的服务，不用另设变量。
- s07 的做法：`service install` 先停掉 `daemon start` 起的分离 daemon（等它排空退出），再写定义、让服务起来，端口沿用分离 daemon 的，网页地址不变。定义已装好、服务空闲时只 `kickstart`（systemd 是 `start`）。停了分离 daemon 以后装失败，结果是 `install_incomplete`，并写明"运行 vonvon daemon start"，不自动把分离 daemon 起回来。
- s07 的做法：自己名下的 `unrecognized` 定义（旧版本写的、格式对不上的普通文件）当作旧格式：install 重写、uninstall 删除，回滚时写回原字节。符号链接、目录和别的数据目录的定义仍然拒绝。服务正在跑时换定义仍要先 `vonvon daemon stop`。
- s07 的做法：`service status` 分七种：未安装、在运行、已停止、已关掉、分离运行、要处理、查不到。"定义在、launchd 里没有这个任务"显示为已关掉，提示去系统设置的"登录项与扩展"打开（e06）。`--json` 输出完整状态。网页的机器状态、`daemonStatus` 的 installed 和快照里的 `loginItem` 都读真实状态；`loginItem` 随工具检查每 60 秒读一次。
- s07 的做法：服务定义里的 PATH 是执行 install 时的 PATH 补上 s02 的工具目录。daemon 由 launchd 起来时（`VONVON_SERVICE=launchd`），Claude 登录检测报未登录就改成无法确认，提示可能读不到钥匙串。
- s07 的做法：互斥锁没改成 Unix 域套接字（s20c 带着过渡改了）。换算法会让升级那一刻新旧版本的互斥失效：旧 daemon 占着旧端口，新进程拿到新的锁，以为没人持锁，接管 `daemon.pid`。`daemon-cli.test.ts` 的并发启动测试失败时会打印两个 CLI 的输出和 `daemon.log`；准入锁只等 1.5 秒，CI 负载高时也可能是原因，下次失败看输出再定。`D/admin/host.ts` 里指向 `bin/feishu-codex-bridge.mjs` 的 `resolveCliBinPath` 已删，改用 `D/service/common.ts` 的；用到它的 `buildDaemonControlCommand` 只有测试在用。
- s07 的 Mac 检查（未签名打包版、临时 `VONVON_HOME`）：接管分离 daemon、plist 内容、`daemon stop` 后 30 秒不拉起、卸载都通过。kill -9 后被拉起，launchd 记下 `last terminating signal = Killed: 9`；连续两次时第二次约 4 秒后看到新进程（每秒采样，没测准 5 秒节流）。Dock 用 Computer Use 没查成（超时），`lsappinfo` 里没有服务进程。在"App 后台活动"里关掉后 `service status` 显示已关掉，这时 `daemon start` 仍能把服务起来，系统设置里的开关还是关的；未签名打包版在那里显示为"Vonvon Bot"、"身份不明的开发者"。install 成功时原来把服务自己的 daemon 写成"Left behind"，已改成"running under the service"。
- s07 留下的，给 s08：服务正在跑时 install 拒绝替换定义，桌面端换新版本后要先 `daemon stop` 再 `service install`，或者在 s08 给 install 加"替换运行中的服务"。开关读 `service status --json` 的 `state`，`disabled` 就是系统设置里关掉了。网页和桌面端的 machine RPC 里 install、uninstall 仍然拒绝，s08 接到 CLI。系统设置里显示成什么，s08 看要不要在 plist 里加 `AssociatedBundleIdentifiers`（会改定义格式，旧定义变成 `unrecognized`，install 会重写）。
- s07 留下的，给 s17：`service status` 还不显示 launchd 的 `last exit code` 和 `last terminating signal`，崩溃记录做的时候一起加。s17 开工时拆给了 s17b，见 M4 的"s17 做法（行数）"。
- s07 留下的，给 s20a：Linux 的 install 没处理 linger；没有用户 systemd（比如容器里）时 `service status` 显示查不到，install 报 `User manager unavailable`。s20a 已改，见 M4 的"s20a 做法（linger）"和"s20a 做法（没有用户 systemd）"。
- s07a：放在第二条线上尽快做，因为 Linux 先行的验收要用它（本文第 1 节）。owner 2026-10-15 说："改配置也不一定非要网页端改。也可以 vonvon-bot 命令行改。我感觉命令行实现验收的快一些。你自行考虑。当然网页端的验收肯定也要的。"命令只调网页端已经在用的 RPC（快照、`listJoinedGroups`、`listPendingGroups`、`bindGroup`、各设置页的读和存，以及清单的 `admin setupStatus`、选文件夹的 `directory choose` 和群设置页的会话列表 `settings sessions`），走 `@vonvon/client` 的 `connectLocal` 和本机凭据，不改 daemon 的行为。本机凭据这条路和网页端同一级，给在终端里的主人用，不交给 agent，设置 skill 也不走它。s47 以后在同一套命令代码上另加 agent 那条路（从环境变量读地址和会话令牌，按 3.7 校验私聊和触发人）。`vonvon bot add`（终端扫码）仍在 s20a（s20a 已做）。行数和风险都是估的，开工时先量。
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
- s08 的做法：`service` 互斥锁串起终端、网页和桌面端的装卸。它和别的角色是同一种锁（当时是端口锁，s20c 起见 s20c 做法），进程死了就释放，不会留下陈旧的锁；拿不到就报"另一个后台服务操作正在进行"，不写结果文件。daemon 起助手前也先查：自己的助手还活着，或者结果文件说在跑、那个 PID 还活着，都直接回 busy。助手死后 PID 可能被别的进程用上，所以 PID 属于别的用户（发不了信号），或者"在跑"已经超过 10 分钟（比助手最长的一次还久），都当它已经结束。助手没写结果就以非零退出（没拿到锁，或者中途崩了），由起它的 daemon 补一条失败结果，开关旁边写出原因；这时另一个助手正在跑的，就不覆盖它的"在跑"。
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
- s08b 留下的：plist 里加不加 `AssociatedBundleIdentifiers` 还没定，等 s08b 的 Mac 检查第 B5 项看签名版在"允许在后台"里显示什么。#322 任务 10（2026-10-16，macOS 26.7）看了："App后台活动"里 `Node.js Foundation · 2个项目` 和 `Vonvon Bot · 1个项目` 都开着，Node.js Foundation 那一行没有 ⓘ，看不到两项各叫什么，所以还是定不了。要加的话，旧的 plist 成了旧格式，启动时的修复会重写它，不用另做迁移。
- s08b 留下的：两个版本之间协议版本变了时，启动时的修复认不出正在跑的服务 daemon（它的锁过不了协议校验），不会替换它，窗口最后弹"无法验证 daemon"。这种升级要先用旧版的 `vonvon daemon stop` 停掉，再打开新版。以后要修的话，让启动修复在登记是我们的、类型是桌面版、只差协议版本时，按 launchd 任务停掉旧 daemon。

### M3 群里的上下文

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s09 | 真名和水位 | 按 open_id 换真名并缓存，拉历史带 `with_sender_name`；修水位：话题第一条不再重放、bot 开话题写水位、插话和排队推进水位、话题补拉翻页（3.5 末尾第 4 到 8 条） | 500 | s01、e10 | 并发、错误路径 | 无 |
| [x] | s10 | 连续群的话题单独成会话，被迫换会话时说一声 | 话题消息一律按 thread_id 分会话（3.5 末尾第 1 条）；resume 失败或目录变了而重建会话时，运行卡上说明 | 250 | — | 错误路径 | 无 |
| [x] | s11 | 空闲超时 10 分钟、重试按钮、群里都能领文件 | 看门狗默认 600 秒，加暂停接口给 s30 用；超时和网络失败分开写、带［重试］；本群能用 bot 的人都能领文件（3.12） | 360 | — | 错误路径、并发 | 无 |
| [x] | s12 | 自动压缩一直开，上下文仪表常驻 | 去掉"关闭自动压缩"，已存的 false 读时忽略；运行卡头部一直有仪表，压缩时写"已压缩 85% → 20%"（3.5"压缩"） | 470 | — | 数据迁移 | 无 |
| [x] | s13 | 话题登记表 | 每个 bot 每个群一份，记话题 id、第一条、谁开的、几点、标题、有没有会话；SessionRecord 加可选字段，旧文件不迁移（3.5"daemon 在本机记什么"）；没有用户可见变化，s14、s15、s48 要读它 | 380 | s09 | 并发、数据迁移 | 无 |
| [x] | s14a | 对话记录块和主区补拉 | 统一的记录块，每条带时间和真名，@ 了 bot 的写"→ @你"，别的 bot 写"某某（bot）"；连续群主区按水位补拉，开场最多 20 条；拉历史和查引用带 `card_msg_content_type`，别的 bot 的卡片回答进记录块；话题补拉改用同一个记录块；缺 `im:message:readonly` 时只带触发消息（3.5） | 960 | s09、s13、e10 | 错误路径、并发 | 无 |
| [x] | s14b | 话题开场带主区、引用行、压缩后的话题表 | 话题开场带回指和主区 10 条，用户开的和 bot 开的都带；主区记录块里的引用行带两边会话 id，只送一次；从主区补拉和本机别的 vonvon bot 的登记表里认出别的 bot 开的话题；压缩后主区下一次开口附"本群最近 5 个活跃话题"；话题群尽量认出来，不带主区（3.5） | 1330 | s14a | 并发、错误路径 | 无（M3 验收前，预览版任务按 3.5 时间线第 1 到 6 步核对日志，规则模式下按"s14 留下的"里那一版） |
| [x] | s14c | 认出开在本 bot 自己回复下的话题；引用回复被开话题后不再丢 | 主区补拉把这个 bot 自己带 `thread_id` 的消息另外交回来，不进记录块，只用来认别的 bot 开的话题，引用行写"在你 10:05 的回复下"；引用了别的消息、后来又被开了话题的消息，不再当成话题里的回复丢掉（3.5） | 120 | s14b | — | 无 |
| [x] | s15 | /new、/compact 排队和撤回说明 | 加 `/new`；主区 `/new`、`/clear` 只限主人和管理员，话题里不换；`/compact` 忙时排队，压缩和换会话时来的消息不用重发；订阅撤回事件，进过会话的下次开口加一行说明（3.5"命令""撤回和编辑"） | 1140 | s10、s13、s14b | 并发、关闭清理、错误路径 | 无 |
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
  - 主区还不补拉（s14），主区的水位照旧推到触发消息。主区里开话题的触发消息不查水位，处理过的消息在重启后又被补推时，会再开一个话题（s14b 做了，见"s14b 做法（补推）"）。
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
- s11 做法（领文件）：`fileClaimMode` 去掉了"只有发起人或管理员"，本群能用 bot 的人都能领；项目停用时谁也领不了。点的人用自己的权限档，和文件写出时的档取交集，所以访客领不到完全权限档写在工作区外面的文件；这时只回点的人一句，不在共享卡上标错。s15c 去掉访客档以后，点的人和发起人用同一档，交集这一步可以删。s15c：点的人用群现在的档；文件写出时的档那一步留着：群的档调低以后，旧卡上工作区外的文件领不到。
- s11 留下的事：
  - s30 已按 3.8 接云文档评论：那里不发卡，收到提问立即回“无法回答”，由后端把确认/权限换成拒绝；不持有 `IdlePause`。
  - 给 s60：bridge 里存着 `runIdleTimeoutSeconds: 120` 的用户，多半是点过当时的默认按钮。换算时要不要去掉这个值，由 s60 定。
  - ［重试］只重放这一轮最初的输入。运行中插话补进来的内容不在里面，只在会话历史里。
  - 进程中途死掉（"agent 进程异常退出"）不算网络失败，没有重试按钮。
  - 登录失效的提示仍然写 `codex login`，Claude 会话也是这句；运行卡不知道后端是哪个，留给 s19 诊断页一起改。s19 已改：运行卡按后端写 Codex 或 Claude 的登录办法。
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
  - 话题开出来那一刻的主区会话 id 没记（3.5 的回指要用）。s14 在话题会话开场时取当时的主区会话；开话题之后、话题会话开场之前主区 `/new` 过的，回指会指向新的主区会话。s14b 照这个做了。
  - 仪表只在一轮结束时写：`/compact` 以后、下一轮结束以前重启，第一张卡先显示压缩前的读数，第一条读数到了就对了。`/context` 卡、网页上的上下文和 `/goal` 的卡，重启后在第一轮之前仍是空的。
  - 私聊里的话题不进登记表（3.5 只要群里的）。
  - JP-VPS 自验时看到，s13 之前就有：`daemon.log` 给收到的每条消息记了完整的话题 id 和正文前 40 个字（`D/bot/handle-message.ts` 的 `intake recv`），和 3.5"除了话题标题，群里的聊天内容不存到本机磁盘"不一致。s19 整理日志时去掉正文、id 截短，顺带查一遍别的日志有没有带正文。s19 已改，见 M4 的"s19 做法（日志）"。
- s14：拉别的 bot 的卡片回答要带 `card_msg_content_type`（e10）。不带时 2.0 卡片和 CardKit 流式卡片只返回标题和"请升级至最新版本客户端"，今天 daemon 发的正是这两种。`user_card_content` 返回发送时的卡片 JSON，比 `raw_card_content`（`D/bot/card-content.ts` 已在用的 `json_card` 包装）好解析。拉历史和查引用都要带。
- s14：话题里的引用（e10）：在话题里回复某一条时，`parent_id` 是被回复的那条，`root_id` 是话题根；直接在话题里发的消息，`parent_id` 是话题根。所以只有 `parent_id` 不等于 `root_id` 时才放引用，这就是 3.5"今天的代码和这里不一样"第 4 条的修法；引用话题根的那条分不出来，按普通消息处理。客户端里在话题中"回复"某条发出的是不是同一种消息，由 owner 在客户端里回一次，Claude 看 `parent_id`。"同时发送到群"收几次事件还没测（e10 第 5 项），s14 开工前请 owner 在客户端里发一条。
- s14 做法（拆片）：设计估出来约 1330 行，离 1500 行的上限太近，拆成两片。s14a 做记录块本身、连续群主区补拉、别的 bot 的回答和缺权限；s14b 做话题开场的回指和主区 10 条、引用行、认出别的 bot 开的话题、压缩后的话题表和话题群。s14a 不依赖 s14b，s15、s25 依赖 s14b。
- s14 做法（记录块）：补拉到的上文合成一个记录块，放在发信人一行的上面。第一行是 `[飞书 · 群「…」· 主区 · 你是「…」]`，话题里写 `话题「标题」`，标题取登记表的，没有就取话题第一条的开头；最后一行是 `[/飞书]`。恢复标题时把它和发信人一行一起剥掉。代码在 `D/bot/context-weave.ts` 的 `weaveRecordBlock`。中间每条一行"时间 名字：内容"：
  - 时间按 daemon 本机时区写 `HH:MM`，和触发消息不是同一天的写 `MM-DD HH:MM`；
  - @ 了这个 bot 的写"名字 → @你"，正文里去掉这个 @（富文本里的也去掉），@ 别人的照旧写在正文里；
  - 别的 bot 写"名字（bot）"，卡片还在流式输出的写"名字（bot，还没答完）"，截到 300 字；真人截到 280 字。没答完的卡片下一轮再拉一次，见"s14 做法（别的 bot）"；截掉的部分不再补；
  - 名字、标题和群名去掉 `〔〕「」→`，发信人的名字还去掉全角和半角括号，每样都压成一行，所以用户伪造不出 daemon 写的行，真人的名字写不成"某某（bot）"，也提前关不了记录块；
  - 放不下的写在第二行："（更早还有 N 条没带进来，需要时用 vonvon 飞书 skill 查）"，没翻完、数不出来的写"（更早的消息没带进来，…）"。
- s14 做法（触发消息在块外）：3.5 的例子把触发消息写成记录块的最后一行。s14a 仍把它放在块下面，照旧是发信人一行、引用、正文和附件清单：压成一行会毁掉多行文字和代码，也会丢掉 open_id、引用、附件路径和语音转写；插话和排队的消息本来就不带记录块。这一处和 product.md 不一致，按 4.2 第 2 类改了例子（#336，s14 留下的纯文档 PR）。
- s14 做法（主区补拉）：连续群的主区（会话键是群 id，分档时加 `#admin`、`#guest`，s15c 去掉分档）和话题一样按水位补拉，用 `container_id_type=chat`。这个容器列主区消息和话题第一条，不列话题里的回复；万一列出来，按 s14c 的办法认出来丢掉。窗口先在服务端用 `start_time`（水位，秒，向下取整）和 `end_time`（触发消息，秒，向上取整）框住，准确的边界仍在本地比。新建和重建的会话开场最多 20 条；已有会话只带没见过的，最多 40 条（第 5 节）。有记录、没水位的会话（手动 `/resume` 上来的）不拉。开话题群的主区不留会话，也不拉。
- s14 做法（水位）：沿用 s09，补拉成功才把水位推到触发消息，失败（包括缺权限）只记下触发消息，下一轮从原水位重拉；分档时每档的会话各有各的水位（s15c 去掉分档）。s09 留下的两处这片做了：主区的水位有了意思，晚到的补推在主区也按水位和送达的 id 跳过；断线期间丢掉的主区 @，下一轮作为记录块里的一行带进去（"张三 → @你：…"），不再单独回。主区的 `/goal` 不带记录块，改成只记下触发消息、水位不动，下一轮把这期间的消息补上。
- s14 做法（乱序的事件）：飞书的事件不保证按发送先后到。Y 先发、X 后发，X 的事件先到时，X 的补拉已经把 Y 作为一行带进了这一轮，Y 的事件随后才到。s09 只在晚到 1 分钟以上时查会话，Y 会再跑一轮，答两遍。改成话题和主区的每条消息都先查会话，在水位之内或送达过的跳过，照旧记 `late-redelivery-skipped`；代价是每条消息多读一次 `sessions.json`。Y 在 X 补拉期间到、排在 X 后面的，X 的这一轮被接住后，X 的记录块带过的消息从队列里拿掉，记 `queued-seen-skipped`，按 id 比，不按时间：插话的确认还没回来时补拉会按 id 跳过它，插话被拒后它重新排队，这时按时间比会把它丢掉。插话也按同一份 id 拦：Y 在 X 这一轮被接住后才准备好（查引用、下图片）的，不插话，记 `queued-seen-skipped`。还漏一处：agent 已经接下 X 这一轮、daemon 还没处理到它的 `turn_started` 时插话的，仍会插话进去一次。补拉带上和触发消息同一毫秒的消息，水位推到触发消息时盖得住它们。跳过的消息只剩记录块里的一行，图片和附件不带，长文截到 280 字，和断线补推一样。
- s14 做法（别的 bot）：拉历史和查引用（触发消息引用的那条、话题第一条、登记表查第一条）都带 `card_msg_content_type=user_card_content`，拿到发送时的卡片 JSON，由 `D/bot/card-content.ts` 的 `extractSendCardText` 读：2.0 读标题和 `body.elements`，1.0 读 `elements`，多语言的取中文；跳过折叠面板（vonvon 的过程和工具输出在里面）、`notation` 字号的状态行、备注、图片和按钮，重复的行只留一行；读不出正文的写"[卡片消息]"。JP-VPS 实测：`user_card_content` 拿到的卡片 JSON 没有字号和颜色，`notation` 那条判断在拉到的卡片上不起作用，vonvon 运行卡读出来带着上下文仪表和"用时 5秒"。所以另按文字认 vonvon 运行卡的状态行：整条都包在灰色 `<font>` 里、文字又是 vonvon 自己写的状态（用时、已处理、已压缩、正在输出，用量卡的"由 Vonvon Bot 于…生成"）的行，和上下文仪表那一行，都跳过；别的 bot 整条灰色的回答或备注照样留下；别处的 `<font>` 标签去掉、留文字。自己的消息按 `open_bot_id` 等于自己的 open_id、或者发送人 id 等于自己的 app id 来认，补拉时丢掉，话题第一条除外；别的 bot 的消息留下，以前一律丢掉。别的 bot 的卡片还在流式输出时，照样写成"还没答完"的一行，同时记进会话的 `streaming`（SessionRecord 加的可选字段，旧文件不迁移）；下一轮补拉从水位和其中最早那张卡片里更早的那个拉起，水位之内只重新带这几张卡片，读到最终回答。卡片距触发消息超过 10 分钟仍在流式输出的，不再重拉（第 5 节）。补拉失败时 `streaming` 不动，下一轮接着拉。
- s14 做法（缺权限和日志）：拉主区失败记 `chat-context-failed`，话题照旧记 `thread-context-failed`，没改名，s19 的诊断页可以接着用；缺 `im:message:readonly` 时都带 `reason: missing-scope` 和权限名，这一轮只带触发消息。每次补拉记一行 `record-block`：在哪（`main`、`topic`）、几行、更早还有几条、是不是开场、拉没拉成、几张没答完的卡片，不带正文，M3 核对日志看它。
- s14 做法（时限）：飞书 SDK 的 HTTP 请求没有超时（默认的 axios 实例没设 `timeout`）。补拉的每一轮都要等它，主区每轮都补拉，卡住一次这一轮就一直不开始。所以一次补拉的所有页合起来限 10 秒，查引用和话题第一条每次限 10 秒（第 5 节）。第一页就超时的，按失败处理，记 `chat-context-failed` 或 `thread-context-failed`，带 `reason: timeout`，水位不动；翻到后面几页才超时的，已经拉到的是最近的消息，照翻到页数上限那样带进去，"更早的消息没带进来"，记 `chat-context-timeout` 或 `thread-context-timeout`。查引用超时记 `quote-fetch-failed`，`err: timeout`。daemon 关闭时不等补拉和查话题第一条，按失败处理：这一轮不跑，水位不动，去掉 ⏳，这条消息下一轮作为记录块里的一行带进去。
- s14 做法（Linux 上的卡顿）：JP-VPS 实测时，daemon 重启后 Claude 群的第一条 @ 每次都报补拉超时，记录块是空的，bot 答的是会话里旧的问题。原因不在飞书：Claude 的 SDK 在 Linux 上每建一个会话都调一次 `process.report.getReport()`，只为看是 musl 还是 glibc；报告会同步反查每个打开的网络连接对端的名字，卡住事件循环 25 到 30 秒，这个 bot 所有群的流式卡片一起停住，计时器和早就回来的飞书响应排在一起，计时器先到，就成了超时。s14 之前就有（M1 的 Claude 群 `tResolve` 记过 11 秒、6 秒），只是没有时限、看不出来。`D/agent/claude-agent/backend.ts` 加载时设 `process.report.excludeNetwork = true`，报告不再带网络这一块，SDK 只读报告头。实测重启后第一条 @ 的 `tResolve` 从 25 到 29 秒降到 0.26 秒，补拉成功。macOS 上 SDK 不调这个函数。
- s14 留下的：
  - 话题开场的回指和主区 10 条、引用行、认出别的 bot 开的话题、压缩后的话题表、话题群由 s14b 做，见下面的"s14b 做法"。
  - product.md 3.5 的例子改成了触发消息在记录块下面，"今天的代码和这里不一样"标了已改的条目（#336）。
  - 3.5 时间线第 1 到 6 步是智能模式，规则模式下没有一种设置能照着走（第 2 步要 bot 开话题，第 4 步又要回在主区）。M3 核对日志用连续群、免@ 关的一版：1 主区闲聊；2 张三在 2 下开话题并 @bot；3 李四在 T1 里 @bot；4 主区 @bot；5 主区闲聊；6 李四在 R4 下开话题并 @bot。再在开话题群里做一次第 2 步，看 bot 开的话题的开场。s14b 做完才看得全。
  - "别的 bot 只放最终回答"是猜的：daemon 分不出最终回答和状态卡、帮助卡、设置卡，这些也会作为"某某（bot）"进记录块。还在流式输出的卡片不丢，标成"还没答完"，下一轮再拉一次（见上面）；JP-VPS 实测拉到的已完成的 vonvon 运行卡，`config.streaming_mode` 是 false；别家 bot 的卡片没测过。显示模型设成"始终"时，vonvon 运行卡末尾的模型脚注（例如"gpt-5.5 · 中"）在 `user_card_content` 里没有字号和颜色，单凭文字认不准，会作为回答的最后一行进记录块。
  - 水位盖住了、却没进记录块的消息，自己的事件后到时也被跳过，只记 info 级的 `late-redelivery-skipped`：飞书列表当时还没列出来的；只 @ 了 bot、没有别的字的（去掉 @ 后正文是空的）。和乱序到达、已经作为一行带进去的分不开，所以没另记 warn；要分，得记下每轮带过哪些 id。
  - 卡片 2.0 的表格（`table`，数据在 `rows`）不读，只有表格的卡片写"[卡片消息]"。
  - 分了管理员档和访客档的群（s15c 去掉访客档以后不再有），两档各有一条会话，补拉都丢掉这个 bot 自己的消息，所以每档只看到另一档的提问，看不到 bot 的回答。访客档的会话不该拿到管理员档的回答，这样是安全的一边；管理员档的会话缺访客档的回答，接受。要补的话只能补给管理员档，要先认出哪条回答是哪一档发的。
  - JP-VPS 实测（2026-10-15，验收 bot 拉，另用 owner 身份看列表的原样）：`chat` 容器的列表里没有话题里的回复，bot 在话题里的回复也没有；话题第一条带 `thread_id`，没有 `root_id` 和 `parent_id`；`start_time`、`end_time` 和倒序一起用，三轮补拉各拉到 5、3、1 条，和群里一致。1.0 卡片的 `user_card_content` 没有样本，没测。
  - e10 第 5 项"同时发送到群"2026-10-16 测了，结果见 s14d。
  - 主区的命令消息（`/model`、`/help`）也作为普通的一行进记录块。富文本消息里 @ 这个 bot 的那一处按 `at` 节点的 `user_id` 去掉；飞书列表里这里要是给的不是 `@_user_N` 而是 open_id，就去不掉，只是正文多一个"@名字"。
  - 排队的回合仍不补拉（s09），这期间主区的消息在下一个新的运行里补上，顺序靠后，但只进一次。
- s14b 做法（用户开的话题）：话题会话新建或重建时，触发消息带 `root_id` 的，先问群是不是话题群（见下面），不是就按话题第一条的时间往前拉主区 10 条（`before` 是第一条的时间，去掉第一条本身）。这次 bot 自己在主区的回复也留下，写成"你：…"；访客档的话题会话不留，和 s14a 一样是安全的一边（s15c 去掉访客档以后不再有）。块里先是回指一行"这个话题开在群主区 10:01 张三的消息下（主区会话 id：…）。主区的其他内容不在这里，需要时用 vonvon 飞书 skill 查。"，再是"主区在这之前："和这几条（引用行插在中间），再是"话题里："和话题里的消息。话题第一条后面标"（话题第一条）"，"更早还有 N 条"挪到它后面，因为拿掉的几条夹在第一条和最近的几条之间。第一条是 bot 自己的写"10:05 你的回复下"，别的 bot 的写"小P（bot）的消息下"；第一条读不到时写"群主区的一条消息下"，不拉主区、不写引用行。主区会话 id 只在连续群里写，取话题会话开场那一刻同一档的主区会话；多话题群不写。主区几条和引用行都不动话题会话的水位。没有会话记录的话题，问群、拉主区、认别的 bot 开的话题在拉到话题第一条后就开始，和起会话、列模型重叠；重建的会话在起会话之后才做。代码在 `D/bot/handle-message.ts` 的 `topicOpening`。
- s14b 做法（bot 开的话题）：多话题群主区 @ bot 开话题时，拉触发消息之前的主区 10 条、认里面别的 bot 开的话题，和起会话、下图片、织入引用并行。开场写"这个话题是你在群主区 10:01 张三的这条消息下开的，就是下面这条。…"，下面是"主区在这之前："和这几条；拉不到也写回指这一行。`/goal` 不带。话题会话的水位照旧是触发消息。
- s14b 做法（引用行）：连续群主区的记录块里，新开的话题按开的时间插进一行"10:01 〔话题〕李四在上面这条下开了话题「…」，你在那边另有一条会话，这里不用接。（话题 id：…，会话 id：…）"，排在同一毫秒的消息后面。从登记表取，会话 id 只取同一档的绑定：访客档只看 `#guest`，管理员档只看 `#admin`，没分档只看不带后缀的（s15c 去掉分档后只有这一种）；没有会话写"你在那边还没有会话"，只给话题 id。谁开的写名字簿里的名字（没有就写"用户"加 open_id 尾号）、"名字（bot）"、"另一个 bot"或"有人"；bot 自己开的写"你在…开了话题…，在那边另有一条会话"。开在哪条下：就是上一行的写"在上面这条下"；在块里别处的，人和时间取那一行的；不在块里的取登记表的；都不知道就不写。窗口：已有会话是水位之后到触发消息，去掉送过的；新建、重建的会话是带进去的最早一条到触发消息，一条也没带进去的（主区是空的，或拉失败）是触发消息之前的全部；水位是 0 的已有会话（新会话第一轮补拉失败后从头来）也从带进去的最早一条算，同样去掉送过的；话题开场是主区最早一条到话题第一条，不含这个话题。最多 10 行，留最新的，多的写"（还有 N 个话题没列，需要时用 vonvon 飞书 skill 列）"（第 5 节）。只送一次：`turn_started` 时把引用行按话题 id 和触发消息写进会话的 `seen`，同一次写盘；水位推到触发消息时它们随之清掉，补拉失败、水位没动时，下一轮靠它们跳过。补拉失败或缺权限时照样写引用行，记录块里只有它们和"更早的消息没带进来"（3.5"缺了时 bot 只看触发消息和 daemon 本机记下的消息"）。挑选在新的 `D/bot/topic-context.ts`，文字在 `D/bot/context-weave.ts` 的 `weaveRecordBlock`。
- s14b 做法（别的 bot 开的话题）：B 收不到 A 的消息事件，A 开的话题不在 B 的登记表里，但 B 的主区补拉列得出它的第一条，带着 `thread_id`。主区补拉和两种开场的主区几条里，登记表里没有的话题，每轮最多查最新的 5 个：`message.list` 按时间正序拉这个话题的头两条，第一条不是话题第一条的，它的发送人就是开话题的，时间就是开的时间。每次限 3 秒，并行；一个话题每次启动只查一次，失败也不再查，记 info `topic-opener-failed`；两轮同时碰到同一个话题时，后一轮等前一轮查完，用它的结果，登记表读在记进去之前的一轮也一样，查过的不占 5 个的名额。查到的记进登记表（`topic-discovered`），这一轮就写引用行。同一个 daemon 上别的 vonvon bot 开的话题不用查（设计里的 3b）：写引用行之前，从 `bots.json` 找到别的 bot，只读它们的登记表（`botPaths(appId).topicsDir`）里这个群、它们自己开的话题，取话题 id、第一条、开的时间和标题，写成"名字（bot）"，名字取 `bots.json` 的 `botName`。第一条的发信人只在是那个 bot 自己时写，别的 open_id 是那个 bot 的应用的，这个 bot 的名字簿对不上。会话 id 只取这个 bot 自己同一档的绑定，别的 bot 的会话 id 不写。两边登记表都有的话题，用这个 bot 的记录和绑定，开话题的人换成那个 bot（这个 bot 自己开的除外），开的时间取早的那个。别的 bot 的登记表没有就跳过；读不出或解析不了也跳过，每轮最多记一条 info `local-bot-topics-skipped`。代码在 `D/bot/topic-context.ts` 的 `quotable`。别家的 bot 和别的机器上的 bot 开的话题仍只看带进记录块的消息（见下面"s14b 留下的"）；开在这个 bot 自己消息下的由 s14c 补上。
- s14b 做法（话题群）：用 `im.v1.chat.get` 认，`chat_mode` 是 `topic` 或 `group_message_type` 是 `thread` 的算话题群（话题群和话题形式群），开场不写回指、不拉主区，只有话题里的消息和第一条的标记。只有用户开的话题的开场问。结果记 1 小时；问不到（没有可选的 `im:chat:readonly`、3 秒没回、返回错误）当普通群，记 10 分钟，记 info `chat-mode-unknown`（缺权限时带 `reason: missing-scope`）。先问群再拉主区，话题群就不白拉一次主区，代价是每个群每小时第一次开场拉主区晚一个来回，这段和起会话重叠。帖子本身触发的（有 `thread_id`、没有 `root_id`）没有第一条可指，也不问。
- s14b 做法（压缩后的话题表）：daemon 看到的压缩以后（运行里自动压缩结束且没失败、`/goal` 里的压缩、`/compact` 成功），主区会话下一次开口时，记录块最后附"〔本群最近 N 个活跃话题〕这条会话压缩过，前面的话题引用可能已经被摘要掉。更多话题用 vonvon 飞书 skill 列。"，下面最多 5 行"· 「标题」李四 10:01 开的，最近 10:30 有消息，你在那边有会话（话题 id：…，会话 id：…）"，按最近活跃排。标记存在 `SessionRecord.topicsDue`（新加的可选字段，旧文件不迁移），值是压缩的那条原生会话的 id，所以 `/clear`、`/resume`、重建以后自然不算；这一轮被接住（`turn_started`）时清掉，清的那次写盘排在之后的压缩前面。同一个运行里排队的回合、没织记录块的回合（有记录没水位的），在开跑前单独附一个只有这张表的记录块。登记表是空的就不附，标记留着。话题里的会话和 `/goal` 不附也不清。
- s14b 做法（补推）：多话题群主区的 @ 晚到 1 分钟以上时，先看登记表里有没有 bot 自己以这条为第一条开过的话题，有就跳过，记 `late-redelivery-skipped` 带 `reopen: true`。没管到的：建了卡片、话题 id 还没记进登记表时重启的。
- s14b 做法（日志）：`record-block` 加了引用行几行、没列的话题几个、表几行；话题开场另记有没有回指、主区几行、有没有主区会话 id、是不是话题群、主区拉没拉成；bot 开的话题记 `botOpened: true`。都不带正文，群 id 和话题 id 只写末 6 位。
- s14b 留下的：
  - 同一个 daemon 上的 vonvon bot 开的话题读它们的登记表（设计里的 3b，做了），product.md 3.5 说的"A 开的话题，B 的主区会话也会看到一行"对这些 bot 做到了。还缺的是别的机器上的 bot 和别家的 bot 开的话题：只从带进记录块的主区消息里认，开在水位之前的旧消息下的、B 这一轮已经带过第一条而 A 随后才开的，都没有引用行。开在这个 bot 自己的消息下的，s14c 补上了（见下面"s14c 做法"）。
  - 登记表里先从某人的回复见到的话题，开话题的人记成那个人，就算其实是别的 bot 开的（s13 的合并规则），引用行照这个写；认别的 bot 开的话题时跳过登记表里有的。同一个 daemon 上的 vonvon bot 开的除外，开话题的人按它的登记表改过来。
  - 话题第一次进登记表时，主区会话的水位已经越过它开的时间的，不会再有引用行；压缩后的表和 skill 能看到它。
  - 没有会话 id 的引用行也算送过，以后有了会话也不补一行带 id 的（3.5 接受：用话题 id 也找得到）。
  - bot 开的话题和 `/resume` 的话题，开的时间是本机时钟，消息是飞书的时间。差几秒时引用行会挪到相邻的位置或晚一轮；差得比两次触发的间隔还大时会丢。连续群里今天很少有 bot 开的话题。
  - 话题群没有 `im:chat:readonly` 时当普通群：帖子里的回复开场会把别的帖子当主区消息带进来，回指写"群主区"。3.5 写的是"尽量"。
  - 只认 daemon 看到的压缩：Claude 空闲时自己压缩的（s12 留下的）、在 Codex 应用里或 `claude --resume` 里压缩的，都不附表。s15b 已改成谁压缩的都附（D4 选 B，见 product.md 3.5）。
  - #336 在权限表里写了话题群要 `im:chat:readonly` 才认得出，按 4.2 第 2 类：一键开权限默认勾上它，默认装好的 bot 照样兑现 3.5。另两条是承诺变弱，按 4.2 第 3 类等 owner 定：话题表只在 daemon 看到的压缩之后附；别的机器上的 bot 和别家的 bot 开的话题，有几种情况没有引用行（见本节第 1 条）。
  - JP-VPS 实测（2026-10-15，验收 bot，Claude 连续群，@ 才回）：主区某条下开话题并 @ bot，开场带回指（含主区会话 id）、主区 10 条（bot 自己的回答写"你"）和标出的话题第一条；回主区 @ bot，记录块带这个话题的引用行，会话 id 和话题的会话一致，只带一次；主区 `/compact` 后下一次 @ 附了"本群最近 3 个活跃话题"（`table: 3`）；这个群 `chat.get` 认成普通群（`chat-mode` `topic: false`）。daemon 重启后第一次开话题，`tWeave` 从 6980 ms 降到 2959 ms（查群、拉主区、查别的 bot 的话题改成和建会话、读模型列表同时做），之后约 1 秒。还没测：缺 `im:chat:readonly` 时 `chat.get` 的样子、开话题群、"s14 留下的"里规则模式那一版时间线的 `record-block` 日志、第二个 bot 开的话题（同一 daemon 上走它的登记表，不记 `topic-discovered`，看引用行）。这几项在 M3 预览版任务里看。
  - JP-VPS 补测（2026-10-15，main a255ce1，验收 bot）：
    - 规则模式那一版时间线（Claude 连续群，@ 才回）。第 2 步主区某条下开话题：`record-block` 是话题开场，`pointer`、`mainLines: 10`、`mainSession` 都有，bot 说得出主区刚才在聊什么。第 3 步话题里再 @：不是开场，`lines: 0`。第 4 步主区 @：`lines: 2`、`quotes: 1`，bot 说得出话题开在哪条下，说不出话题里的内容（3.5）。第 6 步在 bot 的主区回答下开话题：开场带 `quotes: 2`、`mainLines: 10`。主区里比话题第一条晚的消息不在开场里，bot 答"不知道"，和 3.5"话题第一条消息之前的最近 10 条"一致。
    - 话题群：用 lark-cli 建了一个话题群（`group_message_type: thread`），绑 Claude，按话题独立会话。新帖子触发的会话不问群类型，开场只有帖子本身。在一个 bot 没回过的帖子里回复并 @ bot：`chat-mode` 记 `topic: true`，`record-block` 带 `topicGroup: true`，没有主区；bot 答得出帖子第一条，说自己看到的是帖子不是主区。
    - 还没测：缺 `im:chat:readonly` 时 `chat.get` 的样子（要在开发者后台去掉权限）、第二个 bot 开的话题（同一 daemon 上要有第二个 bot）。
- s14c 做法（自己的回复）：主区补拉丢掉这个 bot 自己的消息（s14a），可别的 bot 在其中一条下开了话题，这个 bot 收不到事件，登记表里没有，引用行就漏了。`D/bot/context-weave.ts` 的主区补拉把自己带 `thread_id` 的消息（话题第一条）另放进 `ThreadPull.ownRoots`，照样去掉撤回的、触发消息和晚于触发消息的；`handle-message.ts` 把其中和记录块同一个窗口的（新会话从带进去的最早一条算，已有会话还要没读过），和记录块的消息一起交给"认别的 bot 开的话题"，同样每轮最多查 5 个；它们作为 `RecordBlock.refs` 只给引用行查"开在哪条下"，不织成行，所以本机别的 bot 开在这里的话题也写得出"在你 10:05 的回复下"。`record-block` 日志加 `ownRoots`。只有窗口里的才看：开在这个 bot 更早的回复下的，和别人的旧消息一样没有引用行（"s14b 留下的"第 1 条）。
- s14c 做法（引用回复被开了话题）：JP-VPS 实测时发现，bot 的回答卡片是引用触发消息发的，`root_id` 和 `parent_id` 都是触发消息；别人在它下面开了话题，它多了 `thread_id`，`root_id` 不变。s14a 的主区补拉按"带 `thread_id`、`root_id` 不是自己"认话题里的回复，于是这种消息一被开话题就当成话题回复丢掉，bot 的回答和真人的引用回复都一样，s14c 第一版也因此没认出这个话题。改成：这种消息先放着，翻完页后，它的 `root_id` 指向的消息也列了出来、而且在同一个话题里，才算话题里的回复丢掉；否则按普通的主区消息（或这个 bot 自己的话题第一条）处理。`chat` 容器本来不列话题里的回复（s14a 实测），这一层只是防万一；话题第一条在窗口外、回复又被列出来的，会当成主区消息带进来。话题开场的主区 10 条也走这条路。
- s14c JP-VPS 实测（2026-10-15，验收 bot，Claude 连续群，@ 才回）：@ bot 得到回答卡片后，把 lark-cli 的应用 bot 临时拉进群，用它在这张卡片下开话题（验收 bot 没有收到事件），再 @ 验收 bot。日志 `topic-discovered`（`opener: bot`），`record-block` 带 `ownRoots: 1`、`quotes: 1`；送进会话的记录块里是"20:15 〔话题〕<那个 bot>（bot）在你 20:13 的回复下开了话题「…」，你在那边还没有会话，这里不用接。（话题 id：…）"，卡片本身不成行；bot 答出了谁、几点、在哪条回复下开的话题。改之前（只有第一版）同样的步骤 `ownRoots: 0`、没有引用行，原因就是上一条。测完把 lark-cli 的 bot 移出了群。
- s15 做法（命令）：`/new` 和 `/clear` 是同一个命令。连续群主区只限主人和管理员，别人发回"⚠️ `/new` 只有主人和管理员能用。主区的会话是大家共用的。"；话题里不换，照旧回"话题里不换会话…"；多话题群主区回"这个群的主区不留会话，不用 `/new`：@我 加内容就开一个新话题，每个话题是一条新会话。"。bot 正忙时照旧不收（"这一轮还在跑，结束后再 `/new`"，正在压缩时"正在压缩，压完再 `/new`"）。分了档的群只换发命令的人那一档。连续群的 `/help` 卡和欢迎卡写 `/new`（或 `/clear`），能 `/resume` 时加"旧的能 `/resume` 回来"；连续群话题里的 `/help` 卡改成"要新的会话，就在主区的某条消息下开一个新话题。"（s10 留下的那条）。
- s15 做法（新会话从命令往后算）：`SessionRecord` 加可选的 `from`，是这条会话收到的最早一条的时间。`/new` 写的新记录 `from` 是命令后 1 毫秒；新会话开场带进去的最早一行（补拉成功时）、话题会话开场主区的第一条（没有就是触发消息）在 `turn_started` 时和水位同一次写盘；网页控制台的"清空"也写。会话重建（进程死了、resume 失败）时，开场只拉到旧记录的 `from`，引用行的窗口也从它算，所以 `/new` 以后还没开口就重建的会话不带命令之前的消息，也不说"换了会话"，日志 `session-changed` 带 `unused: true`。
- s15 做法（`/compact` 排队）：bot 正在跑一轮时发 `/compact`，回"⏳ 等这一轮结束就压缩，不用再发。"，这一轮的终态卡发出后马上压，排在已经排队的消息前面；压缩时来的消息照常排队，压完接着跑。一条会话只排一个，再发回"已经排上了，这一轮结束后就压缩。"，正在压缩时回"正在压缩，不用再发 `/compact`。"，`/goal` 运行中回"🎯 目标运行中，结束后再 `/compact`。"，`/new`、`/resume` 占着时回"正在处理别的操作，结束后再 `/compact`。"。这一轮被 ⏹、看门狗停下，进程死了或出错时，排着的压缩不做，回"⚠️ 前面那一轮停了，`/compact` 没有执行，要压缩就再发一次。"，日志 `compact-dropped`；daemon 关闭时不回。压缩把进程弄死时，后面排队的消息照进程死掉的规矩丢掉并说一声。手动压缩仍是单独的"压缩中 → 压缩完成"卡（s12 留下的那条）：排着的压缩在两轮之间做，没有运行卡能写那一行。
- s15 做法（压缩和换会话时来的消息）：空闲时 `/compact` 或 `/new` 占着会话，这时来的消息不再回"请重发"，等命令做完（换会话失败也一样）按原来的顺序重新进入口，跑在新会话上，日志 `deferred`。换成了新会话时，发送时间在 `/new` 之前的（命令到时它还在准备，或者飞书的事件晚到）不跑，回"⚠️ 这条在 `/new` 之前发的，新会话不带它，要问就再发一次。"，日志 `reject` 的 `before-new`。daemon 关闭时不再跑。点［重试］照旧回"会话正在处理别的操作"。
- s15 做法（撤回，事件）：bridge 的原始事件分发器加 `im.message.recalled_v1`，事件里只有消息 id、群 id 和 `recall_type`（谁撤回的）。撤回比消息先到的（飞书的事件不保证顺序），消息到了也不跑：进程内记一天、最多 2000 个 id（第 5 节）。排队的和等命令做完的消息被撤回，直接丢掉。正在准备的那一轮的触发消息被撤回，这一轮照样答，`turn_started` 时给它补一条说明，下一轮说。事件是可选的：没订阅时首次运行清单的"事件订阅"一步多一条提醒（`RECALL_WARNING`），诊断列在缺的可选事件里，消息照常收。不用新权限。
- s15 做法（撤回，送到了哪些会话）：用 `message.get` 查这条消息的时间、话题和发信人（10 秒，失败记 `recall-lookup-failed`），按 daemon 记下的判断，代码在新的 `D/bot/recall.ts`：送达标记里有的（触发、插话、排队送过的）都算，查不到时只认这个；主区会话是水位以下、`from` 以后的主区消息，不含话题里的回复；话题会话是自己话题里水位以下的，加上开场带过的主区几条（`from` 到登记表里话题第一条的时间）。只记各位置、各档现在的绑定，写盘时会话 id 变了就不记；停泊的会话不记。bot 自己的消息不记。日志 `recall` 带群和消息的末 6 位、类型、查没查到、几条会话、记了几条；这个群还没有会话、是 bot 自己的消息、同一条的撤回事件又来时也记一行，`lookup` 分别是 `skipped`、`self`、`repeat`。
- s15 做法（撤回，说明）：记在 `SessionRecord.recalls`（消息 id、消息的时间、谁，不存正文），每条会话最多 20 条，按 id 去重。同一条的撤回事件又来（飞书可能推两次），不再查也不再记，免得说过的说明又加回去。下一次普通的开口（新的运行或排队的回合）在记录块里写一行"10:03 〔撤回〕李四撤回了一条消息，不要再用它。"；群主或管理员撤回的写"李四的一条消息被撤回了，不要再用它。"，别的 bot 写"小P（bot）"，不知道是谁写"有人"。时间是那条消息的发送时间，跟记录块一样不是同一天的写 `MM-DD HH:MM`。排在消息和引用行后面、话题表前面；没有补拉的回合单独一个只有这几行的记录块。`turn_started` 时按 id 清掉，所以清之前新记的留到下一轮。`/goal` 和插话不带；重建的会话不带（它本来没见过）。`〔撤回〕`和 s14b 的`〔话题〕`一样，名字里去掉〔〕，用户伪造不出来。`record-block` 加 `recalls`。
- s15 JP-VPS 实测（2026-10-15，验收 bot，Claude 连续群，@ 才回）：
  - `/compact` 排队：bot 正在答一段长问题时 @ 它 `/compact`，回"⏳ 等这一轮结束就压缩，不用再发。"；再发一次回"已经排上了，这一轮结束后就压缩。"；接着发的一条普通 @ 也排着。这一轮的回答发完后出压缩卡（13% → 9%），然后那条排着的消息照常回答，没有"请重发"。
  - `/new`：主区 @ bot `/new` 出"已开启全新会话"卡，日志 `clear` 带 `cmd: new`；紧跟着发的一条问会话里有没有上一段的内容，答"没有"。话题里 `/new` 回"话题里不换会话。要新的会话，就开一个新话题；`/resume` 请到主群区使用。"；`/help` 卡写着"`/new`（或 `/clear`）→ 换一条新会话，旧的能 `/resume` 回来"。
  - 撤回后的 `message.get`：用 owner 身份在测试群主区发一条不 @ 的消息、在话题里发一条，各自撤回，再用 owner 身份和一个临时拉进群的应用 bot 身份各查一次：都返回这条消息，`deleted: true`，`create_time` 照旧，正文变成"This message was recalled"，话题里那条还带 `thread_id`、`root_id`、`parent_id`；没有 230110。所以上面"送到了哪些会话"按查到的时间和话题判断，不用另记最近消息。临时拉进群的 bot 测完已移出。
- s15 留下的：
  - daemon 没在跑时的撤回收不到，除非飞书补推。
  - 正在准备那一轮时触发消息被撤回，这一轮照样答一次。补拉之后、`turn_started` 之前撤回的消息不记；只是被引用进别处的消息也不记。
  - 水位以下却从没带进记录块的消息，和 s15 之前就有的记录（没有 `from`），可能多记一条说明。说明多了无害，一律往多记的一边靠。
  - 重建的会话开场只拉到旧记录的 `from`，`/new` 之前的消息即使旧会话从没开口也不再带。
  - 网页控制台的压缩照旧只在空闲时做，不排队，也不标话题表（`topicsDue`）。
  - 排着的 `/compact` 在 daemon 关闭或重启时不做，也不说，和排队的消息一样；回复里的"不用再发"这时不成立。要补，得在 `SessionRecord` 记一个标记，重启后下一轮之前先压。
  - 换完会话以后才到、发送时间却在 `/new` 之前的消息，仍跑在新会话上：只有占着会话时到的才按时间挡。
  - 私聊里的 `/new` 和撤回等 s49。
  - 开发者后台里这个事件的中文名没核对，提醒里写的是「撤回消息」。撤回事件本身要 owner 在开发者后台给 bot 订阅、发布新版本后才收得到，JP-VPS 上的验收 bot 还没订阅，事件这一路（`bridge.ts` 的接线、`onRecall`、说明行）没在真机上走过。2026-10-16 两边各测一次：没订阅的 Bot 3（JP-VPS）撤回后照样答出被撤回的暗号，记录块 `recalls: 0`，清单的事件订阅一步仍是 ok，可选缺失里列出撤回事件；订阅了的 Bot 4（Mac 上的 M3 预览版）撤回后答"不知道"（M3 第 6 步）。
  - bridge 里撤回事件的接线没有单测，和"机器人被移出群"一样挂在 SDK 私有的原始分发器上；M3 第 6 步看日志里的 `recall`。
  - product.md 的两处已改：3.5"今天的代码和这里不一样"第 9 条标了 s15；撤回的说明行带`〔撤回〕`，不是本人撤回的写"的一条消息被撤回了"。压缩后话题表和别的 bot 开的话题引用行这两处缺口要不要补，等 owner 定了另开纯文档 PR。owner 2026-10-16 定了：话题表补（D4 选 B），引用行不补（D5 选 A），终端里接着用 bot 的会话也补（D6 选 A），见 s15b。
- s16 做法（设置源）：Claude 的三个辅助查询（登录检测、模型列表、生成标题）共用一套选项：只读 user 层设置，和回合是同一个 CLI、同一份 `env`，关掉 hooks、MCP 和 claude.ai 连接器，用 `claudeMdExcludes` 排除个人 CLAUDE.md。没读 project 层，因为模型列表按后端缓存，不按项目。
- s16 实测（JP-VPS，SDK 0.3.296）：传 `model: 'default'` 或调 `setModel(undefined)` 都用账号的默认模型，不看 `ANTHROPIC_MODEL`，只有不传 model 才用它。bot 的会话总是传一个明确的模型，所以用户设置里 `env.ANTHROPIC_MODEL` 指定的模型排到列表第一、当默认（其次是 daemon 自己的 `ANTHROPIC_MODEL`，再其次是设置里的 `model`）；列表里没有就补一行，SDK 失败时的兜底列表也一样。配了 `ANTHROPIC_MODEL` 时，SDK 的列表末尾会多一行 "Custom model"。
- s16 做法（手填）：手填的 id 只挡空白、控制字符、反引号、尖括号、`-` 开头和超过 200 字，不对模型列表校验，填错了在回合里报错。`/model` 卡总有一个手填表单，提交会锁卡，结果发一张新卡接管；会话记 `modelCustom`。默认模型卡的下拉多一项"自定义模型 ID…"，项目记 `defaultModelCustom`，`pickDefault` 见到它就原样用。网页的"新会话默认模型"和"本话题模型"也能手填，协议的 `ModelSelection` 加了可选的 `custom`；评论模型不开放。顺带：没有会话时 `/model` 卡不再显示"已切换"；群设置里默认模型选得不对时，带提示重发表单，不再不声不响地回到群设置卡；Codex 返回空列表时不再把兜底列表缓存一辈子。
- s16 留下的：改了用户设置里的 `ANTHROPIC_MODEL` 要重启 daemon 才进模型列表（列表按进程缓存）。手填 id 的推理强度给后端协议的全部档位，第三方模型认不认没实测。owner 用 DeepSeek 或 Kimi 的话，M3 验收时试一次手填和默认。

### M4 崩溃恢复、诊断和 Linux 命令行版

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s17 | 崩溃记录、整机暂停和 daemon restart | daemon 主进程崩溃前写 `~/.vonvon-bot/crash/` 记录，被强制结束的下次补一条；10 分钟 3 次进入暂停；加 `vonvon daemon restart`，`daemon status` 显示暂停和最近崩溃；bot 子进程的记录移到 s18，`service status` 和逐条写日志移到 s17b（3.10） | 1500 | s07、e06 | 错误路径、关闭清理、并发、子进程 | launchd 下 10 分钟内 kill -9 三次：进入暂停、网页能开、每次都补了记录，`daemon restart` 能恢复 |
| [x] | s17b | `service status` 显示上次退出，关闭失败逐条写日志 | launchd 的 `last exit code`、`last terminating signal` 和 `runs`，systemd 的 `Result`、`ExecMainCode`、`ExecMainStatus` 和 `NRestarts`；AggregateError 里的每条错误各写一行日志；s17 合入后开（3.10） | 770 | s17 | 子进程、错误路径 | 短检查：launchd 下 `service status` 的上次退出和启动次数跟 `launchctl print` 一致 |
| [x] | s18a | 单个 bot 暂停和崩溃记录 | bot 子进程的崩溃记录、快照的 `application.crashes`、`bot list` 和 `bot status` 显示暂停，崩溃种类和文字搬进协议（都从 s17 移来）；单个 bot 10 分钟崩 3 次只停它；诊断页列崩溃记录，红条带"恢复运行"（3.10）；s18 开工时拆出 s18b，见"s18a 做法（行数）" | 1020 | s17、s19 | 并发、错误路径、子进程 | 无（M4 验收时看红条） |
| [x] | s18b | 崩溃私聊 | 主进程用 bot 的应用身份直接给主人发私聊，不靠长连接，暂停时也能发：daemon 或某个 bot 崩溃后稳定 30 秒发"刚才崩溃过一次，已自动恢复"，进入暂停时马上发"10 分钟内崩溃了 3 次，已停止自动重启"；每个 bot 每 10 分钟最多一条，进入暂停的那条不受限；daemon 主进程崩溃时只由最早加入的 bot 发，列出受影响的 bot；网络错误隔 1、5 分钟各再试一次（3.10）；排队消息和锁的两项开工时移到 s18c，见"s18b 做法" | 1070 | s18a、e10 | 并发、错误路径、子进程 | 无（M4 验收时看私聊） |
| [x] | s18c | 重启时丢掉的排队消息 | 关闭一开始先断开长连接，之后到的消息由飞书重推给下一个进程；关闭前把排着队、暂存的消息（含 `/new`、`/compact` 期间的）、排着的 `/compact` 和等并发槽的那一轮记进 `bots/<appId>/dropped.json`，bot 起来连上飞书后每个群在最新那条下面回一句"刚才重启了，这条没处理，请再发一次"，诊断页"最近没回的消息"记一条（3.10）；开工时拆成三片，见"s18c 开工时拆成三片" | 1387 | s18a | 并发、错误路径、子进程、关闭清理 | #365；无（M4 验收第 5 步 Claude 先做：bot 答话时在同一话题再发一条，`vonvon daemon restart` 后 bot 在那条下面回"刚才重启了……"，诊断页多一条） |
| [x] | s18d | 子进程排空上限和占锁提示 | 被托管的子进程收到 IPC 断开（主进程已死）后最多排空 20 秒，到点退出 0；孤儿排空时 owned-work 报告不再每秒报错；退出 75 不放大崩溃退避，前两分钟 5 秒一次、之后 30 秒一次，子进程先查锁再校验凭据；两分钟后日志和诊断页写出占锁进程的 PID，每次重试重查（3.10）；从 s18c 拆出，见"s18c 开工时拆成三片" | 340 | s18a | 并发、错误路径、子进程、关闭清理 | 无（M4 验收时看诊断页） |
| [x] | s18e | bot 崩溃时的排队消息、正在准备的那一条和没发出去的暂停私聊 | bot 子进程自己出错崩溃时，崩溃处理器在退出前同步写 `dropped.json`；关闭时正在准备的第一条也记，桌面端协作发起的不记；进入暂停的私聊一排上就写进 `crash/unsent-notices.json`，下次启动同一轮还暂停着、24 小时内用原来的 uuid 补发（3.10）；从 s18c 拆出，见"s18c 开工时拆成三片" | 480 | s18b、s18c | 并发、错误路径、子进程、关闭清理 | 无（M4 验收时看私聊） |
| [x] | s18f | 桌面在 daemon 崩溃后重新连接 | 无服务操作标记的普通断线也等待本机 daemon 回来，重新读取端点和凭据并认证；替换连接后刷新快照，三次崩溃的暂停红条和恢复按钮可用。保持原有服务切换路径，超时仍提示连接失败；退出时取消等待并清理迟到连接（3.10，Mac 任务 22 发现） | 300 | s18a | 并发、关闭清理、错误路径、桌面 | Mac 隔离服务三次崩溃、桌面恢复；合入后安装修复预览版并补正常启动检查 |
| [x] | s19 | 状态与诊断页 | 按 bot 列连接状态、Codex 和 Claude 的版本与登录、缺的权限；每个 bot 记最近没回的消息和原因（3.1 第 8 条） | 450 | s03、s01 | 并发 | 无 |
| [x] | s20a | Linux 命令行版（上）：平台、open --print、linger、终端扫码 | 平台枚举加 linux、去掉 windows，界面显示"这台 Linux 主机"；`vonvon open --print`；`service install` 处理 linger；没有用户 systemd 时的说明；`vonvon bot add` 终端扫码；Linux 的首次运行清单加"Linux 上 Codex 只能用完全访问"一步和 Claude 的沙箱检查（3.10） | 1130 | s07、s04 | 子进程、错误路径 | 无 |
| [x] | s20c | 互斥锁换掉端口 | 四个角色（`admission`、`host`、`keystore`、`service`）的互斥锁不再用和 Linux 临时端口重叠的端口：Linux 用抽象命名空间的 Unix 域套接字，macOS 用带 `O_EXLOCK` 的文件锁；升级那一刻和旧版本的锁过渡；`inspectHost` 跟着改 | 380 | 无 | 并发、关闭清理、合入门禁 | 装着 M3 预览版、它的 daemon 在跑时，新版本的 `vonvon daemon start` 不会再起一个；macOS CI 跑锁的测试 |
| [x] | s20e | 删掉锁的旧端口过渡 | 删掉 s20c 留下的过渡：拿到新锁后不再去占、去连旧端口，`projects`、`creation` 的豁免随之去掉；碰巧占着旧端口的无关监听者（连上后不说话、或者一句不说就关）不再让锁报 busy，#382、#385 的 macOS CI 撞上过；还原 #385 为躲过渡加的测试夹具；见"s20e 做法" | 373 | s20c | 并发、合入门禁 | 无 |
| [x] | s20b | Linux 命令行版（下）：Codex 只能完全访问，删 windows-job | Linux 上的 Codex 遇到只读、读写档不起会话，回一句说明，设置里置灰；删 `codex-appserver/windows-job.ts`；在这片的 head 上做 Linux 验收（3.8、第 8 节第 5 条） | 400 | s20a | 子进程、关闭清理、错误路径 | 无（Linux 在 JP-VPS 上验） |

开工要点：
- s17：e06 实测 `kill -9` 后约 1 秒被拉起，两次启动至少隔 `minimum runtime`（默认 10 秒；产品 plist 的 `ThrottleInterval` 是 5，实际间隔没测）；`launchctl print` 的 `last exit code` 和 `last terminating signal` 分得清正常退出和被杀。原先打算用 Security 框架 `SessionGetInfo` 的安全会话 id 判断"重新登录过"，s17 没用（要原生代码，e06 也没验过）：正常退出就开始新的一轮计数，注销时 launchd 发 SIGTERM，daemon 照停止处理，下次登录重新数。注销时 daemon 是不是来得及退出没验过，见"s17 留下的"。开机用开机标识区分（Linux 的 `boot_id`，macOS 的 `kern.bootsessionuuid`）。
- s17：2026-10-15 在 JP-VPS 上发现：网页端点"重启"（`restartHost`）时，关闭阶段的清理失败会取消重启，手动启动的 daemon 就此停掉；AggregateError 里面的各条错误没写进日志，看不出是哪一步失败。做 `daemon restart` 时一起处理。（重启这一半 s17 已改，见"s17 做法（重启）"；逐条写日志移到 s17b）
- s17 做法（记录）：记录在 `<数据目录>/crash/`，一次崩溃一个文件，名字是 `host`（s18 加 `bot-<appId 的 sha256 前 12 位>`）、时间、PID 和 8 位随机数；先写临时文件再改名，目录 0700、文件 0600。内容是版本、种类、`错误名: 错误的第一行`、运行了多久、所属的那次运行和"一轮"的 id；原因去掉了家目录、飞书 id（留末 6 位）、网址里的账号和参数、32 位以上像令牌的串，最长 200 字，不存调用栈，调用栈照旧打到 stderr（`daemon.log`、`service.err.log`）。种类四种：未捕获的异常、未处理的 Promise 拒绝（`D/host/crash-guard.ts` 的处理器写完记录就退出，退出码 70）、没人要求停止时 `daemon run` 出错退出（比如端口被占），和被系统强制结束（kill -9、内存不够、abort）。强制结束靠 `crash/run.json`：主进程拿到互斥锁后写它、每 60 秒更新一次心跳、正常退出时删掉；下次启动看到它而没有这次运行的记录，就补一条，时间取最后一次心跳，运行时长写"至少"（第一分钟内不写）。重启机器（开机标识不同）不算崩溃。每种最多留 50 条、30 天，主进程启动时清理。bot 子进程也装了处理器，但只打印、退出 70（Node 原来是 1），记录在 s18。
- s17 做法（暂停）：一轮从一次正常启动开始，崩溃后再起来的算同一轮。同一轮里 10 分钟内（按开机以来的时间算，改系统时间不影响）主进程崩溃 3 次，下一次启动就进入暂停：网页、RPC 和 API 照常，bot 子进程一个都不起，启用 bot 时报"daemon 已暂停（10 分钟内崩溃了 3 次）…"；暂停中再崩溃仍是暂停。停止和重启过程中的崩溃照样记，但不计数。离开暂停：`vonvon daemon restart`、网页的"重启"（`restartHost`，整机暂停时 s18a 红条上的"恢复运行"也调它；单个 bot 的见"s18a 做法（恢复运行）"）、`daemon stop` 再 `start`、更新 daemon、注销或重启机器。后台服务管着的 daemon 在暂停中又起不来（端口被占、暂停中又崩溃）时退出码是 0，launchd 和 systemd 就不再拉起它，免得每 5 秒写一条记录；`daemon status` 照样显示暂停，`daemon restart` 写一个 2 分钟内有效的 `crash/resume.json` 再启动，新的一轮从头数；上一次被强制结束、没留下记录的照样补一条。
- s17 做法（重启）：`vonvon daemon restart`：daemon 在跑就发 `restartHost`，后台服务管着的退出 75 由服务管理器拉起，分离运行的由同一端口的重启助手拉起，等到新的 PID（最多 120 秒，每 5 秒打一行进度）；没在跑就带恢复请求启动；daemon 正在停止时说"正在停止或重启，等它结束后再试"。重启时清理失败不再取消重启（删掉了 #276 加的 `requestStop` 和"75 改成 0"），服务管着的 daemon 照样退出 75（放开监听失败时也是）；新进程要等旧进程退出才启动，端口和锁都已放开，留下的 Codex 进程下次启动时清理。`daemon run` 在前台时收到 SIGHUP（终端关了）当停止处理，不再留下强制结束的记录。关闭时丢掉的排队消息、暂存的消息和等着的 `/compact` 只记条数（`bridge shutdown_dropped`）。
- s17 做法（daemon status）：第一行不变；暂停时加一行"已暂停：10 分钟内崩溃了 3 次，bot 都没有启动。查完原因后运行 vonvon daemon restart 恢复运行。"（没在跑时写"暂停期间 daemon 又出错退出，没有自动重启"；上次开机留下的暂停不显示，下次启动也不算暂停），再列 24 小时内最多 10 条记录。`--json` 多了 `paused` 和 `crashes`（总是数组）。只读文件，不问服务管理器，不建目录，因为每条 RPC 命令前都要跑它。
- s17 做法（行数）：设计估出约 1,450 行，`service status` 那段先拆给 s17b；写完量出约 1,790 行，又把 bot 子进程的记录和快照里的 `application.crashes` 移到 s18（两样都是 s18 才用），AggregateError 逐条写日志移到 s17b，剩下约 1,500 行。
- s17 和设计不一样的：除了上面移走的三样，暂停中又崩溃时暂停行里的次数沿用进入暂停时的；`daemon restart` 遇到还没准备好的 daemon 直接说"正在启动，稍后再试"，不等它；`pid-lock.ts` 没动，开机标识的读法放在 `D/host/crash-store.ts`；崩溃种类和文字先放在 daemon 里（daemon 用 zod 4，协议包是 zod 3），s18 搬进协议。
- s17 JP-VPS 实测（2026-10-16，分离运行，临时数据目录）：kill -9 后 `daemon start`，连做三次，第四次启动进入暂停，`daemon status` 显示暂停和三条"被系统强制结束"，网页返回 200；`daemon restart` 换了 PID、端口不变、不再暂停、没有新记录；`daemon stop` 删掉 `run.json`、不加记录；`VONVON_TEST_CRASH=exception` 约 2 秒后退出，留下一条"程序出错"，下次启动没有重复的强制结束记录；前台 `daemon run` 收到 SIGHUP 退出 0、不留记录。
- s17 JP-VPS 实测（systemd，2026-10-16，用 3e91872 打的包装到临时前缀，临时数据目录）：
  - `service install` 后在跑，`crash/` 里只有 `run.json`；`daemon stop` 后 unit 是 inactive，`run.json` 删了，没有记录；`daemon start` 由 systemd 拉起。
  - 连续 `kill -9` 三次，每次从 kill 到新的 daemon 能答话 11 到 23 秒（`RestartSec=5` 加启动；同时机器上在跑 `npm ci`）。第三次以后进入暂停，三条"被系统强制结束"；60 秒内 PID 不变、`NRestarts` 停在 3，网页返回 200。
  - 暂停中 `kill -9`，再占住它的端口：systemd 拉起一次，新的一次 `EADDRINUSE` 退出 0，unit 停在 inactive、`Result=success`，60 秒内 `NRestarts` 不涨；`daemon status` 显示 stopped 和"暂停期间 daemon 又出错退出，没有自动重启"，多一条强制结束和一条"出错退出"（都标暂停期间）。放开端口后 `daemon restart` 恢复，不再暂停。
  - 再 kill 三次进入暂停，`daemon restart`：换了 PID、端口不变、"已恢复运行"，记录条数不变，网页 200。
  - 心跳：`run.json` 的 `aliveAt` 每 60 秒更新；kill -9 后两分钟再启动，补的强制结束记录时间是 kill 前 17 秒的那次心跳，不是启动时间，带开机标识。
  - `VONVON_TEST_CRASH=exception` 的那一套（分离运行）同上一条；`service uninstall` 后 unit 文件没了，`LoadState=not-found`。验收 daemon 前后是同一个进程。
  - launchd 那几步等 Mac 检查。
- s17 留下的：
  - 给 s18：bot 子进程的记录（处理器里按 `VONVON_HOST_RUN_ID`、`VONVON_HOST_CHAIN_ID` 记到主进程的运行下，supervisor 在子进程退出时清它那一类，一分钟最多一次，不然反复崩溃的 bot 一天能写几千条）；子进程被信号杀掉或起不来时由 supervisor 补记录；单个 bot 暂停用 `countInWindow` 按 bot 数；快照的 `application.crashes`（暂停和 24 小时内的记录，每次重建只 stat 一次目录），`bot list`、`bot status` 第一行显示暂停；"刚才崩溃过一次"的私聊由最早加入的 bot 在子进程里读记录；私聊 10 分钟一条的限额要另存一个文件。（私聊以外 s18a 已做，见"s18a 做法"；私聊放进 s18b，改由主进程发，见"s18a 留下的"）
  - 给 s18：重启或停止时丢掉的排队消息（`shutdown_dropped` 记了条数的那些），owner 2026-10-16 让 Claude 定：关闭前把它们的消息 id 和所在群、话题记下来，bot 起来以后在原处回一句"刚才重启了，这条没处理，请再发一次"，每个群最多一条，诊断页"最近没回的消息"记一条（product.md 3.10）。（放进 s18b，s18b 开工时移到 s18c；s18c 已做，见"s18c 做法"）
  - 给 s17b：`service status` 加上次退出和自动重启次数，systemd 的上次退出只在服务没跑时看得到（JP-VPS 实测）；AggregateError 里的每条错误各写一行日志，`daemon run` 失败时 stderr 也逐条打印。（s17b 已做，见"s17b 做法"）
  - Mac 检查（隔离的数据目录和临时 npm 前缀，不碰 `com.vonvon.bot.daemon`）：launchd 下 10 分钟内 kill -9 三次，记下每次被拉起隔了多久，进入暂停后 2 分钟内 PID 不变、网页能开；`daemon restart` 恢复，`launchctl print` 的 `last exit code` 和 `last terminating signal` 怎么变（决定 s17b 显示哪几项）；`daemon stop` 后不拉起、没有新记录；`sysctl -n kern.bootsessionuuid` 能读到、睡眠唤醒后不变，记录里带着它。
  - 待 owner（可选）：注销再登录时 daemon 来不来得及退出。launchd 的 `ExitTimeOut` 默认 20 秒，daemon 停止最多要 12 秒再加 Codex 的清理（s18b 起还等进入暂停的私聊，和排空并行，最多 15 秒）；来不及的话每次注销会多一条强制结束的记录，要在 plist 里加 `ExitTimeOut`。
  - 给 owner 定：关闭时丢掉的排队消息要不要告诉发信人。今天这些消息在重启后只作为补拉的上下文，不会被回答。
  - 管不到的：daemon 在拿到互斥锁之前就失败（服务登记读不出、锁被一个验证不了的进程占着）时没有记录，服务管理器照旧每 5 到 10 秒拉一次，和以前一样；看 `service status` 和 `service.err.log`。
- s17b 做法（service status）：launchd 从 `observeJob()` 已经读到的那份 `launchctl print` 里取顶层（一个 tab）的 `runs`、`last exit code`、`last terminating signal`，有 signal 行就是被信号结束，不多跑 launchctl；systemd 另跑一条 `systemctl show -p LoadState -p Result -p ExecMainCode -p ExecMainStatus -p ExecMainExitTimestamp -p NRestarts`（超时 10 秒，和 `is-enabled` 同时跑，用户总线卡住时不比以前多等），`observeUnit()` 的严格解析和事务不动，`LoadState=not-found` 当没有记录。`service status` 在第二行后面加"上次退出"，再加"启动次数"（launchd 的 `runs`，从登录或安装算起）或"自动重启"（systemd 的 `NRestarts`，手动启动清零）。服务在跑时 systemd 不保留上次退出，这时写明去看 `vonvon daemon status`。退出码只解释 daemon 自己用的 0、1、70、75；信号 9 加"kill -9 或内存不够"，SIGTERM 写"被正常停止（SIGTERM）"，`Result=oom-kill`、`start-limit-hit` 各加一句。`--json` 多 `exits` 和 `lastExit`。协议里早就有的 `lastExit` 填上了，网页"后台服务 → 高级"那一行改名"上次退出"；Linux 上能看网页时服务一定在跑，systemd 不保留上次退出：拉起过（`NRestarts>0`）的，网页和命令行是同一句"服务在运行时 systemd 不保留……"（审查后改，之前网页写"无记录"），没拉起过的网页写"无记录"。`exits` 不进协议。
- s17b 做法（逐条写日志）：`log.fail` 遇到 AggregateError（嵌套的、`cause` 是 AggregateError 的也拆）时，主行加 `parts`，后面每条一行 `fail_part`：`part` 是 `2.1` 这样的序号，`within` 是中间各层的 message，最多 20 条，最多看 200 个值、8 层。同一个对象再记一次只写主行，带 `partsLogged` 和第一次拆分的时间 `partsAt`，分条就在那个时间的几行；嵌套组的分条被 20 条的上限截掉了（哪怕一条），不算拆过，以后单独记它时照常拆。主行和分条共用一个 `ts`，按它进那一天的文件，跨零点也不分开。分条的 JSON 照 s19 的规则截短整串就是飞书 id 的字段，终端原样。命令失败时终端先打主消息，再每条一行 `  - 层 › 名字: 内容`（`daemon run` 的进 `service.err.log` 或 `daemon.log`）；崩溃处理器同样逐条，崩溃记录的 `reason` 不变。bootstrap 补记 process host、`daemon.pid` 和 host 互斥锁的清理失败。开工时核过：supervisor 和单个 bot 的 finally 只记它们自己 try 里的失败，之前的（服务登记、锁、registry、onboarding）没人记，所以 bootstrap 的 catch 补一条 `daemon-run.fail`，只进 JSON 日志，不打终端（命令行接着会打这条错误，审查后改）；已经由 `log.fail` 记过的，包括 supervisor 抛出的、里面每条都记过的那个 AggregateError，不再记。测试接缝 `VONVON_TEST_CRASH=cleanup`。三个接缝（`exception`、`rejection`、`cleanup`）只用于验收，打包后的也认（验收装的就是打包的），所以设了哪个，每次启动都写一条 `daemon-startup.test_seam` 警告；服务的 unit 和 plist 只带 `VONVON_HOME`、`VONVON_SERVICE` 和 `PATH`，终端里留下的变量进不了服务，服务管着的 daemon 关闭时清理失败也照旧退出 0 或 75。
- s17b JP-VPS 实测（systemd 255，2026-10-16，用 5219644 打的包装到临时前缀，临时数据目录，单元名带哈希）：装好在跑时只有"自动重启：0 次"，没有"上次退出"。`kill -9` 后 1 秒内：`installed, stopped`，"上次退出：被信号 SIGKILL（9）结束（kill -9 或内存不够）。systemd：Result=signal，<时间>"，和 `systemctl show` 一致（这时是 `activating/auto-restart`）；被拉起后 running，"服务在运行时 systemd 不保留……"和"自动重启：1 次"。`daemon restart` 后"自动重启：2 次"。`daemon stop` 后"退出码 0（正常退出）。systemd：Result=success，<时间>"：`daemon stop` 是 daemon 自己退出 0，不是 SIGTERM。`daemon start` 后"自动重启：0 次"。`service uninstall` 后新加的两行都没有，`LoadState=not-found`。网页"高级"里那一行是"上次退出 / 无记录"。`VONVON_TEST_CRASH=cleanup` 分离运行再 `daemon stop`：`daemon.log` 末尾是主消息加两行 `  - …`，第二行带 `VONVON_TEST_CRASH nested ›`；JSON 日志一条 `fail`（`parts: 2`）、两条 `fail_part`，`daemon logs` 里看得到；没有崩溃记录。验收 daemon 前后是同一个进程。
- s17b 审查后补测（systemd 255，2026-10-16，一个只会 `exit 1` 的临时 unit，`RestartSec=100ms`、`StartLimitBurst=3`）：拉起次数用完后是 `failed`、`Result=exit-code`、`ExecMainCode=1`、`NRestarts=3`，这时手动 `start` 被拒，这几项不变；`reset-failed` 把 `NRestarts` 和 `ExecMainCode`、`ExecMainStatus`、`ExecMainExitTimestamp` 一起清零。所以"服务在运行时 systemd 不保留"（`ExecMainCode=0` 且 `NRestarts>0`）只在新进程在跑时出现。
- s17b 留下的：
  - Mac 检查：launchd 下 `service status` 的上次退出和启动次数跟 `launchctl print` 逐项一致；`daemon start`（`kickstart`）算不算一次 `runs`，不算就改"启动次数"那句说明。
  - systemd 在 `RestartSec` 里（被杀后、拉起前）状态显示 `installed, stopped` 和"Run vonvon daemon start"，其实几秒后 systemd 会自己拉起。状态判断 s17b 没动，留给 UX 那一轮。
  - 启动前就失败（服务登记读不出、锁被验证不了的进程占着）时，每次启动在 JSON 日志里多一条带 stack 的 `daemon-run.fail`，约 0.75 KB。unit 文件坏了时 systemd 每 5 秒拉一次，不会因为启动频率限制停下（审查时 JP-VPS 实测：33 秒 `NRestarts=6`，没有 `start-limit-hit`），一天约 13 MB；`gcOldLogs` 在 s17b 之前就没有调用方，按天的日志从来不删。没改：这一行是诊断页能看到服务为什么起不来的唯一记录。接上日志清理会删掉 7 天前的日志，是另一项行为变化，单独做。
  - 关闭时 process host、`daemon.pid`、host 互斥锁的清理失败照旧先在终端打一行 `✗ [daemon-shutdown.fail]`（AggregateError 再加各条），命令行退出时再打一遍，和 supervisor 的清理失败一直以来一样。只在清理失败时出现，不会每次启动都打，没改。
- s18：机器人能不能给没开过会话的主人发私聊，e10 没测到：owner 已经私聊过测试 bot。2026-10-16 用测试 bot Bot 7 补测：bot 用应用身份给从没开过它私聊的主人发文字私聊，按扫码时记下的 ownerOpenId、receive_id_type=open_id 返回 code 0，进了 p2p 会话；按 union_id 发也行，同一租户的自建应用 union_id 通用；owner 确认手机和电脑都弹了通知（2026-10-16）。所以不用再找同事。给主人发私聊要用这个应用下主人的 open_id，或者用 `user_id`、`union_id`，不能用 lark-cli 应用下的 open_id。
- s18 开工时拆成 s18a（记录、单个 bot 暂停、快照、命令行、诊断页）和 s18b（私聊、重启时丢掉的排队消息）：设计估出约 1,760 行（含测试），s17 写出来比估计多两成多。s18a 不往外发任何东西，可以单独合入；M4 第 2 步的红条和"恢复运行"只要它。
- s18a 做法（记录）：被托管的子进程（`daemon run --bot`，带 IPC）用 `openBotCrashContext` 装 s17 的处理器，记录按 supervisor 传的 `VONVON_HOST_RUN_ID`、`VONVON_HOST_CHAIN_ID` 挂在主进程这次运行和这一轮下，`scope: 'bot'`，带 `appId`；子进程不写 `run.json`、不写心跳、不修剪，崩溃一律退出 70（后台服务管着时也是），停止期间崩溃也不删主进程的 `run.json`，不然主进程这一轮就断了。单独运行一个 bot 时没有这两个 id，照旧只打印。子进程没写成的由 supervisor 在 `exit` 时补：被信号杀掉的记"被系统强制结束（SIGKILL）"和准确的运行时长；退出码不是 0、70、75 的记"出错退出"，原因取 stderr 最后一行，拿不到写"退出码 N"；退出 70 却没有这个 PID、子进程启动 5 秒前以后的记录文件，补一条"子进程出错退出，没留下记录"（加上时间这一条，记录留 30 天里 PID 复用也不会错认）。子进程的 `fatal` 全由 supervisor 补，子进程里不写。`exit` 处理器里每一步读写各自 try/catch，失败只记日志：`crash/` 坏了时一个 bot 崩溃不会变成主进程的崩溃。修剪每个 bot 一分钟最多一次。
- s18a 做法（暂停）：每次算崩溃的退出后，supervisor 数这个 bot 这一轮、`during: run`、10 分钟内（开机以来的时间）、上次恢复运行以后的记录，和内存里记的次数取大的（磁盘满、`crash/` 读写不了时靠内存）；到 3 次当场停，不再排重启，别的 bot 照常。暂停存在 `crash/bot-pauses.json`：`{ v: 1, chainId, bots: { <appId>: { pausedAt, pauseCrashes, resumedUptimeMs } } }`，只有主进程写，先写临时文件再改名。主进程崩溃后再起来是同一轮，暂停的 bot 照旧不起（文件坏了当作没有，全部照常起，记一条 warn `bot_pauses_corrupt`，和 `run.json` 的 `marker_corrupt` 一样）；新的一轮（`daemon restart`、网页的"重启"、停止再启动、更新、重启机器）全部恢复。不算崩溃的：退出 0（照退避重启，只记日志）、退出 75（见 D2）、停止和停用时的退出。子进程收到停止前一瞬崩溃的记录是 `during: run`，同一轮里会被下一次数进去；只在主进程崩溃后的同一轮里显出来，接受。
- s18a 做法（恢复运行）：单个 bot 的红条按钮发 `setAgentEnabled(true)`：清掉暂停，内存里的次数清零，记下这一刻的开机时长，之前的记录不再数，退避回到 1 秒。在 Bot 页停用再启用也一样：停用即放弃暂停，停用的那一刻就照恢复运行记账，`bot status`、`daemon status` 和 `bot-pauses.json` 不再说它暂停着，再启用时直接起。`bot-pauses.json` 写不进去（磁盘满、没有写权限）时恢复运行照样生效，靠内存；写失败记一次日志，之后在下一次子进程退出、下一次起子进程时和每 30 秒重写，写成了就停，在这之前 `daemon status` 可能还显示暂停。启动时没起的 bot（已停用）在文件里的状态原样留着，不被别的 bot 写盘冲掉。命令行不加 `vonvon bot resume`，`bot status` 写"在网页的状态与诊断页点「恢复运行」，或运行 vonvon daemon restart"。整机暂停时只显示整机那一条红条，按钮调 `restartHost`。暂停中的 bot 收到网页的写请求（含绑群和协作），回"机器人「名字」10 分钟内崩溃了 N 次，已暂停。在状态与诊断页点「恢复运行」后再试。"；第 3 次崩溃那一刻在途的请求也回这一句，不再回"进程已退出（等待自动重启）"。
- s18a 做法（快照和页面）：协议加 `P/crash.ts`：种类、文字、`crashText`、`formatUptime` 和三个 schema，都不用 `.strict()`，记录列表不设上限，由 daemon 裁到 20 条（桌面端严格解析整个快照，多一条、多一个字段就整页失效）；`agents[].paused` 和 `application.crashes`（整机暂停和 24 小时内最多 20 条记录）。记录的 schema 还在 daemon（daemon 是 zod 4、协议包是 zod 3），只共用种类列表。快照每次重建只 stat 一次 `crash/`，mtime 变了或过了 30 秒才重读；子进程退出时和 supervisor 每写一条记录后清掉缓存，下一次重建一定重读（文件系统时钟粗，同一个刻度里的写入不改 mtime）。暂停的 bot 的 `activation` 写 `active`，不显示"待生效"。诊断页最上面是红条（`role="alert"`），"这台电脑"和每个 bot 各加一行"最近的崩溃"（这台电脑只列主进程的），bot 的连接写"已暂停"。`daemon status` 加一行"已暂停的 bot：名字（10 分钟内崩溃了 N 次）……"，名字从 `bots.json` 读，`--json` 多 `pausedBots`；`bot list` 写"已暂停（10 分钟内崩溃了 N 次）"，`bot status` 第二行写怎么恢复。
- s18a 做法（D1，主进程死后子进程写 stdout）：设计审查时在 JP-VPS 上用探针复现了（Node 24）：主进程 kill -9 后，子进程先收到 IPC 断开、开始排空，下一次写 stdout 报 EPIPE，没有监听就是未捕获的异常，子进程退出 70、留一条"停止期间"的记录、排空中断。不会出现 `during: run` 的假崩溃，但会打断排空。`guardParentPipes` 在 stdout、stderr 上装 `error` 监听，吞掉 EPIPE 让排空走完，顺带请求停止兜底。真实进程的测试：有监听时排空走完、退出 0、没有记录；去掉监听退出 70。
- s18a 做法（D2，新子进程撞上旧子进程的锁）：被托管的子进程拿不到 bot 的单实例锁（`BridgeAlreadyRunningError`）时退出 75，supervisor 不算崩溃，照退避（1、2、4、8 秒，最多 30 秒）重试；单独运行时照旧退出 1。JP-VPS 实测（2026-10-16，分离运行，临时数据目录，假的飞书接口）：用一个活着的进程占住 `processes.json`，子进程连续 4 次退出 75，没有记录、没有暂停；放开后下一次拿到了锁。真的"旧子进程还在排空"没复现：假 bot 过不了 `bot/v3/info`（SDK 走 axios，没假到），起不来就没有可排空的旧子进程。代价：持有者一直不放锁时（主进程死后旧子进程的排空一直不结束，没有人再给它补 SIGKILL）无限重试，不记录、不暂停，页面只显示没在运行，看不出原因；和 main 比不是回归，main 上同样的情况退出 1，也是无限重试。改法留给 s18b，见"s18a 留下的"。
- s18a 做法（macOS 的进程组）：产品 plist 没有 `AbandonProcessGroup`，按 launchd.plist(5)，job 的主进程死后 launchd 杀掉同一进程组的进程；子进程没有 `detached`，和主进程同组。所以 macOS 上主进程被 kill -9 时子进程跟着被杀：D1、D2 碰不到，也不会有假的 bot 崩溃记录；s18c 的"重启时丢掉的排队消息"在主进程崩溃时记不下来，只有 `daemon restart`、`daemon stop` 和 bot 自己重启时能回。这一版不改 `detached`：`settleOwnedChild`、`stopChild` 的进程组语义会跟着变。这是按文档推的，M4 的 Mac 检查确认。systemd 下主进程死后也是先停掉 cgroup 里剩下的进程再重启，D1、D2 主要在分离运行（`daemon start`）时碰到。
- s18a 做法（行数）：设计估约 1,020 行，写完量出约 960 行，审查后的修复加到约 1,150 行（加减行合计，源码约 570、测试约 550、文档约 40），没到 1500，原先准备超了就移给 s18b 的命令行和两处"最近的崩溃"都留在这一片。
- s18a 和设计不一样的：`guardParentPipes` 放在 `D/host/crash-guard.ts`，不在 `lifecycle.ts`（子进程的测试要把它打包进去）；设计 1.2 让子进程在 `closeHostRun` 里写 `fatal`，改成全由 supervisor 补；起不来（spawn 失败）不再一律算崩溃，见第 5 节；`HostRunStart` 多了 `crashes`（这一轮 10 分钟内的次数，恢复请求后为 0）和 `pausedAt`，给 s18b 的私聊用；查"子进程写没写记录"多要求文件名时间不早于子进程启动前 5 秒；协议的 schema 不 strict、不设上限；`daemon status` 里 bot 的名字从 `bots.json` 读。
- s18a 留下的：
  - 给 s18b：私聊（设计第 3 节和 P1 到 P4、P10、P12）：主进程用 bot 的应用身份直接发，新文件 `D/host/crash-notify.ts`，限额存 `crash/notices.json`；`HostRunStart.crashes`、`pausedAt` 已经备好，supervisor 的三个点接通知：bot 进入暂停（`countCrash`）、主进程启动、bot 恢复运行；`notifier.close()` 放在 `finally` 最前面，免得排空的十几秒里 30 秒计时器到点发出"已自动恢复"。（s18b 已做，见"s18b 做法"）
  - 给 s18c（原给 s18b）：重启时丢掉的排队消息（设计第 4 节、P6 到 P9）；停用再启用也会回"刚才重启了"，文字略不准，接受；macOS 上主进程崩溃时记不下来（上面"macOS 的进程组"）。（s18c 已做，见"s18c 做法"）
  - 给 s18b：product.md 3.10"要实测"那一句按上面 e10 的补测改成已测，第 9 节第 16 项跟着改；限额一句补"进入暂停的那条不受这个限制"（P2）；主人不止一个时只发给最早加入的 bot 的主人（P3）；主进程崩溃时 macOS 上记不下丢掉的排队消息。M4 第 1 步私聊的时间按 P10 改。这一片的行为和 3.10 不冲突，product.md 没改。（s18b 已改；macOS 那一句写成推断，M4 的 Mac 检查确认）
  - s18b 多角度审查留下的：关闭的那 15 秒里没发出去的暂停私聊，由 s18e 落盘并在同一轮暂停中补发。
  - 给 s18c（原给 s18b）：D2 的代价（多角度审查 lifecycle/L1）。被托管的子进程收到 IPC 断开（主进程已死）后给排空设上限，比如 `CHILD_SHUTDOWN_GRACE_MS` 加一点余量，到点 `process.exit`，旧子进程最多占锁几十秒；supervisor 连续退出 75 超过约 2 分钟时用 `readSingleInstanceHolder` 查持有者，`log.warn` 一次带它的 PID，快照里给这个 bot 一个"被 PID N 占着"的提示。
  - Mac 检查：launchd 下 kill -9 主进程时子进程是不是一起被杀（设计 D3），放进 M4 预览版。顺带看子进程收到的是 SIGTERM 还是 SIGKILL：是 SIGTERM 的话子进程会走关闭、照样写 `dropped.json`，product.md 3.10 里 macOS 那半句删掉，代码不用改。
- s18b 开工时又拆了一次：设计估约 1,240 行（私聊、排队消息、锁和孤儿排空三块），独立审查估 1,600 到 1,800 行，开工前就把排队消息和锁两块移成 s18c（两块都不依赖私聊）。s18b 只做私聊和文档。
- s18b 做法（私聊）：新文件 `D/host/crash-notify.ts`，在 supervisor（主进程）里，不经过子进程。发信时读这个 bot 的 `config.json`：配置完整、有主人（`ownerOpenId`，老配置回退第一个管理员）、密钥读得出，才用它的 app id 和密钥换 `tenant_access_token`，再按 `receive_id_type=open_id` 发文字消息，两步各 10 秒超时、不跟重定向；每次发都重读，不在内存里留密钥。bot 自己那两条只由它自己发，配置坏了就不发（记 `crash-notify skipped`）；主进程那两条按 `createdAt` 从早到晚找第一个能发的 bot，在发的那一刻找。
- s18b 做法（时机）：bot 崩溃但没暂停时先记着，重启出来的子进程活过 30 秒才发；30 秒内又崩的，等待作废，记着的那条换成新的次数和原因（"10 分钟内崩溃了 N 次……最近一次的原因"）。bot 第 3 次崩溃、判定暂停时马上发，清掉它还没发的"已自动恢复"和排着的重试。主进程：这次启动带着上一次的崩溃记录（停止或重启期间的不算）、没暂停、不是带恢复请求起来的，30 秒后发"daemon 刚才崩溃过一次"，列这次启动要起的 bot（同一轮里已单独暂停的不列，一个都不剩时不写这一栏）；进入暂停的那次启动马上发，列全部启用的 bot；暂停中再起来不发。恢复运行和停用 bot 清掉它记着的和排着的。原因用崩溃记录的 `crashText`（s17 已去掉家目录、飞书 id 和令牌），退出 70 时读子进程自己写的那条（`crashRecordFor`），读不到写"程序出错（子进程出错退出，没留下记录）"。
- s18b 做法（限额和重试）：按发信 bot 记最后一次发成功的时间，存 `crash/notices.json`（0600，只有主进程写，写时丢掉一天前的），同一次开机里 10 分钟内同一个 bot 不再发第二条，记 `crash-notify limited`；进入暂停的两条不受限额，但照样占名额；`notices.json` 坏了当空的，写不进去时只靠内存。所有发送排成一条链，查限额、发、写文件不和别的交错。网络错误、超时、HTTP 5xx、HTTP 429、飞书 `99991400`（通用限流）和 `230020`（发消息限流）在 1 分钟、5 分钟后各再试一次，三次用同一个 `uuid`（开工时验证过：同一个 uuid 返回同一个 message_id，不会重复）；别的 4xx 和 `code` 不是 0 的不重试、不占名额，记 `crash-notify failed`。
- s18b 做法（关闭）：supervisor 的 `finally` 第一句 `notifier.close()`：关掉所有 30 秒计时器，丢掉普通私聊的重试，掐掉在途的普通私聊；进入暂停的那条（在途的、已排着的或等着重试的）和子进程排空一起等，最多 10 秒，合计不超过 15 秒。主进程那条在 `startApi` 之前登记，所以整机暂停后端口被占、`startApi` 抛错时，暂停那条照样发出（D1）。
- s18b 做法（行数）：设计估约 1,240 行（三块），拆出 s18c 后私聊这一块估约 650 行；写完量出约 1,070 行（加减行合计，源码约 415、测试约 600、文档约 50），测试比估计多，主要是假计时器下的重试、限额、关闭和变异检查补的用例；审查后的修复加到约 1,260 行（源码约 490、测试约 715、文档约 55），多角度审查后的修复加到约 1,370 行。
- s18b 和设计不一样的：`loadSender` 返回发不了的原因（写进日志），不是 undefined；限流错误码按审查后的决定加了 `230020`；`crash-store.ts` 新加 `crashRecordFor`（审查第 7 条）；主进程那条的"受影响的 bot"一个都不剩时省掉这一栏（审查第 6 条）；起不来（ENOENT、EACCES）计了数但没暂停的，也等下一个子进程活过 30 秒再发，起不来时清掉刚开始的 30 秒等待。
- s18b 独立审查后的修复（审查结论能合，六条低级别发现都复现了，都改了，各补用例并做了变异检查）：整机暂停时 `bots.json` 读不出来，暂停那条改由 `bots/` 下有目录的 bot 发（目录建得早的先，`config.json` 里没有 `createdAt`），不再一条都发不出；没装崩溃处理器就崩的子进程，原因从 Node 自己打印的那段里取错误那一行（`stderrReason`，不再是最后一行"Node.js v24.x"）；关闭时暂停那条的发信 bot 在关闭以后才读完配置的，10 秒从读完时重新算一次（最多一次，合计原为 20 秒，多角度审查后改成不超过 15 秒）；上一次崩溃在 10 分钟以外（没有服务管理器、隔了很久手动 `daemon start`）不发"刚才崩溃过一次，已自动恢复"，记 `crash-notify skipped why=stale`；关闭时掐掉的私聊记 `crash-notify cut`（普通的 info，暂停那条 warn），不再混进 `failed`；补了"读配置期间恢复运行或停用"的用例。
- s18b 多角度审查后的修复（五条都复现了，都改了，各补用例并做了变异检查）：关闭的等待合计最多 15 秒（launchd 默认 20 秒后 SIGKILL，原来最坏约 20 秒）；关闭期间进入暂停的那条遇到可重试的失败，不等 1、5 分钟，隔 1 秒排到队尾再试，次数不变，关闭前已排着的重试马上发，等待结束时还没轮到的记 `crash-notify cut`；主进程那两条在最早的 bot 被飞书明确拒收（换令牌或发消息，不重试的那类）时换下一个 bot，可重试的失败不换，请求可能已经送达；读不出配置或密钥（`config-unreadable`、`secret-unreadable`，外部密钥程序超时会这样）也隔 1、5 分钟再试，没主人、配置不完整的不试；私聊里的原因去掉本机路径，只留最后一段（文件名），网址和 `/open-apis/` 开头的飞书接口路径不动，诊断页照旧。
- s18b 修复的增量审查（Fable，能合，四条低都改了）：关闭等待的用例钉住"等到关闭期间的 1 秒重试发出才结束"；去路径只认绝对路径（`/…`、`~/…`、`file://…`），词里的斜杠（`HTTP/2`、`text/html`、`codex/gpt-6.1-sol`、日期）和相对路径不动；2xx 但读不出响应体的按可重试（同一个 uuid），不再当拒收换 bot；关闭掐断以后不再等那 1 秒。
- s18b JP-VPS 自测（2026-10-16，分离运行，临时数据目录，两个假 bot：注册表里"晚到"在前、`createdAt` 在后，各有自己的 `ownerOpenId`；假的飞书接口用 s18a 的 `d2/fake-feishu.mjs` 改的预加载：`fetch` 的换令牌照常、发消息按模式回、请求记下来，SDK 走的 axios 一律连到本机关着的端口，不碰真实飞书）：
  - 起来后两个 bot 在 `bot/v3/info` 上各崩 3 次，十几秒内各自的主人各收到一条"「早到假bot」10 分钟内崩溃了 3 次，已停止自动重启，别的 bot 照常。最近一次的原因：出错退出：could not resolve bot identity via /open-apis/bot/v3/info …，运行了 2 秒。查完原因后……"，各用自己的 app id 换令牌，`receive_id_type=open_id`，`redirect: error`。
  - `kill -9` 主进程再 `daemon start` 两次：30 秒后都记 `crash-notify limited`（发信 bot 是 `createdAt` 早的那个，它 10 分钟内发过），没有新私聊；第三次进入整机暂停，马上一条"daemon 10 分钟内崩溃了 3 次，已停止自动重启，bot 都没有启动：晚到假bot、早到假bot。最近一次的原因：被系统强制结束（……）。……或运行 vonvon daemon restart。"，在限额内照发。
  - 假飞书回 503 时 `daemon restart`：两个 bot 的暂停那条各在 0、1、6 分钟发了 3 次，三次同一个 `uuid`，日志 `retry`、`retry`、`failed`；回 400 加 `230013` 时各发 1 次，记 `failed`，不重试。
  - 主进程上一条私聊 10 分钟以后再 `kill -9`、`daemon start`（两个 bot 在这一轮都单独暂停着）：30 秒后一条"daemon 刚才崩溃过一次，已自动恢复。原因：被系统强制结束（……），运行了至少 4 分 0 秒。"，没有"受影响的 bot"一栏。验收 daemon 前后都在跑。
- s18c 开工时拆成三片：设计估约 1,850 行（排队消息本体、子进程排空上限和占锁提示、崩溃和关闭时的补漏），s18b 写出来是估计的 2.1 倍，开工前拆成 s18c（排队消息本体，估约 1,030）、s18d（子进程排空上限和占锁提示，估约 340）和 s18e（bot 崩溃时的排队消息、正在准备的那一条和没发出去的暂停私聊，估约 480）。s18d 和 s18c 不改同一处逻辑，可以并行；s18e 改 s18c 的文件，等 s18c 合入。M4 预览版在 s18c 合入后就开，不等 s18d、s18e：s18d 的两处在 macOS 上被 launchd 整组结束遮住，s18e 的私聊和 Mac 无关。
- s18c 做法（收哪些、什么时候写）：编排器的 `shutdown()` 在 `shuttingDown = true` 之后、清队列和 `interrupt()` 之前，同步收四处的"原处"：会话队列（已织进当前这一轮记录块的不收）、`/new` 和 `/compact` 期间暂存的、排着的 `/compact`、等全局并发槽的那一轮（新的 `state.waiting`，排上槽时设、拿到槽后清）。原处是群、消息 id、发送时间和回复位置（和这条消息平时的回复一样），没有正文。同步写进 `bots/<appId>/dropped.json`：每个群一项，留发送时间最新那条的 id 和位置，条数相加；0600，先写临时文件再改名；写时丢掉一天前的，最多 200 个群，读时超过 64 KB 当坏文件删掉。整段在关 Codex、放锁之前，从收到停止到写完只隔几个微任务；只写一次。只有 `daemon run` 传文件路径，测试和别的调用方不读不写。等并发槽的排队卡在关闭时写"⏹ bot 停止运行了，这一轮没开始"，摘要也改，不再写"已取消排队"；关闭正好落在建排队卡的那次请求里时，卡建好后马上取消、照样翻成这一句，建卡期间已经拿到槽的由 `launchRun` 翻（审查后补）。
- s18c 做法（先断长连接）：`bridge.ts` 的关闭第一句就 `channel.disconnect()`（当场用 `Promise.allSettled` 接住，拒绝不会变成未处理的），再关编排器，断开的结果最后才看，失败照旧记 `ws disconnect`、进 AggregateError。SDK 收到事件只推进群队列就回确认，原来最后才断开，关闭那几秒到的消息被确认了又丢掉，谁也不回；现在没确认的由飞书重推给下一个进程。断开只关 WebSocket，卡片更新和回复走 HTTP 不受影响；关闭期间点卡片按钮会提示失败。原来 5 处断言"提供者收尾之前不断开"的测试改成"一开始就断开了，关闭仍等提供者收尾，错误照样带出来"。
- s18c 做法（起来后怎么回）：子进程 `channel.connect()` 成功后才读文件，连不上时文件原样留给下一次。一个群一个群回：走原始的 `im.v1.message.reply`，不走 `channel.send`（原消息没了时它会改成在群里另发一条）；`reply_in_thread` 按记下的位置；uuid 是 `vd-` 加 app id、群、消息 id 和汇总版本的 sha256 前 40 位；10 秒超时；返回体 `code` 不是 0 也算失败。文字"刚才重启了，这条没处理，请再发一次。"，不止一条时"这条和这个群里另外 N 条都没处理"，停了 10 分钟以上开头换"bot 停了一阵"。读出来不删，一个群结案才从文件删它那一项（还是同一条消息和汇总版本才删），回到一半被 kill -9 时下一个进程接着回，同一个 uuid 飞书只回一条。限流（`99991400`、`230020`）、5xx、429、断网、超时隔 1、5 分钟各再试一次；SDK 换 tenant token 时飞书回 2xx 却没给 token，SDK 抛的普通 Error 只在消息里带码，和崩溃私聊一样分：限流和没给码的再试，别的码按拒绝结案，原因写"没拿到 token，飞书 <码>"（审查后补）；飞书拒绝的（撤回、不在群里、缺权限）不再试；不是飞书错误的异常按拒绝结案、不留在文件里。整个循环和每一项都接住，不会变成未处理的拒绝让 bot 崩到暂停。关闭以后不再开始新的一项，关闭后才到的结果照样结案。`daemon run` 等 bridge 和提供者都关完才清诊断的 sink，关闭中途结案的那一项照样进诊断页；之后到进程退出前才到的结果只删文件、不进诊断页，窗口只有放 API 和锁的那一会儿（审查后补）。开工前用 lark-cli 的应用身份在测试群核对过（2026-10-16，只调 HTTP）：同一条消息带同一个 uuid 回两次，两次 `message_id` 相同；`reply_in_thread` 为真时回在话题里；不存在的消息 id 回 HTTP 4xx 加 `99992354`，按拒绝处理。撤回的消息回什么码没实测，代码按文档写的 `230011`，M4 第 5 步看。 同群又合并一批时递增可选的 `revision`（旧文件按 0），旧在途结果只删自己那版；版本也进 uuid，发送时间更早的新消息不会被旧结果吞掉或被旧 uuid 去重。
- s18c 做法（诊断页）：一个群结案时报一条"最近没回的消息"，新原因 `restarted`："重启或停止时这条还在排队，没处理"；回成了下一步写"已在原处回了一句请重发。"，没回成写"在原处回一句请重发没成功（原因），请告诉发消息的人重发。"。IPC 事件加可选的 `times`，次数等于条数，bot 标题上的"N 条没回"跟着数对。原消息撤回了：只有这一条时不报（同 s15），不止一条时报条数减一，原因写"最新那条撤回了"。缺权限的同时进"缺的权限"。超过一天作废的不报。
- s18c 做法（行数）：设计估约 1,030 行；写完量出约 1,110 行（加减行合计，不含 lockfile：源码约 380、测试约 680、文档约 50），没到 1,300，第 5 节准备的挪法一样都没用。按审查改完后 1,354 行（源码 422、测试 884、文档 48），多出来的主要是审查要补的测试，超过 1,300 但在 1,500 的上限内，没有再挪。
- s18c JP-VPS 自测（2026-10-16）：假 bot 连不上长连接，起不来编排器，端到端靠编排器的集成测试和 M4 第 5 步。文件级检查：用 esbuild 把 `restart-dropped.ts` 和 `paths.ts` 打成一个包，在临时 `VONVON_HOME` 下写、读、结案：`bots/<appId>/dropped.json` 是 0600、目录 0700，目录里没留 `.tmp`，读了不删，两个群都结案后文件删了。设计列的 12 个变异检查都红（"去掉循环的 catch"试了两种改法），在 worktree 的副本里做。审查后新加 8 个用例、改了 2 个（纯函数⑤、⑩），在副本里对修之前的代码跑：测修复的 4 个（托管子进程的诊断、编排器④的两个建卡用例、纯函数⑩）都红；只补测试的 5 处（拿到槽后清 `state.waiting`、10 秒超时、64 KB 上限、写文件失败的 catch、关闭后的重试守卫）各做变异，对应用例都红。
- s18c 和设计不一样的：10 秒超时放在回复循环里，不在调接口的那层；返回体没有 `code` 也算失败，按拒绝结案、不重试；缺权限时诊断页的原因写"缺 <权限名>"，`reportScopeDenied` 在编排器那层调；`dropped-read` 只在文件里有项时记；可重试的失败在关闭以后才到时不再排重试，这一项留在文件里给下一个进程，关闭以后到的最终结果照样结案；`bridge-startup-drain` 第一个用例第一次 `waitFor` 的时限放到 10 秒：main 上它失败是冷启动导入超过默认的 1 秒（已知的老问题），放宽后通过。
- s18d 做法：受托管的 bot 断开父进程 IPC 后，20 秒未排空就记 `orphan-drain-cut`，刷新日志最多再等 1.5 秒，退出 0 并由退出钩子放锁；计时器不阻止正常排空结束。父进程已消失时 owned-work 不再尝试回报 IPC，只记一条信息。退出 75 独立于崩溃退避：前两分钟 5 秒重试，之后 30 秒，重查占锁 PID 并在变化时刷新日志和诊断；成功连上、停用或其他退出会清掉占锁状态。启动前先查活锁，避免旧进程排空期间反复校验凭据和联网。
- s18d JP-VPS 验证（2026-10-17，Codex）：根 build/typecheck/lint、daemon 5 文件 69 项、protocol 占锁快照及 UI 诊断通过；真实子进程覆盖孤儿正常退出、卡住排空、日志刷新卡住的后备退出及放锁。变异检查分别去掉慢重试、刷新后备退出、计时器 unref，三个行为断言均失败。不同模型独立审查及多角度增量审查通过；真实 Mac 行为留到里程碑，完整两平台检查以 PR 准确 head 为准。
- s18e 做法：bridge 创建编排器后注册同步崩溃钩子，直到关闭排空结束才注销。崩溃与正常关闭共用只写一次的排队快照；关闭以后才准备好的第一条群消息单独追加，拿到并发槽的那条已在快照里，不重复算；桌面协作入口不带群消息来源。暂停私聊在排上发送队列前写 `crash/unsent-notices.json`（0600，原子替换，最多 20 项），只有同一轮、仍暂停、24 小时内的项用原 uuid 重发。成功或所有候选发信 bot 都被拒绝才结案，暂时读不了配置或发信失败的保留；无法读取注册表时先保留 bot 项，恢复运行或新一轮启动时清掉旧项。文件读写失败只记日志，当前通知仍发。暂停标记已写、还没排通知的极短窗口无法恢复；飞书 uuid 去重只有 1 小时，超过后补发可能重复。
- s18e JP-VPS 验证（2026-10-17，Codex）：根 build/typecheck/lint、daemon 7 文件 200 项通过，包含真实崩溃子进程。`flock /tmp/vonvon-heavy.lock bash scripts/check-crash-recovery.sh` 在两个假 bot、隔离数据和假飞书接口下通过：整机暂停通知 503 后落盘；主进程被杀、再遇端口占用启动失败，文件仍在；同轮重启用同 uuid 补发并结案；关闭时两条 bot 通知未发成而保留，下一轮淘汰旧 uuid、只发新的。验收 daemon 前后仍运行，未操作其数据。独立审查发现启动时通知文件读失败会跳过新通知，回归用例在修前收到 0 条、修后收到 1 条，已修；额外多角度审查无新增发现。六处变异都被行为断言检出：不运行钩子、只在有上下文时运行钩子、拿到并发槽后重复追加、重放时换 uuid、不比 chainId、forget 不删持久化项。完整两平台检查以 PR 准确 head 为准，真实 Mac 的 M4 验收仍待完成。
- s18f 做法：桌面普通连接丢失时，原来只有看到服务操作助手的标记才会重新附着，launchd 自动重启没有标记。现在同一时间只进行一次被动重连，60 秒内每 250 毫秒重新认证本机当前端点；不启动 daemon。根目录或凭据无效立即失败，暂时的 owner/连接/身份变化允许重试；超时保留原断线提示。替换连接沿用已有快照与 revision 重置流程；候选连接在首个快照完成前又断开时保留原连接错误，不激活已断的候选。退出、更新或超时取消等待，关闭迟到连接。
- s18c 留下的：
  - 给 s18d：孤儿排空上限、退出 75 的重试间隔和占锁提示，以及孤儿排空时每秒一条的 owned-work 报错（M4 验收记录里"顺带看到的"第一条）。
  - s18e 补上了 bot 子进程自己出错崩溃时的排队消息、关闭时正在准备的那一条，以及关闭时没发出去的暂停私聊。
  - 记不下来的：product.md 3.10 写了前两项，bot 子进程被系统强制结束；macOS 上 daemon 主进程被强制结束（推断，M4 预览版的 Mac 检查确认）。第三项只记在这里：关闭开始前 SDK 已确认、还排在 SDK 群队列里的少数几条（同一个群前一个处理函数还没返回时才有）。
  - 撤回的消息回复接口回什么码没实测，M4 第 5 步看。
  - 接受的几处：桌面端协作发起的目标在等并发槽时关闭也记一项，回在 bot 自己的根消息下面；停机期间群被停用、解绑，照样回一句；停用再启用 bot 也回"刚才重启了"（沿用 s18a）；正在回的那一项和这次关闭丢掉的消息同群时，那一句若其实已发成，这个群会再收到一句、条数也多算（关闭正好落在回复的那一两秒、同群又有新排队时才有）。
- s19 做法（页面）：侧栏"状态与诊断"换成 `U/management/DiagnosticsPanel.tsx`，用现有的设置组件。"这台电脑"一节是 daemon 版本、Codex 和 Claude（和清单同一套 `toolSteps`）、数据目录、最近读取；"重新检查"重建快照、每个 bot 再读一次飞书设置，不起 CLI。每个 bot 一组：连接（和清单的"长连接"共用 `connectionStep`，另加没在运行、待生效、重连中）、飞书设置（还差哪几步，"打开清单"；清单里对可选事件的提醒也列在这里，比如没订阅撤回消息）、缺的权限、执行工具（按绑的群数）、最近没回的消息；最后是 daemon 日志。打开页面时每个 bot 读一次 `setupStatus`，不轮询。Bot 设置里的"飞书权限与连接 · 检查"改成"状态与诊断 · 查看"，只跳到这个 bot；`inspectAgent` 和 `snapshot.diagnostics` 删了。
- s19 做法（没回的消息）：只记对这个 bot 说的（@ 了它，或按群设置不 @ 也该它回）却没回的。门控有群停用（只记 @ 的）、群正在改设置、群不在"允许的飞书群"、发信人不在"响应成员"、群没绑定（回了提示也记）；回合开始了没答完的有没登录、Codex 版本太旧、工具没装、缺权限、用量、网络、超时、进程中途退出和其他错误。不记：规则模式下不是对它说的、重投、撤回（回合开始后才撤回的也不记）、私聊、云文档评论、`/goal`、按了停的，以及回了说明的 `/new` 之前发的消息和没压成的排队 `/compact`。原因和下一步写在 `P/diagnostics.ts` 的 `NOT_REPLIED_TEXT`。bot 子进程经 IPC（`fcb.diagnostics`，zod 校验）送到 daemon 主进程的内存，单个 bot 独立运行时直接进本进程；变了以后最多每秒重建一次快照。一条记录只有时间、群 id、主区或话题、名字缓存里已有的发信人名字、原因、后端、报错的第一行（120 字）和消息 id 末 6 位，没有正文（3.5）。
- s19 做法（缺的权限）：两个来源合在一行。飞书后台：`setupStatus` 缺的必需权限，加 3.11 表里影响对话的四项可选权限（新加的 `missingOptional`）。运行中被拒：补拉、查真名、认话题群、发卡片时被飞书拒绝，记权限名和在哪；后台显示已开却被拒的，提示发布一个新版本。飞书列的可用权限可能以别名打头（`im:message`），取后台检查读的那个；都不在检查范围里的只进没回的消息，不进这一行。读不到飞书设置时，这一行和"飞书设置"一样写"读取失败"。
- s19 做法（Codex 和 Claude）：清单和诊断页共用 `useClaudeLoginCheck`：Claude 装了、登录没查过时，每个窗口自动问一次，问完前写"检查中"，不再先显示"登录状态无法确认"，`vonvon bot status` 不变。快照每次重建都从缓存读 Claude 的登录，"检查登录"先重建快照再回复，不再多起一次 Codex。Claude 的回合因为没登录失败时，缓存换成"未登录"并写明原因，没有清空：清空后清单会再问，探测只看本机凭据，过期的登录照样报已登录；缓存带代数，之前开始的探测回来不覆盖它。错误类别加 `version`（"requires a newer version of Codex"），运行卡和诊断页提示更新 Codex，工具那一行和清单的判定不改。运行卡的登录提示按后端写，不知道后端时不写命令。
- s19 做法（日志）：`intake recv` 去掉正文前 40 个字，话题、群、消息 id 只写末 6 位。日志器把 trace 上下文的 `chatId`、`msgId`，和顶层整串就是飞书 id 的字段（`oc_`、`om_`、`omt_`、`ou_`、`on_` 开头，可带 `#admin` 这类后缀）都截到末 6 位，嵌套对象和报错文字不动；删了没人用的 `intake.enter`。别的日志查过，不带群里的话；出站图片的 `src` 和后端的 stderr 留着。
- s19 留下的：
  - 给 s18、s25 留了口子：记录表按 bot 存一个对象，IPC 事件带 `kind`，崩溃记录、"已暂停"和智能模式"不回"的原因加字段和原因代码就行；页面最上面是 s18 红条的位置。
  - "群正在改设置"没有单测：要走管理面改群设置才进 `projectMutations`。发信人只在名字缓存里有时才写，daemon 刚重启时多半没有。
  - 飞书里"在没绑定的群 @ bot，诊断页看到原因"留到 M4 验收第 3 步：要用验收 daemon 没在跑的测试 bot。
  - 顺带看到的：没绑定群的提示（`UNBOUND_GROUP_REPLY`）还写"在与我的私聊里完成绑定"，由 s51 一起改；`D/provider/policy/messages.zh.ts` 里 Claude 的登录命令写成 `claude login`，用不用得到还没查；`sessions.json` 的 `summary` 存了会话第一条消息的前 80 个字，作用相当于会话标题，留给碰会话列表的片（s48 或 s51）定。
  - 没回的消息按后端写 Codex 或 Claude，没有后端的按 Codex 写（`LaunchOpts.backendId` 不设就是 Codex）；今天只有这两个后端，V7 加 Cursor、Grok 这些时，`P/diagnostics.ts` 的 `tool` 和 `backendTool` 要跟着加。
  - 和 #338（s15）改到同一段：`handleMessage` 里先查撤回再记 `intake recv`；撤回的消息不进没回的消息。
  - bot 子进程关闭时丢掉的排队消息、`/new` 和 `/compact` 期间暂存的消息不告诉发信人，也不记（s15 之前排队的就这样），s17 做重启时一起看。（s17 看了：只在日志里记条数；告诉发信人放进 s18c，见"s17 留下的"；s18c 已做）补拉和查引用被拒会进缺的权限，查撤回的消息（`message.get`）被拒只记日志。
- s20c：互斥锁端口和 Linux 临时端口重叠的事（见 s07）又撞上一次：2026-10-15 #339 的冻结 CI 里 `service-cli.test.ts` 报"Another vonvon service install or uninstall is running"，重跑就过。四个角色（`admission`、`host`、`keystore`、`service`）都用这个端口；macOS 的临时端口从 49152 起，只重叠 848 个。原定在 s20a 换成 Unix 域套接字或文件锁，s20a 开工时看下来不算小而稳，移到 s20c：升级那一刻要有过渡（新锁之外仍去占旧端口；旧端口被占时连一下，连得上是旧版本在持锁，等它；连不上是别人的临时端口，不管），否则新旧版本会在同一个数据目录上各跑一个 daemon；Linux 和 macOS 要两种做法（Linux 用抽象命名空间的 Unix 域套接字，进程一死内核就收回；macOS 没有抽象命名空间，试 `open` 带 `O_EXLOCK | O_NONBLOCK`，要在 Mac 上实测，不行就退回端口、换到 20000 到 49151，同样带过渡）；范围是四个角色、五处调用方和桌面端的 `inspectHost`，`acquireMutex` 的返回类型换成自己的锁对象，碰到 #287 那块认人的代码；按本文的规则属于并发、关闭清理和合入门禁，要单独的多角度审查。不依赖 s20a，最好排在 s20b 前面，CI 少重跑几次。s20a 没加新的抢锁：Linux 安装后的那一步写成单独的函数直接测，不经过 `service` 锁。
- s20c 做法（锁）：`acquireMutex` 的参数和等待不变（每 40 毫秒试一次，`timeoutMs` 为 0 只试一次，到期报原来那句 busy 的 `DataAccessError`），返回自己的 `Mutex`，只能交给 `closeMutex` 放，放两次没事。键还是数据目录的真实路径加角色。Linux 用抽象命名空间的 Unix 域套接字 `@vonvon-bot-mutex-v3:<角色>:<真实路径的 sha256>`（`ss -lx` 看得到）；macOS 用 `open` 带 `O_EXLOCK | O_NONBLOCK | O_NOFOLLOW` 打开 `<数据目录>/.locks/<角色>.lock`，`O_EXLOCK` 写死 `0x20`（`fs.constants` 里没有），锁文件不删，`.locks` 不是真目录就报错。两种都是进程一死内核就收回，子进程不继承（libuv 打开时都带 close-on-exec）。别的平台照旧（Windows 命名管道、其余端口），v1 不支持，没动。平台用 `os.platform()` 判断：`provider-lock-retention` 在 Linux 上把全局 `process` 换成 darwin 和 win32，`os.platform()` 读 Node 自己的 process，不受影响，这个测试没改。
- s20c 做法（过渡）：旧版本只认端口，所以 Linux 和 macOS 上拿到新锁以后，还去占这个角色原来的端口（`20000 + sha256("vonvon-bot-v2:<角色>:<真实路径>")` 前四字节 `% 30000`，算法不变）。占上了就一起持有、一起放，这个端口对每个连接回一行 `vonvon-mutex-v3`，写完就关掉连接，不等对方关（对方一直不关时，放锁会卡在关这个端口上，新锁也放不掉）。占不上就连一下：连接被拒（ECONNREFUSED），是某个连接的本地端口或 TIME_WAIT（#339 撞上的就是这种），不管它；连接时报别的错（比如 fd 或临时端口用光），看不出是不是旧版本，当作旧版本持锁；收到那一行，是新版本在持另一个目录的锁、撞了同一个端口，也不管；连上后一句不说就断开，或者 1 秒内既不说也不断（事件循环卡住的旧 daemon 也能完成握手），当作旧版本持锁：留着新锁、每 40 毫秒再试，到期连新锁一起放掉、报 busy。所以 M3 预览版的 daemon 在跑时，新版本的 `daemon run` 拿不到 host 锁，走不到 #287 那块接管 `daemon.pid` 的代码。过渡只在 `D/config/data-access.ts` 里标了起止的一段。过渡已在 s20e 删除（2026-10-18），见"s20e 做法"。
- s20c 测试：新的 `coordination-mutex.test.ts`，子进程用 esbuild 打包的真实 `data-access.ts` 持锁：四个角色各测一次，持锁时本进程拿不到，子进程被 `SIGKILL` 后不等待就拿到；同一进程第二次拿是 busy，放两次没事；指向同一目录的符号链接算同一把锁，换角色、换目录互不影响；持锁进程起的孙进程还活着时，持锁进程一死锁就放了。过渡在真实的旧端口上测（这些测试 s20e 已和过渡一起删掉）：旧版本那样监听（马上断开、接了不说话）时 busy，到期新锁也放了；旧端口只是一个出站连接的本地端口时拿得到（Linux 上先确认这个端口确实绑不上）；另一个目录的新版本占着同一个旧端口时拿得到；持锁时旧版本那样监听报 EADDRINUSE，放锁后能监听；有连接连着旧端口不关时，放锁不等它。连旧端口被拒和报别的错，用 mock 的 `connect` 在两个平台上都测（macOS 上前一个测试会因为端口绑得上走不到被拒这一步）；测旧端口的用例先确认旧端口确实是自己占的，别的套接字占着就换一个目录。`service-prelock` 的旁观进程改成持真实的 host 锁，不再自己算端口。macOS 的文件锁由 macOS CI 在 Mac mini 上跑同一批测试来验（#343 的冻结 CI 通过）；#322 任务 12（2026-10-16）另在 Mac 上用系统 Node 24.14 和 Electron 44.4 的 Node 24.21 各试一次：别的进程打开报 EAGAIN，同一进程第二次打开也是 EAGAIN，持锁进程被 SIGKILL 后马上拿得到，派生的子进程带不走锁；macOS 上数据目录多了 `.locks`，`data-access` 和 `daemon-cli` 两个列目录的断言滤掉了它。
- s20c 留下的：
  - 删掉过渡：过渡已在 s20e 删除（2026-10-18）。原定等 owner 的 M3 预览版和 JP-VPS 的验收 daemon 都换成 s20c 以后的版本再删；JP-VPS 已满足，owner Mac 上的默认 daemon 还没确认就先删了，因为过渡已经在 macOS CI 上让锁误报 busy（见"s20e 做法"）。owner Mac 那边改成装下一个预览版之前先确认（本文第 7 节"Mac 上怎么打包"第 3 条）。过渡期间旧端口被别的连接占着、旧端口那一步最多等 1 秒这两条随过渡一起没了。
  - 抽象命名空间的套接字没有权限位，同一台机器上的别的用户能先占名字让锁一直 busy，和端口锁一样，没加防护。
  - Linux 的锁按网络命名空间区分，和原来 `127.0.0.1` 的端口一样：`bwrap --unshare-net` 沙箱里的 CLI 或带 `PrivateNetwork` 的 unit 和外面的 daemon 用同一个数据目录时，两边都拿得到锁。不要这样用。
  - macOS 的锁文件在数据目录里。持锁时数据目录或 `.locks` 被删掉重建，持锁进程锁着的是已删的文件，新进程能在新文件上拿到锁。现在没有流程会在 daemon 活着时删数据目录。
  - 调用方一共六处：`enterDataAccess`、`inspectHost`、`migrateHostDataOffline`、host（`D/host/bootstrap.ts`）、keystore、service，都只改了类型。`inspectHost` 和 `migrateHostDataOffline` 以用户 HOME 为键、只有测试在用，桌面端没用 `inspectHost`；macOS 上它们的锁文件在 `<HOME>/.locks/`。
  - `scripts/import-core.mjs` 有自己的端口锁（`20000 + h % 40000`），同样和 Linux 临时端口重叠，它重试 10 秒，这片没改。
- s20e：s20c 的过渡把旧端口上连上后 1 秒不说话、或者一句不说就关掉的监听者都当成旧版本持锁。HTTP、WebSocket 这类等客户端先开口的服务，碰巧占着这个数据目录、这个角色算出来的旧端口时，锁就一直 busy：`timeoutMs` 为 0 约 1 秒报 busy，1500 约 2 秒。旧端口在 20000 到 49999，一台机器上这段里有 k 个无关的监听，每次拿锁就有 k/30000 的机会撞上；一轮测试拿几百次锁。2026-10-18 在 JP-VPS 上用真实的 `acquireMutex`（esbuild 打包，Node 24.21）复现：`net.createServer(() => {})` 或 `http.createServer` 占着旧端口时，`service` 锁 1500 毫秒的 2051、2052 毫秒后报 busy，`host` 锁 0 毫秒的 1012 毫秒后报 busy；旧端口空着、或者占着的回 `vonvon-mutex-v3` 时 9 到 12 毫秒拿到；豁免的 `projects` 1 毫秒拿到。
- s20e 归因：
  - #382 冻结 CI（macOS）的 `service-cli.test.ts`"starts nothing when no daemon ran before"用了 1009 毫秒报"Another vonvon service install or uninstall is running"。那里是 `acquireMutex(root, 'service', 0)`，只试一次；原生锁冲突几毫秒就拒绝（Mac 任务 32 实测 0.49 到 2.5 毫秒），只有过渡的 1 秒等待会拖到 1 秒。数据目录是测试刚建的，没人持真锁：是过渡撞上了 Mac mini 上无关的监听者。
  - #385 冻结 CI（macOS）的"Bridge admission is busy"（`daemon run` 的 admission 锁，`timeoutMs` 1500，2263 毫秒）：同一个原因。
  - #382 的 `environment-rpc.test.ts:97`（2 秒内等不到登录网址）不调 `acquireMutex`，不是过渡，是另一个负载相关的偶发失败（Mac 任务 31 的假登录探针看到的是子进程第一行输出慢于 2 秒）。
  - Mac 任务 31 复现过一次 46 毫秒的快速拒绝（`service-cli.test.ts:205`）。可能是撞上 owner Mac 上 s20c 之前的 daemon 的旧端口锁（连上就关），没有端口证据。Mac mini 的 CI runner 和 owner 的 daemon 在同一台机器上。
- s20e 做法：`D/config/data-access.ts` 里标了起止的过渡整段删掉，拿到新锁就返回；#382、#385 给 `projects`、`creation` 加的豁免也去掉了（它们只是过渡的例外）。Linux 的抽象套接字、macOS 的文件锁不变；Windows 的命名管道和其余平台的端口照旧（`portOf` 还给后者算端口）。不收窄成"只把连上就关当旧版本、1 秒不说话当不是锁"：事件循环卡住 1 秒以上的旧 daemon 会被当成不是锁，新进程拿到 host 锁后接管活着的 `daemon.pid`（#287 那块），同一个目录跑两个 daemon；连上就关的误报也还在。
- s20e 测试：`coordination-mutex.test.ts` 删了过渡的测试和只给它们用的夹具（mock 的 `connect`、按旧版本那样监听、`holdWithOldPort`，以及 #382、#385 加的豁免用例和"先备好空闲旧端口"用例）。`daemon-cli.test.ts` 的 service 托管用例换回普通的 `fixture()`，不再先在 admission 旧端口挂一个回 `vonvon-mutex-v3` 的监听器（#385 加的），#385 顺手加的 `.access` 为空的断言留着。新加：七个角色各测两种无关监听者（从不说话、连上就关）占着旧端口时，`timeoutMs` 为 0 一次就拿到，用时不到 900 毫秒；"持锁时别的进程拿不到"也扩到七个角色。变异检查：在副本里把过渡放回去，五个过渡角色的十条都红（不说话的约 1 秒后 busy，连上就关的 3 毫秒 busy）；只把"1 秒不说话"改判成"不是锁"，不说话的五条因为用时超过 900 毫秒变红。"s20e 留下的"说正常入口会复用 s20c 之前的 daemon，靠的是这几处测试：`service-startup-routing.test.ts`（有验证过的 owner 时不起服务、不 spawn；注册了服务时不 spawn）、`daemon-manager.test.ts`（桌面端连已验证的 daemon）、`service-transaction.test.ts`（launchd 的 `kickstart` 不带 `-k`）、`service-prelock.test.ts`（注册了服务时不带 `VONVON_SERVICE` 的 `daemon run` 在拿锁前被拒）。审查后在 `service-transaction.test.ts` 新加一条：launchd 的 start 遇到活着、认证过的 owner 直接用它，不 `bootstrap`、不 `kickstart`。在副本里把这六处各改坏一次（跳过 `daemon start` 的 owner 检查、注册了服务也 spawn、桌面端跳过 `readVerifiedDaemon`、`kickstart` 加 `-k`、去掉 `daemon run` 的拒绝、launchd 的 start 跳过 owner 检查），各自都有测试红；最后一处原来没有测试拦，是新加的那条红。
- s20e 留下的：
  - owner Mac 上的默认 daemon 可能还是 M3 预览版（main `a255ce17`，不含 s20c）2026-10-16 起的那个进程：#322 任务 21、24 装新 app 时都没重启默认服务，任务 24 写明默认 daemon 和 bot 保持原 PID。s20c 之前的版本只认端口锁，s20e 起只用新锁，新旧两边看不见对方的锁。正常入口照旧认得出旧 daemon、复用它，光装新版本不会多出一个 daemon：`daemon start` 先向 `daemon.pid` 里的 daemon 握手（`verifyPidLockOwner`），验证过就直接用它；注册了服务时，只在没有 owner 或 owner 验证不过时让 launchd `kickstart`（不带 `-k`），同一个 label 不会起第二个；桌面端先 `readVerifiedDaemon`，验证过就连上，协议不对只报错、不替换；注册了服务的目录上不带 `VONVON_SERVICE` 的 `daemon run` 在拿锁之前就被拒（`D/host/bootstrap.ts`）。挡不住的是这几种：手动带 `VONVON_SERVICE` 跑 `daemon run`；服务卸掉以后直接 `daemon run`；没注册服务（或服务属于别的数据目录）时旧 daemon 的 owner 验证失败（`PidLockError`），`daemon start` 去 spawn 子进程。这三种都由 host 锁决定，新进程拿得到新锁，会接管活着的 `daemon.pid`，同一个目录跑两个 daemon。另外 keystore 的写锁两边也互不排斥：新版命令行的 `vonvon secrets set`、`vonvon secrets remove` 和旧 daemon 注册 bot、刷新凭据、删 bot 时写 keystore 可以同时进行，可能丢更新；`admission`、`service` 两个锁也一样互不排斥。本文第 7 节"Mac 上怎么打包"第 3 条装之前先重启到 s20c 以后的版本，这几种情况就都没了；确认（需要时重启）之前，不对 owner 默认的数据目录跑 `daemon run`、`secrets set`、`secrets remove`。这些正常入口的测试见"s20e 测试"。
  - 之后不在 owner 的 Mac 上再起 s20c 之前的构建（比如从 M3 以前的 sha 构建）。
  - JP-VPS：2026-10-18 确认没有 vonvon 进程在跑，`ss -lx` 里没有 `vonvon-bot-mutex-v3`，验收用的数据目录里没有 `daemon.pid`，验收 worktree 在 `191980f`（含 s20c）。
- s20a：清单里那一步写明"Linux 上 Codex 只能用完全访问"，由主人自己选要不要把 bot 默认档改成完全访问，不自动放开（本文第 5 节）。
- s20a：Linux 的首次运行清单还要查 Claude 只读、读写档要的沙箱：有没有 `bwrap` 和 `socat`，以及 Ubuntu 23.10 以后 AppArmor 是否挡住了非特权的用户命名空间（`kernel.apparmor_restrict_unprivileged_userns`）。缺了就写明 Claude 只能用完全访问或要先装、先放开，给出命令，不自动改系统设置。2026-10-15 JP-VPS 上实际遇到，见本文第 7 节。
- s20a 做法（平台）：快照的平台是 `macos | linux | unsupported`，去掉了 windows，不升协议版本（网页由 daemon 发，桌面端带着自己的 daemon，命令行和 daemon 是同一个包）。"应用与启动"页写"这台 Mac""这台 Linux 主机"或"这台电脑"；清单的后台服务一步在 Linux 上照旧写 systemd 的那套，别的平台写"不支持"。CSS 里 `data-desktop-platform="windows"` 的几条规则一起删了。
- s20a 做法（open --print）：`vonvon open --print` 打印地址、一条 `ssh -N -L 端口:127.0.0.1:端口 用户@地址`（有 `SSH_CONNECTION` 时用服务端地址，端口不是 22 时带 `-p`；没有时写占位和主机名），和凭据泄露后怎么换。带凭据的链接只在 stdout 是终端时打印，管道、重定向和服务管理器里只打不带凭据的地址和一行说明。Linux 上没有 `DISPLAY` 和 `WAYLAND_DISPLAY` 时，`vonvon open` 也直接打印；`open`、`xdg-open` 失败时只报退出码，不再带上命令行（里面有凭据）；`cmd /c start` 删了。打印的内容由纯函数 `openGuide` 拼，Linux 上 `service install` 的最后一段也用它。网页没拿到凭据时的提示加了 `vonvon open --print`。
- s20a 做法（linger）：Linux 上 `service install` 成功（含已经装过）以后读 linger：`loginctl show-user`，失败时看 `/var/lib/systemd/linger/<用户名>`。没开就在终端里问一句，回车或 y 同意，用 `loginctl --no-ask-password enable-linger` 开，再读一次确认；`--linger` 不问就开，`--no-linger` 不开，不是终端时不开、只打命令；开不成给出 sudo 的命令，只有明确带了 `--linger` 时退出 1（服务已经装好）。最后打印打开网页的办法。卸载不关 linger，开着时提示 `loginctl disable-linger`。`service status`（含 `--json`）和快照都带 linger：服务在运行、linger 没开时，清单这一步照旧算完成，下面多一条提醒。新加的提示是中文；s07 安装事务的英文结果行没动。
- s20a 做法（没有用户 systemd）：`D/service/linux-session.ts` 的 `userManagerHint` 认三种：机器不是用 systemd 启动的（容器）、终端没有 `XDG_RUNTIME_DIR`（`sudo -u`、`su` 切过来的）、这个账号的 systemd 用户实例没在运行。`service status` 在英文的 `Cannot ask systemd (Linux)` 下面打这句，install 报 `User manager unavailable` 时附在报错末尾，清单"无法确认"那一步用它作说明。只给说明，不替用户设环境变量、不自动开 linger 再重试。`systemctl show` 报错末尾的换行去掉了，状态里不再多一个空行。
- s20a 做法（bot add）：`vonvon bot add` 走网页同一条 `registerAgent` RPC，一条连接里只看这个任务：二维码用已经锁定的 `qrcode`（和网页生成的是同一个码）画在终端里，链接换了（切到国际版）就重画；成功后打 bot 的名字和飞书那几步，清单读不到也退出 0，bot 已经存好了。stdout 不是终端就拒绝，免得二维码进日志；daemon 没在跑时提示 `vonvon daemon start`，不自动起。Ctrl-C 发 `cancelJob`（最多等 5 秒），退出 130；第二次 Ctrl-C、断线或被 kill 时，daemon 的 `detach` 会取消这个连接发起的注册。`Call` 加了可选的 `ms`，等扫码的那一次给 15 分钟。"还没有 bot"的提示加了 `vonvon bot add`。
- s20a 做法（Linux 的两步）：清单"执行工具"下面加"Linux 上的权限档"一组，只在 Linux 上、对应的工具不是"未安装"时显示，不算进"还差几步"，也不影响"可以用了"；`vonvon bot status` 在 Linux 上也列。Codex 一步只说明 Linux 上只能用完全访问、怎么改，不改任何默认档。Claude 一步由 `D/agent/claude-agent/sandbox-probe.ts` 查：在 daemon 的 PATH 上找 `bwrap` 和 `socat`，有 bwrap 就试跑一次 `bwrap --ro-bind / / --dev /dev --unshare-all --die-with-parent true`（不经 shell，5 秒超时杀掉），失败时读 `/proc` 分出被 AppArmor 挡住、用户命名空间被关掉和别的失败，各给命令（AppArmor 那份配置用查到的 bwrap 路径）。跟执行工具每 60 秒查一次。命令只显示，daemon 和命令行都不执行；`SetupStep` 加了 `commands`，网页用等宽块显示，命令行不缩进、前后各空一行打出，整段能直接贴进终端（缩进了的 `EOF` 结束不了 AppArmor 那段 heredoc）。
- s20a 和设计不一样的：缺 bwrap、socat 时说明里写"装好后一分钟内这里会更新"，没写"点「重新检测」"：执行工具那组没有重新检测的按钮，后台服务那一步的"重新检测"只重读服务。
- s20a 留下的：
  - 给 s36：bot 默认档（私聊用）有了以后，清单里 Codex 那一步加上它。
  - `qrcode-terminal` 还给 `daemon run` 前台、没有 bot 时的老向导用，那个向导删掉时一起删这个依赖。
  - 真的开 linger、真的扫码建 bot，JP-VPS 上都没走到：operator 已经是 `Linger=yes`，扫码没有人扫。前者靠单测；后者和网页同一条 RPC，网页这条 M1 已经验过，记成待 owner 验收（可选），M4 验收第 4 步有 Linux 机器的话可以试一次。
  - `service` 命令里 s07 的英文行没改，s20a 新加的是中文，`classifyServiceFailure` 和测试都钉着那些英文行。
  - 顺带看到的：s17b 要给 `service status` 加 launchd 的 `last exit code`，和这片改的 `runServiceStatus`、`adapter.status()` 是同一段，谁后合谁 merge main；诊断页"这台电脑"一节没跟着改名（搜索索引用它做锚点），要不要在那里也显示 Claude 的沙箱，留给 UX 那一轮。
- s20b：被拉进的已有群默认只读，在 Linux 上用 Codex 时起不来：bot 回一句说明，等主人改（product.md 第 11 节第 24 条）。开工时核对过，绑定从来不抛错（`assertBackendUsable` 只按 `supportedModes` 过滤，Codex 没声明），原来写的"绑定之前就抛错"不对：错是在回合开始时由 `sandboxParams` 抛的，群里看到的是一段提到 Windows 的"❌ 启动失败"，诊断页记成"出错了"。所以绑定照旧，改的是回合开始时的回复、设置和删 windows-job。`windows-job.ts` 被 `owned-process.ts` 和 `environment/service.ts` 引用，属于子进程的代码。
- s20b 的 Linux 验收：Claude 在 JP-VPS 上的普通用户账号里，用这片 PR 的 head 走一遍 npm pack、装到临时前缀、`service install`、kill -9 后被拉起、`daemon stop` 后不再拉起、`service uninstall`。不重启 JP-VPS，linger 看 loginctl 的状态。结果写进本文第 10 节。
- s20b 做法（回合开始时）：Linux 上用 Codex 的群，发消息的人对应的档（分档时按发消息的人取）是只读或读写时不起会话：不加表情、不下载图片、不织入上下文、不补拉，直接在原处回一句说明，话题里的回在话题里。说明写明是哪一档、要改「管理员权限」还是「普通成员权限」，和 `vonvon settings set --group <群 id> permission.mode=full`（普通成员是 `permission.guestMode`；这台主机有几个 bot 时带 `--bot`）（s15c 已改：只剩「权限档」和 `permission.mode`）。被 @ 每次都回；免@ 触发的，每个群 10 分钟最多回一次，从这个群上一次说明算起，被 @ 时回的也算，没发出去的不算。每条都记进诊断页"最近没回的消息"，原因是新加的 `tier-unavailable`。判断放在后端实例上（`AgentBackend.fullAccessOnly`，Codex 在 macOS 以外返回理由），不直接读 `process.platform`，用假后端的测试在 Linux CI 上不受影响。挡在四处：单会话群的主区和话题里（都在命令之后、`/goal` 之前），多会话群主区的 `/goal` 和开新话题。重试、继续、`/new`、`/compact` 和协作的几个动作不经过这道门，走到 `sandboxParams` 时抛 `CodexFullOnlyError`，回"❌ Linux 上的 Codex 只能用完全访问……"，诊断页同样记 `tier-unavailable`。
- s20b 做法（设置）：网页群内设置的两个权限下拉里，只读问答、允许写入置灰，已存的只读照样显示为选中，理由写在「管理员权限」下面。daemon 保存时（网页和 `vonvon settings set` 是同一条路）只看这次改的字段：`mode` 或 `guestMode` 改成完全访问以外的就拒，理由同上；不改档、只改联网照常保存，已存的只读不动。`vonvon settings get --group <群>` 在 `[permission]` 下多打一行理由。私聊 🔐 权限卡的两个下拉只剩完全访问，写明现在的档和理由，存的不是完全访问的那个不预选、写"不选就不改"，只改联网时存的档不动；升级前发出的旧卡提交只读、读写时不保存，再发一张新的权限卡。`vonvon group bind` 的提示不变。
- s20b 做法（windows-job）：删了 `codex-appserver/windows-job.ts` 和它的两份测试，`owned-process.ts`、`environment/service.ts` 只剩 POSIX 进程组这条路，信号、步骤顺序和超时都没变；`environment/service.ts` 里每个子进程只记一个"管道关了"的 promise。`sandboxParams` 的 win32 分支去掉，macOS 以外一律抛 `CodexFullOnlyError`。`codex-process-tree.test.ts` 里"自然退出 7、254 时 close 报错"那条原来放在 Windows 那组，测的不是 Windows 的事，挪进 POSIX 组。`provider/process/windows-*` 按第 6 节第三类留着；`import-core.json` 里的 `windows-job.ts` 是导入时的记录，不改。
- s20b 留下的：
  - 给 s36、s49：私聊的 bot 默认档是读写（第 5 节），Linux 上用 Codex 时私聊也要同样的检查。
  - 给 s36b：被拉进群时设置卡上照旧默认只读，靠回合开始时的这道检查回说明，不自动放开。
  - owner 2026-10-16 定了在 s15c 去掉"普通成员权限"（#344）。这片没动分档：回复里分得出 `guestMode`，网页两个下拉都置灰，诊断页的"下一步"两个字段都写（记录里没有发消息的人是什么角色）。s15c 删分档时这几处一起改（s15c 已改：只剩「权限档」和 `permission.mode`）。

### M5 智能模式

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s14d | "同时发送到群"只回一次 | 话题里勾"同时发送到群"或私聊话题里勾"同时发送到会话"时，飞书推的主区副本跳过，只回话题里那条；先记一次原始事件，看带不带 `sync_to_chat_info`（3.5） | 120 | — | 错误路径 | 无（M5 验收第 8 步由 Codex 在 owner 的客户端里发） |
| [x] | s15d | `/resume` 恢复卡的历史显示 | 恢复卡（`D/card/history-card.ts`）的历史里，bot 那一行和"更早的 N 轮 … 仍保留"按群的后端写名字，不再在 Claude 群里写 Codex：`HistoryCardState` 加后端名，取目录（`BACKEND_CATALOG`）里的展示名 Codex、Claude，不用后端自己的 displayName（Codex 的是"Codex (app-server)"），`handle-message.ts` 里 4 处 `buildHistoryCard` 都传；私聊的项目设置卡也改用这个名字。用户那一行、折叠标题和"上次停在"（`turnBody`、`turnTitle`）去掉 `weaveSender` 加的发信人标注"[本条消息的发信人：…（open_id：…）…]"，连同记录块、引用和附件清单，复用 `session-title.ts` 的 `stripBridgeMessageEnvelope`，不另写；去掉后是空的那一行不显示，折叠标题写"👤 （没有文字）"。`stripBridgeMessageEnvelope` 也认 `retryPrompt` 加在开头的"（重试）上一轮因为…"，重试过的那一轮同样只剩人写的字；发信人标注只去到它自己结尾的"）]"，压成一行的提示里正文后面的"）]"不再被一起删掉（压成一行的记录块仍去不掉，是已知限制）。会话没有原生标题时，`/resume` 选择卡的条目标题、恢复后记下的会话摘要（私聊话题列表显示它）和话题标题，以及网页端"可恢复"列表（daemon 的 `history` 接口给的 `name`、`preview`）取的是织好的第一条提示，也一起去掉；这几处和恢复卡标题行里的原生标题也过一遍，和网页列表一致（M3 第 4 步看到的） | 336 | — | 无 | 无（JP-VPS 用 lark-cli 读恢复卡） |
| [x] | s15e | 恢复的 Claude 会话的标题 | `readHistory` 返回原生 `customTitle` 和首条用户消息的 `preview`；选择卡、恢复卡、网页恢复都沿用 `resumedTitle` 去信封后保存摘要。预览在历史裁成最近几轮之前取得；读取标题失败只缺 `name`，历史和预览仍返回，不启动推理（3.5） | 80 | s15d | 无 | 无（JP-VPS 在网页上恢复一条 Claude 会话，看"当前会话"） |
| [x] | s15c | 去掉访客档 | 一个群一档、一条会话：`turnTier` 不再分档，会话键不再带访客的后缀，设置页、私聊的权限卡和命令行去掉"普通成员权限"；已存的 `guestMode` 读时取两档里更严的，下次写时去掉；领文件按群现在的档，和文件写出时的档比的那一步留着（3.5、3.8） | 250 | — | 数据迁移、并发 | 无 |
| [x] | s15b | 每轮开口前看一眼会话 | 主区和话题每轮开口前看原生会话：别人写过（终端里的轮次、压缩）就重新接上，有新的压缩就附话题表；Codex 每轮结束放开线程（3.5，D4、D6） | 200 | s15c | 并发、关闭清理 | 无（M5 验收第 9 步在 JP-VPS 上用终端做；Codex 桌面端打开同一条会话放进 M5 预览版任务） |
| [x] | s21 | 群的会话方式和运行中来了消息 | 群加会话方式（多会话、单会话、智能，前两种即规则模式的"开话题""连续"）和"运行中来了消息"覆盖，缺省按规则读；绑定的三个入口（私聊绑定卡、网页的绑定对话框 `JoinGroupDialog`、`group bind`）改成按 3.4 的顺序和文案列，不预选（网页对话框和 `group bind` 今天默认 `threads`，要去掉），命令行必须带；话题群的问法、卡发给谁和没设置好时怎么回留给 s36b；在多会话和单会话之间切换时免 @ 不变（3.2、3.4） | 450 | — | 数据迁移 | 无 |
| [x] | s22 | 三条底线：点名、接着聊、bot 消息 | 入站先判断对谁说；话题里的引用按 `parent_id` 不等于 `root_id` 认（e10）；规则模式"仅 @"下引用我的消息不算点名（3.4 第 1 条的例外）；多 bot 群主区命令要 @；从群信息读 chat_mode 认出话题群，加一个单测（3.4"三条底线"） | 550 | s21、s15、e10 | 错误路径 | 无 |
| [x] | s23a | 判断层 | `D/judge/`：一个入口 `judge()`，永不抛错；三种变体（主区没点名、主区被 @、话题里）；提示词是 `SMART.md`（内置默认，bot 层、群层整段覆盖）加只读的格式行；出错按变体兜底，主区被 @ 的回在主区，其余不回，调用方放弃和关机一律不回；每个后端限流排队，名额等后端调用落定才还；只用默认小模型；后端契约 `AgentBackend.judge`、`peekModels`（3.2、3.4） | 1250 | — | 并发、关闭清理、错误路径 | #363；无（没有用户可见变化：s25 的智能入站和 e12 都要先有它） |
| [x] | s23b | Codex 判断进程 | 每个 bot 进程一个专用的常驻判断进程（`codex app-server`），第一次判断才起，空闲 10 分钟关；每次判断一个 ephemeral 线程，超时只 interrupt 加 unsubscribe，RPC 15 秒不回包才杀进程；退避、换版本；最低版本抬到 0.156.1 | 1320 | s23a | 子进程、并发、关闭清理、错误路径 | #364；不开 Mac 任务，在 JP-VPS 上做：真实 Codex 用 gpt-6-luna 跑判断，结果格式对，超时按不回；合入后接着做 e12 的 Codex 一半 |
| [ ] | s23c | Claude 判断、模型解析和冷却 | Claude 单轮、不带工具，默认 `haiku`、请求时关思考（haiku 仍会少量思考），网关用网关模型；内部解析 bot 默认和群覆盖；结构化错误冷却 5 分钟；正常情况下进程组退出后才释放判断槽，放弃 15 秒后仍确认不了退出的，记 slow-settle 并先放回槽，进程由登记继续清理 | 1450 | s23a | 子进程、并发、关闭清理、错误路径 | #366；不开 Mac 任务，在 JP-VPS 上做：真实 SDK 加 fake CLI 验证退出；真实 Claude haiku 判断 5 次格式对、CLI 进程组都退出（2026-10-18，见"s23c 收尾实测"）；合入后接着做 e12 的 Claude 一半 |
| [ ] | s23d | 判断模型的设置、RPC 和命令行 | 在 bot 和群设置中读写同后端判断模型或手填 id、推理强度，留出大模型和决策模型两类；RPC 提供设置和模型列表；`settings get judge` 显示提示词全文、格式行和输入示例（3.2、3.4） | 600 | s23c | 错误路径 | 设置/RPC/CLI 的定向测试；不调用真实模型 |
| [ ] | s25 | 智能模式的入站：判断回不回、回在哪里 | 主区底线定不下来时调一次判断；话题里只判断回不回；每群每小时上限 60 次；选了智能的群说一句；绑定卡、页面和命令行放出"智能"这一项；"不回"的原因进诊断页；话题里只有一个真人在和我聊时不调判断、直接回（3.4"控制成本"） | 800 | s21、s22、s23a、s23b、s23c、s14b、s19、e12 | 并发、错误路径 | 无（M5 验收前，预览版任务按 3.4 例子第 3、4 行跑一遍） |
| [ ] | s26 | 本机几个 bot 合成一次判断，只放行一个 | supervisor 里加协调器，按 message_id 收齐本机各 bot 的报名，智能 bot 合成一次判断，"全部回复"的也只放行一个；界面提示不同电脑上的 bot 可能抢着回（3.4） | 680 | s25 | 并发、子进程、关闭清理、错误路径 | 无 |
| [ ] | s27 | bot 之间互相 @ | 智能模式下收别的 bot @ 我的消息，只看对方最终回答；没有真人插话时最多来回 3 轮（3.4"bot 之间"） | 420 | s22、s25、e10 | 错误路径、并发 | 无 |
| [ ] | s28 | 群详情页的会话方式和用量页的判断次数 | 群详情页加会话方式（按 3.4 的顺序和文案）、免 @、运行中来了消息，没设的显示"继承 bot 默认"；用量页按天显示判断次数（3.1 第 7、8 条） | 480 | s21、s25 | — | 无（JP-VPS 上无头检查） |

开工要点：
- s14d、s15c、s15b 是 owner 2026-10-16 定的（product.md 第 11 节"M3 验收期间"），排在 M4 之后、s21 之前。s15b 依赖 s15c：一个位置只剩一条会话，看一眼会话时不用分档。
- s14d：e10 第 5 项 2026-10-16 测了（#322 任务 10，Codex 在 owner 的客户端里发，JP-VPS 的验收 bot 收）。勾了"同时发送到群"，飞书推两个事件、两条消息，发送时间相同：
  - 话题里一条：带 `thread_id`、`root_id`，`sync_to_chat_info` 的 `type` 是 2，`related_message_id` 指向主区那条；
  - 主区一条副本：不带 `thread_id`、`root_id`，`sync_to_chat_info` 的 `type` 是 1，带原话题的 `thread_id` 和话题里那条的 id。
  - 验收 bot 两条都处理了：话题里那条照常回了；主区副本在按话题的群里被当成新的 @，去开新话题，飞书回 500（code 2200），失败说明也没发出去，诊断页会记一条没回。
  - 私聊话题里勾"同时发送到会话"一样推两条，两条都回了菜单。
  - 单条查询消息的接口返回里有 `sync_to_chat_info`；飞书 SDK 的类型里没有这个字段，事件里带不带没确认。开工时先记一次原始事件的字段名；不带的话，主区消息被 @ 时查一次这条消息。
- s14d 做法（认副本）：`D/bot/sync-copy.ts`。`handle-message.ts` 在内存去重、撤回检查和 `recv` 日志之后，私聊菜单、未绑定的提示、"没回"的记录、话题登记表、水位和开话题之前，先认主区副本，`sync_to_chat_info.type` 是 1 就丢掉；话题里那条（type 2）照常回。群和私聊一样。SDK 把长连接事件原样交下来：WS 帧 `JSON.parse` 以后，`EventDispatcher` 把 header 和 event 摊平成一个对象交给 `im.message.receive_v1`，`normalize` 带 `includeRaw` 时 `raw` 就是这个对象，`message` 没动过（`@larksuiteoapi/node-sdk` 1.71.1 的 `lib/index.js`：`DataCache.mergeData`、`RequestHandle.parse`、`normalize`）。bridge 一直开着 `includeRawEvent`，所以事件里有这个字段就能从 `msg.raw.message.sync_to_chat_info` 读到，SDK 的类型里没有也不影响。测试用 SDK 自己的 `EventDispatcher` 和 `normalize` 走一遍，字段原样留在 `raw` 里。
- s14d 做法（事件里没有字段时）：主区里 bot 会接的消息（@ 了、免@、恢复会话期间会回提示的，私聊主界面的每一条）查一次 `message.get`，1.5 秒超时；查失败、被拒或超时都当普通消息照常回，一连串失败只记一次 `intake.sync-lookup-failed`，中间查成功过一次，再失败时再记。话题里的消息不查。这次运行里，这个 bot 只要收到过一个带这个字段的主区事件，就不再查：主区副本的事件带字段，没带就不是副本。话题里那条的事件带字段不算，飞书可能只在话题那一侧带。查询占着这个群的入站队列，所以超时取得短。
- s14d 做法（上下文）：主区副本不进任何会话，也不记水位，但飞书主区的历史里有它，所以主区下一次开口的记录块、以后新话题开场带的主区消息里，照常有这一行，和话题里那条是同一段话。主区的人看得到它，主区会话也该知道有人问过；话题里已经回过，主区那边不另加说明。
- s14d 做法（日志）：每个 bot 收到第一条消息时记一行 `intake.receive-fields`：`syncToChatInfo` 是 true 还是 false，加上事件里 `message` 的字段名，不带内容和 id；第一行是 false 的，第一次带上字段时再记一行 true。丢掉副本时记 `intake.sync-copy-skipped`，`via` 是 `event` 或 `lookup`；第一次查询记 `intake.sync-lookup`。
- s14d 留给 M5 验收第 8 步的：看 bot 只在话题里回一次，主区没有新开的话题，诊断页没有新的"没回"；私聊话题里勾"同时发送到会话"，只回一次菜单。再看 daemon 日志里那一次的 `sync-copy-skipped` 是 `via: event` 还是 `lookup`，`receive-fields` 里有没有 `syncToChatInfo: true`。是 `event`，就在 e10 第 5 项补上"事件里带"；是 `lookup`，查询就一直留着。
- s15c：bridge 迁来的群设了不同的访客档时取更严的那一档，迁移结果里列出来（product.md 第 5 节），迁移那片照这个做。已有的访客会话（会话键带访客后缀的）不迁，停着不用。
- s15b：Claude 那边，开口前比一下原生会话文件里最后一条记录是不是 bot 自己写的，不是就重新接上；有新的压缩边界就把话题表标成要附。Codex 那边每轮结束放开线程（e14：不放开时终端打开会被拒），下一轮重新接上，多花的时间开工时量。bot 正在回答的那一轮里终端也在写，不处理（product.md 3.5）。
- s15e 做法：Claude 历史折叠时从全部轮次取首条非空用户消息作为预览，再裁显示的最近几轮；`readHistory` 复用 `readSessionTitle` 读取原生标题，标题元数据读取失败时保留已经读到的历史与预览。恢复后的摘要优先原生标题，否则用去掉信封后的首条消息；三个恢复入口共用现有逻辑。只读本地会话文件，不调用 Claude 推理。
- s15b 做法（Claude）：活着的 Claude 进程把历史放在内存里，不再读文件。每轮开口前（`resolveThread` 的活线程那一支），线程从上次读到的位置接着读自己的 `<会话 id>.jsonl`（`agent/claude-agent/transcript.ts`）：带 `uuid` 的记录里 `entrypoint` 不是 `feishu-codex-bridge` 的（终端是 `cli` 或 `sdk-cli`），就是别人写的，关掉这个进程，从文件重新接上（记 `agent.native-changed`）；文件变短了也算。`last-prompt`、`ai-title`、`cost-state` 这类记录没有 `entrypoint`，不算谁的。从文件接上时整份读一遍，记下读到哪里和最后一个 `compact_boundary`，所以 daemon 没开时终端里做的压缩也认得出。读失败当没人写过，照旧用活进程。
- s15b 做法（Codex）：每个运行结束（排队的几轮都跑完）就关掉 app-server 进程，`/compact` 和网页的压缩做完也关（`releaseIdle`）。`thread/unsubscribe` 放不开：实测 unsubscribe 以后 48 秒终端还是被拒，`thread/loaded/list` 里线程还在；只有进程退出才放开。只做过 `thread/start`、还没有回合被 Codex 接受的线程（`/new`、`/clear` 刚建的，第一轮 `turn/start` 被拒的）不关，关了下一轮接不上。下一轮要接上时，先等 bot 自己关的那个进程退出，再 `thread/resume`。下一轮从磁盘接上，接上时终端或 Codex 应用正开着这条会话，Codex 报 `already has an active writer`，bot 回一句让关掉那边再发（`SessionInUseError`），不换新会话。
- s15b 做法（压缩后的表）：线程的 `lastCompaction` 是原生会话里最新一次压缩的 id（Claude 是 `compact_boundary` 的 uuid，Codex 是 `contextCompaction` 条目的 id，重新接上 id 不变）。主区会话每轮开口前比一下 `SessionRecord.compactSeen`（新加的可选字段，先看内存），不一样就把 `topicsDue` 标上、记下新的 id（记 `agent.native-compaction`）。bot 自己看到的压缩照旧在当时就标，这里再标一次是同一个值。升级后第一轮，以前压缩过的主区会话会附一次表，因为旧记录里没有 `compactSeen`。
- s15b 量的（2026-10-16，JP-VPS，codex-cli 0.163.0，2 核）：关进程到退出 140 到 340 ms，在回复之后，不占回复时间；下一轮在预热过的进程里 `thread/resume` 240 到 370 ms，预热池空着时再加起进程和握手 250 到 580 ms。s15b 之前活线程这一步约 0。回合刚结束（`turn/completed`）就关进程，三次重新接上最后一轮都在。
- s15b 留下的：同一个运行里 bot 自己压缩、排队的下一轮已经附过表，运行结束后、下一轮之前终端里又压缩了一次，这次不附表（分不出是哪次压缩，罕见，不处理）。云文档评论的 Codex 会话照旧常驻（3.5 只说主区和话题）。bot 正在回答的那一轮里终端也在写，不处理。Claude 那边终端开着、bot 也在写，两边都能写，会分叉，不处理。Codex 桌面端打开同一条会话放进 M5 预览版任务。
- s21："智能"这一项先不出现在绑定卡、群详情页和命令行里，等 s25 接上智能入站再放出来，中间不出现半成品的智能群。Claude 不支持插话，照样排队。
- s21 做法（数据）：多会话、单会话还存在群记录的 `kind` 里，没有或不认识的值按多会话读，和以前一样。智能存成 `smart: true` 加 `kind: "single"`，退回 s21 之前的版本时照样当单会话跑。这一片没有入口能写 `smart`（三个入口、网页编辑都只收多会话和单会话）。读到它（更新的版本写的，或者手改的），s25 之前按"单会话、仅 @"跑：主区一条会话，只回 @ 我的，不读不 @ 的消息；网页、私聊列表和命令行都显示成单会话。网页上保存别的设置时它留着；切到多会话时去掉 `smart`，免 @ 按它跑时的值（关）写下。s25 接上智能入站时改这里。`smart` 只在 `kind` 是单会话时算数：s21 之前的 daemon 把这个群切到多会话时不会去掉它。智能群在私聊卡、群里 `/settings`、网页和 `settings set` 上改免 @ 照样存、但不起作用，s25 隐藏智能群的免 @ 时一起处理。
- s21 做法（免 @）：新绑定、新建群都把免 @ 写进记录，入口没给就按 3.4 的默认，多会话开、单会话关。旧记录不改写，没写免 @ 的照旧按 bridge 的默认读（只有被拉进来的单会话群关）。网页上在多会话和单会话之间切换时，没写过免 @ 的群先把切换前的值写进去，所以免 @ 不变，页面上提示一句。
- s21 做法（入口）：私聊绑定卡和私聊新建卡是两颗按钮，按钮上面各一行副标题，点哪颗就是选哪种，两颗一样的样式；下面一个免 @ 下拉，不选按会话方式的默认。网页对话框（建群和绑定）是两项单选卡片，开始都没选，不选不能提交；选了以后出现免 @，默认跟着会话方式，手动改过就不再跟。`vonvon group bind` 的 `--conversation` 必填，值是 `multi` 或 `single`（旧的 `threads`、`shared` 照样认），可加 `--response mention|all`。命令行和网页的绑定只在免 @ 和默认不同时才把它发给 daemon，s21 之前的 daemon 照样能绑默认的情况；网页建群只在选了开时不发，因为 s21 之前的 daemon 建群一律是开，选了关就发出去，让老 daemon 报错而不是建出一个免 @ 开的群。同一个群再绑一次，文件夹、后端、会话方式和免 @ 都相同才算重试成功，免 @ 不同就报错，让人去群设置里改。三个入口的主标题、副标题放在 `@vonvon/protocol` 的 `conversationCopy` 里，一处改。
- s21 做法（运行中来了消息）：群记录加 `pendingPolicy`，没设继承 bot 的。`vonvon settings set --group <群> run.pendingPolicy=queue` 改，`default` 改回继承。Claude 的群生效值显示排队。网页群详情页的这一项在 s28。老 daemon 的设置视图里没有这一节，新网页照样能读。
- s22：话题群和话题形式群在 s25 里不判断开不开话题，靠这里读到的 chat_mode 认出来。查询失败时，没点名的消息一律不回。
- s22：引用按 s14 的规则认：`parent_id` 不等于 `root_id` 就是引用了话题里的某一条，按 `parent_id` 查是谁的消息；话题里引用话题根分不出来，算没引用。e10 只测了普通群里的话题，话题群（`chat_mode=topic`）里的引用这片补测一次。
- s22 做法（判断）：`bot/baselines.ts` 的 `audienceOf` 先答"对谁说"：别的 bot 发的，没 @ 我是别人的；@ 我；@所有人、@ 了别人（真人或 bot）是别人的；引用我的是我的（@ 了别的 bot 也算，两个都点了名），引用别的 bot 或别的真人的是别人的，引用自己的不算；话题里没点名的，拉话题消息（新到旧，最多 3 页）找最后一条 bot 发的，是别的 bot 就是别人的。结果是"我""别人""没点名""没查到"四种，没点名的交给模式，规则模式照 bridge 的免 @ 规则。
- s22 做法（只在会变的时候查）：引用和话题这两查只在免 @ 开着时做；仅 @ 只认 @，一次不查。群里只有我一个 bot（群信息的 `bot_count` 是 1）时也不查，规则模式和以前一样，比如单会话群里引用同事的话照样回。群信息和话题群的认法共用 `topic-context` 的 `chatInfo`：有别的 bot 的群和缺权限的失败缓存 10 分钟；只有我一个 bot（之后可能有 bot 进来）和别的失败缓存 1 分钟（原来认话题群缓存 1 小时）。查询放在同步副本、停用、正在改设置、群和人的放行这些便宜的门后面；SDK 按群串行调 `onMessage`，查询不会乱序，只让同群后面的消息多等，每查最多 3 秒，最坏三查串行约 9 秒。话题里还没有 bot 说过话时，免 @ 的 bot 都回，和单会话主区一样留给 s26。
- s22 做法（错误路径）：被引用的消息或话题查不到，这条不回，诊断页记 `lookup-failed`。群信息读不到时按有别的 bot 处理（多会话主区的命令要 @，这样没回的命令诊断页也记 `lookup-failed`；话题照样去查），不照上面"查询失败时，没点名的消息一律不回"的字面做：`im:chat:readonly` 是可选权限，缺了它免 @ 就整个失效太重（3.11）。"一律不回"留给 s25 的智能入站。
- s22 做法（bot 消息和主区命令）：别的 bot 发的消息规则模式一律不回，@ 了我也不回（3.4"规则模式下 bot 之间互相看不到"），记 `intake reject bot-sender`；授权链接里已经带了 `include_bot` 权限，开了它的应用今天会回，这是行为变化。智能群在 s27 之前也不回。多 bot 群里，多会话主区不带 @ 的命令和 `/goal` 不回；单会话主区照旧（不带 @ 的普通话也回，几个 bot 抢着回由 s26 处理）。
- s22 实测（2026-10-16，JP-VPS）：验收 daemon 也连着 Bot 7、Bot 8，另起 daemon 连同一个应用会随机分走事件，所以没收事件，只用 Bot 7 的应用身份调接口，lark-cli 以 owner 身份发消息、以 lark-cli 自己的应用当"另一个 bot"，在新建的普通群和话题群里各走一遍（群名不写进仓库）。普通群：`bot_count` 是字符串 "2"；话题里只有真人时最后的 bot 是"没有"，另一个 bot 回过是"别的"，Bot 7 回过是"自己"；引用 Bot 7 的话题消息 `parent_id` 是它、`root_id` 是话题根，`audienceOf` 判成我；引用另一个 bot 的判成别人；主区引用 Bot 7 的消息，`parent_id`、`root_id` 都是它、没有 `thread_id`，判成我。话题群：`chat_mode=topic`，没有 `group_message_type`；帖子本身没有 `root_id`、`parent_id`；帖子里直接回的 `parent_id`、`root_id` 都是帖子，算没引用；回复帖子里某一条的 `parent_id` 是那一条。`bot_count` 算不算群里的自定义机器人（webhook）没测。
- s22 留给 M5 验收的：第 1、6 步要三个 bot 在同一个 daemon 里收事件。验收 daemon 已经跑着 Bot 6、7、8，M5 验收时把它升级到含 s22 的 main，在它里面绑定，不另起 daemon。
- s23：读 `SMART.md` 的那一小段先写在这里，s38 的 bot 文件模块合入后改成调它。
- s23：Codex 的判断用 gpt-6-luna，推理强度取最低档。这是没设判断模型时的默认，也是测试用的设置；主人能改（3.4）。测试、Mac 检查和 M5 验收里，判断都用它（owner 2026-10-15："测试的时候就用 gpt-6-luma 去判断"，按 gpt-6-luna 理解）。Claude 的 bot 用 Claude 订阅里的小模型。
- s27：交接接收者、消息/话题位置和发出/响应状态从真实平台结果得出；失败或未知不假称送达，不新增 ACK 循环/私有信道。依赖仍为主表的 s22/s25/e10。
- s23d 做法（判断模型的设置）：照现有的 `model.selection`，在 bot 层（`vonvon settings set`）和群层（`--group`）各加一节 `judge.selection`，比如 `vonvon settings set --group <群> judge.selection='{"kind":"llm","model":"gpt-6-luna","effort":"low"}'`（gpt-6-luna 能选的是 low 到 max，没有 minimal；"最低档"按模型列表现算，不写死）。`kind` 现在只有 `llm`，留给以后的决策模型；`model` 可以是模型列表里的，也可以是手填的 id，校验照 s16 的手填规则；`effort` 可省。可选的模型复用 s16 的后端模型列表。没设、或者群的后端和 bot 层选的模型不是同一个后端时，按 3.4 用这个后端的默认小模型。界面（s41、s42）和聊天改设置（s54a）用同一节。
- s23：gpt-6-luna 用 ChatGPT 登录时，Codex 0.148.0 被拒、0.156.1 能用，中间的边界没查（e05）。最低版本定 0.156.1 时够用，和 s03 留下的一致。
- s23 拆成四片：s23a 判断层，s23b Codex 判断进程，s23c Claude 判断、模型解析和冷却，s23d 设置、RPC 和命令行。b 和 c 依赖 a 的契约；d 依赖 c，单独交付公共设置入口，不改变产品范围。涉及子进程的片增加多角度审查。
- s23a 做法（判断层）：`D/judge/judge.ts` 的 `createJudge`，编排器建一个，关机时和 `shutdownResidentClients` 并列收；s23 没有调用方，s25 直接用编排器里的 `judge`。`judge()` 永不 reject：超时、调用方的 signal、关机汇到一个 AbortController，读提示词、排队、等后端整条和它 race，到点先返回，不挡关机时的排空；后端调用自己收尾，名额等它落定才还，最多等 15 秒（日志 `judge.slow-settle`）。先定后端和模型再读提示词，哪一步失败结果里都有后端和模型。Codex 的模型列表只读后端已缓存的那份（`peekModels`），没有就后台单飞拉一次，拉完还没有，5 分钟内不再拉。`SMART.md` 用 `O_NOFOLLOW | O_NONBLOCK` 打开，要普通文件、硬链接数 1、32 KB 和 8,000 字以内，符号链接、FIFO、硬链接这些报 `prompt`，不悄悄回退到默认值；只有空白算没写。appId、chatId 用协议的 schema 校验。日志 phase `judge`，只记决定、耗时和 token，不记正文、名字、模型给的原因和提示词（3.5）。
- s23b 做法（Codex 判断进程）：`D/agent/codex-appserver/judge-process.ts`，每个 bot 进程一个 `codex app-server`，挂在 client-pool 的注册表上，`shutdownResidentClients()` 一起关。第一次判断才起，空闲 10 分钟关；每条判断开一个 ephemeral 线程，结束发 `thread/unsubscribe`，通知按 threadId 分流。RPC 不带 jsonrpc 层的超时：调用方的死线只让这条先返回，晚到的 `thread/start` 回包补发 unsubscribe，turn 在跑就补发 `turn/interrupt`，`judge()` 的 promise 收尾做完才落定；单个 RPC 15 秒不回包才算卡死、杀进程。连接失败、意外退出、卡死以后退避 5、15、60 秒，成功一次清零；codex 二进制的指纹变了，旧进程做完手上的就关，新判断起新进程。`turn/start` 带 `summary: 'none'`。`cold` 只标起进程的那一条，同一次创建上等着的其他判断不标。`thread/start` 回包缺 `thread.id` 报 failed，写"thread/start 回包异常"。`judge process-exit` 日志不带退出码和信号（通知流可能先于子进程的 exit 事件结束），退出码见同 pid 的 `agent exit` 日志。`warm('codex-appserver')` 现在只拉模型列表，判断层不改，s25 要预热进程时再接。
- s23b 开工验证（设计 6.3 第 1 到 4 条，2026-10-16，JP-VPS，0.163.0 和 0.156.1，假 Responses 服务加 10 轮真实登录）：
  - 关工具的键只有四个真让工具列表变短：`features.shell_tool`、`features.goals`、`features.view_image`、`features.sleep_tool`，都设 false。`include_apply_patch_tool`、`tools.view_image`、`features.unified_exec` 等一个工具都没少，不加。gpt-6-luna 是 code mode，`exec`、`wait`、`request_user_input`、`collaboration.*` 关不掉；真实 10 轮模型都没调工具，app-server 发来的服务端请求 daemon 直接回错误。
  - 会话层的 `config` 和用户的 `config.toml` 是深合并，`projects`、`memories` 不会被整表替换；`mcp_servers: {}` 也清不掉全局 MCP。MCP 用嵌套写法 `{ <名字>: { enabled: false } }`，只写 `config/read` 盘点出来的名字（写不存在的名字 `thread/start` 报 `invalid transport in mcp_servers.<名字>`）；app-server 每次 `thread/start` 都重读 `config.toml`，所以每条判断前都盘点（`config/read`、`skills/list` 各几毫秒、5 秒死线、失败按空表），报这个错就重新盘点、重试一次。skill 传 `{ name, enabled: false }` 加 `bundled.enabled: false`，取 `scope` 不是 system 的名字，不存在的名字不报错。点号写法 0.156.1 和 0.163.0 行为不一样，不用。
  - `baseInstructions` 两行中性文字换掉 Codex 自带的约 18k 字系统提示词：gpt-6-luna 一条判断的 input 从 9.1k 降到 5.6k tokens，服务端不拒；`summary: 'none'` 时请求里没有 summary 字段。
  - 一个进程 4 条并发总用时 3.7 秒，单条 3.2 到 3.7 秒，没被串行，Codex 的上限保持 4。`config/read`、`skills/list` 在 0.156.1 上都有，形状一样。
  - 额度：`prompt_cache_key` 等于线程 id，每条判断基本不命中缓存，e12 按每条约 5.6k 不命中缓存的 input、约 30 output 估。一轮 3 到 4 秒（gpt-6-luna，low）。
- s23c 做法（Claude 判断、模型解析和冷却）：Claude 的 `judge()` 每次调一次 SDK `query()`，用标题任务的那组选项（禁用工具、MCP、普通 hooks、skill，不存会话，排除个人 CLAUDE.md；managed policy 的 hooks 和用户 apiKeyHelper 仍可能执行，JP-VPS 上两样都没有，测不到，见"s23c 收尾实测"），`systemPrompt` 是字符串，整段换成 `SMART.md` 加格式行；没选推理强度时传 `thinking: {type:'disabled'}`，`finally` 里 `query.close()` 后通过共用进程所有权机制等整个进程组退出，才让 promise 落定；强制清理报错。判断被放弃（超时、调用方放弃、关闭）时立刻对整个进程组发 SIGTERM，不等 SDK 只关 stdin、2 秒后才杀直接子进程的那条路；SDK 转来的 `signal` 不交给 `spawn`。真实 CLI（2.1.296）收到 SIGTERM 自己 `exit 143`，登记自己发过 SIGTERM（或子进程被 kill 过）之后的 143 算正常停止，别的退出码和没人要求的 143 照样报错。已放弃的判断清理失败（要 SIGKILL、管道没关、回收没确认）时，结果已经是超时或放弃，另记一条 `judge` 的 fail 日志（`phase: abandoned-call`）。`assistant.error` 的代码算结构化的错误（`model_not_found` 归 `model`），只靠文字认出来的不算。默认模型 `haiku`，只有 `ANTHROPIC_BASE_URL` 指向非 Anthropic 的主机才用网关的模型；`~/.claude/settings.json` 每次判断只读一遍（`readClaudeUserSettings`），按路径、大小和 mtime 缓存，没变时只 stat 一次，改了不用重启。判断理由只去掉开头的 `<reason>` 和从 `reason`、`decision`、`invoke`、`parameter`、`function_calls` 这几种标签起的残渣，`List<String>`、`a<b` 原样保留。判断时按群、bot、默认的顺序找这个后端的设置，手改坏的值当没设，每个值只记一次 `judge.setting-ignored`。冷却在 `D/judge/cooldown.ts`，只认结构化的 auth、quota（冷这个后端）和 version、model（冷这个后端加模型），5 分钟。
- s23d 做法（公共入口）：判断模型存在 `preferences.judge` 和 `projects.json` 那一行的 `judge`，存的时候一定带后端：bot 层不写是 Codex，群层不写是群的后端，群层写了别的后端就拒。设置视图里 `judge` 节、`smartPrompt`、bot 页的 `judgeByBackend` 都是可选字段，不升 `PROTOCOL_VERSION`；`ModelQuery.purpose` 加了 `judge`。`vonvon settings get` 在 `[judge]` 下按后端各打一行、打提示词来源，`settings get judge` 另打提示词全文、三段格式行和输入示例。`smartPrompt.backendNote` 按 s23b 的结果写成"两行基础指令加 `~/.codex/AGENTS.md`"，不再说带 Codex 自带的系统提示词。
- s23c 开工验证（设计 6.3 第 5 条，2026-10-16，JP-VPS，SDK 0.3.296，claude.ai 登录，7 次真实调用）：
  - 字符串 `systemPrompt` 在订阅登录下能跑通，服务端不拒，回的是判断格式，不用退回 preset。input token（含缓存写和读）字符串约 1.9k，preset 加 append 加 `excludeDynamicSections` 约 4.6k；`outputFormat` 带来的 StructuredOutput 工具定义约 530。
  - `model: 'haiku'` 能用，实际是 `claude-haiku-5-5`。`tools: []` 加 `maxTurns: 1` 加 `outputFormat` 拿得到 `structured_output`（`num_turns` 是 2，`maxTurns: 1` 不挡）。
  - haiku 收 `thinking: {type:'disabled'}` 不报错，但每次仍有 100 到 600 个 thinking token；照传，用时和额度按"有思考"估。一次 2.3 到 4.9 秒（`duration_ms`），连 CLI 启动 4.3 到 7.0 秒，判断超时的默认值够用。
  - `structured_output` 的 reason 里出现过标签残渣（`</reason>`），`parseVerdict` 从这类标签起截掉（审查后只认已知的几种标签，见上面的做法）。
  - 不写会话记录，但 `~/.claude/projects` 下会按判断 cwd 建一个只有空 `memory/` 的目录，所以判断 cwd 固定用 `<数据目录>/judge`。2026-10-18 同一 SDK 的 5 次没有建这个目录，固定 cwd 照留。
- s23c 做法（行数）：设计估约 1,050 行；拆出 s23d、merge main 后，对 main 约 1,200 行（含本文，不含 lockfile）；改完审查意见后约 1,450 行（对合并基点 `898d3c5`，增删合计）。
- s23c 收尾实测（2026-10-18，JP-VPS，SDK 0.3.296 带的 CLI 2.1.296，claude.ai 登录，真实 HOME，数据目录在临时目录，去掉父会话的 `CLAUDE*` 环境变量，5 次真实判断）：
  - 走 `createJudge` 加 `ClaudeAgentBackend.judge` 的真实路径：`test/judge-real-claude.test.ts`（`VONVON_REAL_JUDGE=1`）三种变体各 1 次，格式和决定都对，`settings.json` 不变，聊天内容没进 `~/.claude`、`~/.codex`；另用插桩脚本跑主区闲聊和主区被 @ 各 1 次，记 SDK 消息。
  - 实际模型 `claude-haiku-5-5`（init 和 assistant 都是）；init 里工具只有 `StructuredOutput`，MCP 为空，`permission_denials` 为空；每次 assistant 内容是 thinking 块加一次 `StructuredOutput` 调用，`num_turns` 2，没有别的工具调用。`structured_output` 只有 `decision`、`reason`，决定在变体允许的集合里，reason 22、28 字，没有标签残渣。
  - 传了 `thinking: {type:'disabled'}`，仍每次有 thinking 块：thinking token 57、584（`usage.output_tokens_details.thinking_tokens`），output 159、686。input（直接加缓存写）约 1,870，两次都没命中缓存读。
  - 用时：主区闲聊 `duration_ms` 1.8 秒，判断从调用到结果 7.0 秒（第一次，含 CLI 冷启动）；主区被 @ 的 `duration_ms` 7.9 秒，判断 9.7 秒，离被 @ 的 10 秒超时只差 0.3 秒，超时会按规则回在主区。被 @ 这一条思考长（584），所以"超时默认值够用"不再成立，e12 量分布后再调。仓库的真实测试 3 次连扫描副作用共约 15 秒。
  - 主区被 @ 那次 `modelUsage` 比 `usage` 多一次 haiku 调用（多约 1,245 input、149 output），`duration_api_ms` 9.3 秒大于 `duration_ms` 7.9 秒，CLI 在判断外另调了一次，原因没查；`consumeClaudeJudgeQuery` 按 `usage` 记 token 会少算，e12 量额度时看 `modelUsage`。
  - 每次判断落定时 CLI 的 pid 已不在、它的进程组为空，结束后 `ps` 里没有残留的 claude 进程（只剩跑本次检查的会话）。
  - JP-VPS 没有 managed settings（`/etc/claude-code/` 不存在），用户设置里没有 `apiKeyHelper`，用户的 hook 只有 Bash 的 PreToolUse（判断没有 Bash 工具，本来也不会触发）。所以"managed policy 的 hooks、apiKeyHelper 仍可能执行"这两条这里测不到，照旧只写成限制。判断 CLI 启动时间前后，`~/.claude` 下的 `.claude.json` 备份、模型目录缓存和 `plugins/synced` 有更新（本会话的 Claude Code 也在跑，不能确定是谁写的），都不含聊天内容。
- s23：判断看不到 bot 的个性。接口留了 `persona`，s25 在 s38 合入后传 SOUL.md 的前 1,500 字；在那之前，主人可以把分工写进各个 bot 自己的 `SMART.md`。
- s24 不做了：填 key 的判断模型（Decisions API、Jev）移到 product.md 第 10 节（owner 2026-10-15）。编号空着，不挪别的片。
- s25：每群每小时的上限先按 60 次做，e12 量完再调。
- s26：单独跑一个 bot（`--bot`）时退化成单 bot；子进程退出或请求超时，退回由各 bot 自己判断。
- s26（合成判断要定的事，s23 回答不了）：判断层不依赖 bot 子进程的全局状态，supervisor 里能 `createJudge` 一个，但合成调用要自己定：几个 bot 各有自己的 `SMART.md` 和分工（3.4 例子第 3 行：小P 开话题回、小审不回），一次调用怎么把它们都放进提示词；几个 bot 的判断模型可能不同，还可能一个 Codex、一个 Claude，用哪个后端和模型；输出要说清哪个 bot、回在哪里，`JudgeResult` 至少要加一个 `bot` 字段，一个 `decision` 装不下；整机统一的判断并发上限（s23 按 bot 进程算）。
- s27：别的 bot 的最终回答按 s14 带 `card_msg_content_type` 拉，不然只拿到"请升级至最新版本客户端"（e10）。
- s15c 做法（一档）：每一轮都用群的一档 `effectiveMode`，谁说话都一样；`turnTier`、`effectiveGuestMode` 删了。管理员名单和只限主人、管理员的事（`/resume`、`/new`、`/clear`、`/settings`、运行控件、私聊）不变，这些门都不读档。管理员和成员在同一条会话里，运行中来了消息按"运行中来了消息"的设置插话或排队，和两个成员之间一样。
- s15c 做法（会话键）：会话键不再带后缀。daemon 启动、bot 起来之前，存的两档还不同的群（`guestMode` 有值、和 `mode` 不同，和原来分档的判断一样），没归档的 `<位置>#admin` 改名成 `<位置>`，顶掉那里原来的记录（分档期间没人读它，`/resume` 列的是原生会话，不受影响）；`#guest`、归档的 `#admin`、已经不分档的群里留下的 `#admin` 都不动，停着不用（`isRetiredKey`）。改名只在有记录要动时写盘，再跑一次什么也不做；失败只记日志（`run tier-merge`），bot 照常起来，要改的群记进 projects.json 顶层的 `tierMergePending`（只改这个键，各行原样），下次启动按存的两档不同的群加上它再试，中间哪次写盘去掉了 `guestMode` 也不漏；改成了就删掉这个键。登记表、引用行、话题表、撤回、私聊的项目列表和话题卡、网页和桌面端的会话列表都跳过停用的键；桌面端和会话设置（网页、`vonvon settings get/set --session`）按 id 碰停用的键，回"已停用"，什么也不改。
- s15c 做法（已存的 `guestMode`）：读 projects.json 时，有 `guestMode` 的行取两档里更严的（只读 < 读写 < 完全访问，不认识的值算只读，`null` 算没设），内存里不再有这个字段；下一次写 projects.json，不管为什么写，每行的 `guestMode` 都去掉。改名按的是写盘之前的原样，所以要在任何写之前做：daemon 的单实例锁保证旧进程不会同时写，supervisor 和预览进程只读。
- s15c 做法（设置）：网页只剩一个「权限档」下拉，s20b 的理由写在它下面；私聊 🔐 权限卡只剩一个下拉，提交按钮的值带版本号 `v: 2`；升级前发的旧卡没有版本号，提交时什么也不存，再发一张新卡。只看表单认不出旧卡：后端只能完全访问时，s20b 的卡不预选完全访问以外的"普通用户档"，不动它就什么也不交，只交 `mode=full`，存下来会把群从只读放宽成完全访问；`vonvon settings set --group … permission.guestMode=…` 在连 daemon 之前就拒，说明改 `permission.mode`；设置保存、IPC、RPC 带 `guestMode` 的一律拒。Linux 上 Codex 的回合开始时回的说明、诊断页的"下一步"只写「权限档」和 `permission.mode`。
- s15c 做法（领文件、开场）：领文件按群现在的档，和文件写出时的档比的那一步留着：群的档调低以后，旧卡上工作区外的文件领不到，回点的人"这个群现在的权限档拿不到"。话题开场的主区几条对谁都留 bot 自己的回复，主区会话 id 取不带后缀的那条。
- s15c 做法（协议）：不升 `PROTOCOL_VERSION`（同 s02c1、s12、s20a）。快照里的 `membership.permission.member`、管理状态里的 `AdminProject.guestMode`、群设置视图里的 `permission.guestMode` 留着，等于群的一档，标了 deprecated，升级前的桌面端、网页和命令行连新 daemon 照样能解析；视图里的 `guestMode` 只出不进，编辑里的 `guestMode`、`setPermission` 命令里的 `member` 去掉了，`vonvon settings get` 不打印它。升级前的客户端照样打得开群设置这一页，在那里改「普通成员权限」会被拒。
- s15c 留下的：
  - 给 s60：bridge 迁来的群两档不同时 `mode` 取 `stricterTier`，迁移结果里列出来（product.md 第 5 节）；这些群的 `<位置>#admin` 会话照 `adoptAdminSessions` 改名（或者迁移时原样留着 `guestMode`，让第一次启动来改，二选一），`#guest` 原样拷过来或者丢掉。
  - 给 s15b：一个位置只有一条会话，"看一眼会话"用不带后缀的键，跳过 `isRetiredKey` 的记录。
  - 升级后又退回 s15c 之前的版本：还存着 `guestMode` 的群会重新分档、起一条新的 `#admin` 会话，再升级时它顶掉 `<位置>`。原生会话都还能 `/resume`，不处理。

### M6 提问卡片、权限档和子 agent

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s29 | 提问的事件和卡片 | 用 ask 事件换掉占位的 approval_request；三种卡一个版面，写清后果；空提交提示"至少选一项"（3.8"卡片"） | 640 | — | 并发、错误路径 | 无（渲染在 s31 的 Mac 检查里看） |
| [x] | s30 | 卡片的发送、谁能点、等待和超时 | 同一条会话同时一张卡；单独发一条并 @ 能回答的人；daemon 按点击人判断谁能点；15 分钟超时；等卡时看门狗暂停；普通回合、`/goal`、云文档评论三处都接上（3.8） | 900 | s29、s11、e09 | 并发、关闭清理、错误路径 | 无（真实卡片在 s31 一起看） |
| [ ] | s31 | Claude 的权限档换算，提问接上 | 只读用 default、读写用 acceptEdits、完全访问照旧；加 canUseTool：提问出卡，越权拒绝并说明，完全访问下 Claude 自己要问的出卡（3.8 换算表）；只读、读写档用沙箱的 denyWrite 加 Edit 拒绝规则，挡住主工作区里两家的配置文件（3.6） | 440 | s30、e02、e03 | 子进程、并发、关闭清理、错误路径 | 真实 Claude 三档各跑一遍：越权被拒带原因，关网 curl 被拒、开网 WebFetch 能用，选项卡能答、能超时，等卡时能停止；读写档下用 Write 和 Bash 写工作区的 `.mcp.json`、`.claude/settings.json` 都被拒，先用 Bash 建指向它们的符号链接、硬链接再用 Edit 写链接也被拒；用 Bash 新建原本不存在的 `.mcp.json`、`.claude/skills/x`，把整个 `.claude` 目录 `mv` 走再重建，也都被拒（product.md 第 9 节第 24 项） |
| [x] | s32 | Codex 发来的请求不再报错 | 服务端请求进同一个通知队列；提问变选项卡，审批回 decline，不认识的方法仍回 -32601（3.8） | 900 | s30 | 子进程、并发、错误路径 | 真实 Codex：普通回合不发请求，审批请求回 decline 后这一轮不卡 |
| [ ] | s33 | 打字回答、旧卡自愈、敏感问题去私聊 | 有卡在等时，能回答的人发的消息就是答案；点到失效的卡改成"已失效（后台服务重启过）"；要填密码的题去私聊答（3.8"等待和超时"） | 520 | s30 | 并发、关闭清理、错误路径 | 无 |
| [ ] | s34 | 子 agent 的事件 | 加子 agent 事件；Codex 收子线程的通知并刷新看门狗，Claude 子 agent 的步骤不再混进主过程；能单独停一个（3.9） | 650 | — | 并发、错误路径 | 真实 Codex 跑带子 agent 的任务：子线程通知送到，父线程不被看门狗杀，单停有效 |
| [ ] | s35 | 运行卡上的子 agent 区 | 一行一个子 agent，点开看最近 5 步，每行能停；都结束卡才收尾；子 agent 发起的卡片发在父运行卡的位置，写"子 agent X 问……"；Claude 会话打开 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（3.9、3.8） | 500 | s34、s30、e01 | 并发、关闭清理 | 真实 Claude 的子 agent 跑完前卡不收尾（子 agent 区和停止按钮在飞书客户端里的样子，M6 验收时 owner 看） |

开工要点：
- s30：要不要另发一条带 @ 的文字，按 e09 的结果定；结果出来前默认另发。
- s30 做法：每轮独立的提问协调器句柄管理 FIFO，一条会话同一时间只接收队首卡的回答。卡片回复本轮原触发消息，话题位置不随插话卡改变；卡里有真实 @，另发一条带原生 @ 的文字回复提问卡。点击按实际消息、群、会话当前轮次、请求和当前管理员设置核对，普通题再允许发起这一轮的真人回答；bot 或身份不明的发起者只允许主人/管理员。空提交在聊天里提示“至少选一项”，不结清请求；托管卡的 `__r` 只作渲染元数据，其余未知字段仍拒绝。
- s30 做法（等待和关闭）：入队即暂停本轮空闲看门狗，发卡 30 秒没返回就按无法回答处理；发出后开始 15 分钟的人答题计时。回答、超时、停止和回合结束先占定结果、释放等待并调用后端的本地继续接口，再尽力更新终态卡；迟到的发卡结果只收成终态，不重新登记按钮或提醒。网络调用不进入关闭时等待的任务集合。目标模式每轮换句柄，旧轮迟到的失败不停止新轮；云文档评论不发卡，提问直接无法回答，接口缺失时停止并回收原评论回合。
- s30 边界：后端中立的 `AgentRun.respondToAsk` 要先同步领取并释放本地继续请求，再返回传输结果；s31、s32 负责各自实现并验证这条约定，本片不让 steer 代答。s30 单片未实现后端请求生产，不能据此声称真实聊天已能提问；Codex 接线由 s32 完成，Claude 接线仍待 s31。e09 仍未验完，沿用本节既定的额外 @ 文字，飞书通知与真实卡片显示留到 s31/M6。
- s30 JP-VPS 验证（2026-10-17，Codex）：同步默认配置的 main 后，提问、评论、消息排队、会话和默认配置共七文件 241 项通过；独立审查重跑四文件 108 项通过。daemon build/typecheck、根 build/typecheck/lint 通过。独立审查复现并修复插话换卡期间已回答的等待提示重新出现，新增真实调度器用例先失败后通过；其余覆盖消费不等发卡、回答/更新永不返回时仍能关闭、目标两轮和原触发位置、评论不出卡及旧轮失败隔离。协调器另验空提交、权限变化、特殊字段、发送期限和迟到结果。完整 Linux/macOS 以 PR 准确 head 为准。
- s29 做法：用后端中立的 `ask` 请求取代未使用的 `approval_request`，一个请求可以包含多道单选或多选题；选项、确认和完全访问下的提问共用独立卡片布局，写清回答和不回答的后果。提交边界核对请求、动作和题目选项，空提交提示“至少选一项”；回答、超时、停止和重启失效的终态去掉交互。运行卡忽略 ask；发送、谁能回答、排队和等待仍在 s30，两家后端接线仍在 s31、s32，s29 不声称聊天里已经会发卡。
- s29 JP-VPS 验证（2026-10-17，Codex）：`ask-card`、`run-card-stream` 两份测试共 72 项和 daemon typecheck 通过；验证 schema 2.0 JSON、多个问题、跨请求或跨类型的提交、空值和伪造选项、终态无按钮，以及普通 reducer 和 RunRender 的状态、结束时间不受 ask 影响。完整 Linux/macOS 检查以 PR 准确 head 为准；飞书客户端里真实卡片的渲染留到 s31/M6 验收。
- s31：e02 用到的字段，s02 锁定的 SDK 0.3.296 里都有，e02 这边不用抬版本；e03 的结果还可能要抬。同时改掉 `permission.ts` 顶部那段注释。
- s31：按 e02 的结果做：所有会话启动时都带 `allowDangerouslySkipPermissions: true`，中途升到完全访问才不用重开会话；resume 时明确传档，档不从记录里恢复；拒绝时不用 `interrupt`，不然原因会丢、这一轮按出错结束；提问的答案放进 `updatedInput.answers`。启动时带上这个参数后，升档只能走两条路：daemon 调 `setPermissionMode`，或者回调返回带 `setMode` 的 `updatedPermissions`。两处都只按权限档的设置来，回调不照搬 `suggestions` 里的 `setMode`。回调拿不到"这是在联网"的标记，关网时 Bash 联网靠沙箱挡，看 e03。
- s31：owner 2026-10-15 定（选了 B）：两家的连接器和 Claude Code 自己的工具第一版都留着，不关，Codex 也不传 `features.apps: false`。当时问的是：bot 的会话要不要关掉 claude.ai 连接器，和推送、远程触发、定时任务这类 Claude Code 自己的工具（e02 第 7 节）。建议用内置工具白名单，连接器默认关。Codex 一侧的同一类问题一起问：用主人的 ChatGPT 登录时，每条会话都挂着 `codex_apps`（主人账号的连接器，0.162.1 上 197 个工具，含合并 GitHub PR 这类写操作），会话层 `features.apps: false` 能关（e05），在 s37 的 profile 里传。
- s31：e02 没测完的两件，开工时补测：完全访问下，Claude 设置里的 ask 规则、删除关键目录会不会走到回调；vonvon 真实的 `['user', 'project']` 下，用户层的权限规则会不会改变哪些调用走回调。e02 用的是空的 `settingSources`。
- s31：顺手修会话标题的读法：`readSessionTitle` 只认记录里 `custom-title` 的条目，不用 `customTitle` 字段，因为它会退回 CLI 自动起的标题（e02 第 8 节）。放在这一片，是因为 s31 本来就要改 `D/agent/claude-agent/` 下的后端代码；约 40 行，算进这一片的行数。
- s31：Claude 的只读、读写档不限读（product.md 第 9 节第 20 项）。开工时定挡不挡：候选做法是沙箱的 `filesystem.denyRead` 挡数据目录里的 `bots/` 和根上的凭据，`allowRead` 再放开这一次的记忆目录、`bots/<appId>/skills/` 和评论会话自己的目录，和 e03 一起在 Mac 上测。
- s32：vonvon 不开计划模式，Codex 的提问实际上不会来。这一片主要是不再回报错，不让回合卡住。
- s32 实现：同一条入站队列保留通知与提问的顺序；普通回合按启动 ACK 的线程/回合认请求，目标模式另记所属回合。只支持非敏感、带选项的问题，卡片 id 映射回原问题 id 和选项文字；原文空白和特殊键不丢失。无人回答或问题无法表示时回空答案表，敏感与打字回答仍在 s33。
- s32 实现（审批和清理）：命令/文件审批直接回 `decline`，旧协议回 `denied`，权限配置审批回空的 turn 级权限子集，不出卡、不改 `never`。未知方法仍回 `-32601`。回应前同步领取并移除本地请求；停止、结束、启动失败、EOF、关闭、utility 消费、预热清空及失配都释放。服务端 resolved 通过串行的 `ask_cancelled` 事件撤销对应等待，释放暂停并推进下一张卡，不再回复已被服务端清除的 RPC。目标模式先按所属线程及当前回合过滤生命周期，外部回合不能取消本轮提问。入站迭代器保留 pending read 可取消的行为，不用异步生成器包裹它。
- s32 JP-VPS 验证（2026-10-17，Codex）：新假子进程跑真实传输、client、AgentRun 和提问协调器；结合 JSON-RPC、进程关闭、预热池、恢复和运行卡九文件 197 项通过，daemon build/typecheck 通过。实际回包覆盖五种审批、未知方法、数字/文字请求号、原生答案映射和旧轮隔离。根 build/typecheck/lint 通过；独立审查复现目标外部事件和取消未释放的问题后，新增回归先失败再修复。此前还复现并修复原文空白被改写、特殊答案键丢失、通知 metadata 误判和 pending read 取消问题。未知通知最后三形态回归所在文件 27 项通过，daemon typecheck 通过；独立完整、追加及增量审查已完成，三项发现均已修复。Mac 任务 28 在原准确 head 上的三项真实行为通过，但 EOF fixture 清理失败，不能据此冻结；修后完整平台链仍以最终 head 为准。
- s32 Mac 实测与修复（2026-10-17，Codex）：任务 28 的 CLI 0.162.1 普通产品回合完成且零入站请求；真实命令审批 decline 后完成且可续轮；非空文件系统权限请求收到空 turn 子集，binary 工具结果的 network/file_system 均为空，未增权且可续轮。九文件 199 通过、EOF 一项失败。任务 29 三次独立重现同 UID 僵尸组在 exit 回调前收到 TERM，返回 EPERM，随后 exit0/close 与 ESRCH 到达但错误已记入。管道失败现在同步占定唯一关闭 promise，先释放 peer、提问和事件，按原 EOF 的 500 毫秒等待自然 exit 再调用严格进程树清理；不忽略 EPERM、不改 owner 的后代和错误保证。测试收尾遇错也继续关闭预热进程并汇总错误。新增自然 exit0/7 的真实子进程用例修前两失败一通过，修后三项通过；五文件 66 项、daemon typecheck/build 通过；JP-VPS 随后整仓 build/typecheck/lint 和十文件 210 项均通过。
- s32 Mac 修后重验（2026-10-17，Codex）：任务 30 在 `be7bf0e6fa590c6a74aadcce79c69d8ecd1447be` 新建独立 worktree，本机构建并跑十文件 210/210，通过原 EOF、自然 exit0/7、仍活 child 和真实后代清理；透明诊断观察到 child exit0/close 后才发 TERM、得到 ESRCH 并 close.resolve，原 TERM EPERM 本次未出现。普通产品回合、实际审批 decline 后续轮、空权限工具结果与续轮三项也在同一 SHA 重新通过，产品仍为 never，未操作已装 app 或默认服务。[任务30结果](https://github.com/modelzen/vonvon-bot/pull/377#issuecomment-6232964899)。文档收尾不改源码，完整 Linux/macOS 仍按最终冻结 head 验证后才能合入。
- s32 边界：任务 30 首次全新隔离 CODEX_HOME 的主回合已完成，失败的是同时启动的预热 child（SQLite 初始化、code1），唯一重试的两个 child 均正常；原因尚未归因，不把纯优化的预热失败隐藏成“始终成功”。真实提问选项、敏感/自由文本、飞书显示/通知及其他审批种类未由这次 CLI 检查验收。当前生成问题 schema 没有区分连接器审批来源的字段，不按题目文字猜权限语义，连接器经提问通道的行为也未验收。协议依据及限制见 [本轮补充核对](research/2026-10-17-codex-requests/negative-replies.md)。
- s35：e01 测过，变量有效，不做备选，前提是开工时补测的 ⏹ 没问题。运行卡在这一轮唯一的 result 到达时收尾，子 agent 区用 task_* 消息和 `parent_tool_use_id`（e02 第 4 节）。开工时补测两件事：前台子 agent 跑着时按 ⏹ 多久能停下；设了变量后 Monitor 还能不能用。

- s33–35：扩展既有原生协议夹具，断流、静默流取消、迟到事件、父子交错、待答与停止均走实际 transport/coordinator/reducer/假卡片出口；检查全部预期事件被消费。s35 保留最近 5 步和省略计数、稳定子身份及异常终态，不重写父过程预算策略。

### M7 个性、记忆和多工作区

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s36 | bot 默认和群覆盖的数据，新群自动建目录（总项） | 拆为 s36a、s36c、s36d；三片都完成才勾选。默认档取读写、开网，群覆盖和目录按 3.2、3.3 生效 | — | s21、s36a、s36c、s36d | 数据迁移 | 无 |
| [x] | s36a | bot 执行默认值的存储边界 | `preferences.defaults` 保存后端、模型选择、权限档和网络；注册时初始化读写、开网；配置读写校验该块，旧配置普通读写不补值。尚不改变群或会话的运行参数 | 500 | s21 | 错误路径 | 无 |
| [x] | s36c | 工作区、仓库和新群目录（总项） | 拆为 s36c1 的存储准入和 s36c2 的目录分配接线；两片都完成才勾选，旧 cwd 不搬。新建群时的目录并入 s36d | — | s36a、s36c1、s36c2 | 数据迁移、并发、错误路径 | 无 |
| [x] | s36c1 | 工作区与仓库列表的存储和准入 | bot 和群的原始列表用一份 schema；主目录唯一，仓库只接允许位置的本机 Git 根；读只验结构，改过的块在原存储入口校验真实目录，旧字段不回填，不改变运行参数 | 1100 | s36a | 子进程、数据迁移、并发、错误路径 | 无 |
| [x] | s36c2 | 新 bot 与新群的稳定目录分配（总项） | 拆为 s36c2a 的注册写入归属、s36c2b 的 bot 目录和 s36c2c 的群目录；三片都完成才勾选，旧 cwd 不搬。新建群时的目录并入 s36d | — | s36c1、s36c2a、s36c2b、s36c2c | 数据迁移、并发、错误路径 | 无 |
| [x] | s36c2a | 注册与 bot 注册表的统一写入 | 同一数据目录的所有注册表修改共用内核互斥；网页扫码与终端注册走同一落盘入口，名字在锁内选择，启停按目标修改，删除与刷新凭据核对同次注册身份；为分配创建时目录名建立归属，尚不自动建工作区 | 800 | s36c1 | 数据迁移、并发、关闭清理、错误路径 | 无 |
| [x] | s36c2b | bot 的稳定目录与默认工作区 | 按创建时名字分配不可随改名或主工作区改变的 bot 目录；记录归属与保留/完成状态，已有内容不收编；删除后重注册可复用已证明归属的目录，崩溃留下的歧义拒绝自动处理 | — | s36c2a | 数据迁移、并发、错误路径 | 无 |
| [x] | s36c2c | 新群目录与创建绑定接线（总项） | 拆为 c1 项目写入、c2 绑定幂等与目录准入、c3 已有群稳定目录和 c4 建群操作身份；原目录、重试与旧 cwd 承诺均保留。新建群时的稳定目录并入 s36d，建群结果不明时的恢复移到 v1 之后（owner 2026-10-18） | — | s36c2c1、s36c2c2、s36c2c3、s36c2c4 | 数据迁移、并发、错误路径 | 无 |
| [x] | s36c2c1 | 项目注册表的跨进程写入 | 六类修改在同一状态目录的内核锁内读取、运行回调、校验和发布；入口固定路径和输入，保留异步回调、旧 cwd 与未知字段。只修正常 writer 的丢写，不宣称账号删除或旧布局搬移也已原子化 | 500 | s36c2b | 子进程、并发、关闭清理、错误路径 | 无 |
| [x] | s36c2c2 | 同群绑定幂等与显式工作区准入 | DM 与网页同 chat、同参数在项目表 owner 内原子返回已有绑定，冲突拒绝；创建和绑定新群的显式目录共用准入，cwd 等于声明的主工作区，已有同参数记录原样返回。不提前计作默认群目录完成 | 600 | s36c2c1 | 并发、错误路径 | 无 |
| [x] | s36c2c3 | 已有群的稳定目录与保留恢复 | 按建立时群名在 bot 稳定目录下分配，归属绑定 app/tenant/chat；旧 bot 仅在新绑定默认目录时按需分配；解绑、删除账号后保留证据和内容，旧实例不能向新账号提交。DM/RPC 绑定支持默认目录，开工复核 1500 行上限 | 1200 | s36c2c2 | 数据迁移、并发、错误路径 | 无 |
| [x] | s36c2c4 | 建群操作身份与远端结果恢复（总项，恢复部分移到 v1 之后） | 原拆为 c4a 保留操作记录、c4b daemon 创建入口、c4c RPC/UI 起点与显式恢复。c4a 已合入；c4b、c4c 移到 v1 之后（owner 2026-10-18，见下面的说明），本项按 c4a 勾上 | — | s36c2c4a | 子进程、并发、错误路径 | 无 |
| [x] | s36c2c4a | 建群操作记录与跨进程归属 | 根数据目录保留不可随账号删除的操作身份、输入快照及 prepared/unknown/known/published 记录；复用内核互斥，损坏、容量满或落盘失败时拒绝丢弃证据。先独立验证存储与中断恢复，尚不接入现有建群入口 | 700 | s36c2c3 | 子进程、并发、关闭清理、错误路径 | 无 |
| [ ] | s36d | 群覆盖与执行参数统一生效 | 原始覆盖与生效值分开；按 3.2 算继承，普通回合、`/goal`、云文档入口一起接线；已有会话保留记录的后端，旧权限和 cwd 不变。另并入：新建群（私聊和网页两个入口）也按 s36c2c3 分配稳定目录；建群请求带飞书的 uuid（同一次建群的内部重试复用它，用户手动重试算新请求）、所有请求共用 30 秒总时限，超时或结果不明时告诉发起人"可能已经建好了，先去飞书看一眼再重试"，不做操作号和恢复入口（owner 2026-10-18） | 1000 | s36a、s36c | 数据迁移、错误路径 | 无 |
| [ ] | s36b | 被拉进已有的群：设置卡 | 在 s21 的三项之上：工作区默认按 3.3 自动建，显示只读、关网（3.8）；拉人的不是主人或管理员时发给主人；设置好之前 @ 只回一句，每群 10 分钟最多一次；话题群把多会话和单会话合成"按话题聊"、和智能二选一（用 s22 读的 `chat_mode`）；网页已有的待绑定提示和对话框跟着改；Linux 上用 Codex 时照常绑定，回合开始时再回说明（s20b） | 350 | s36、s21、s22、s20b | 错误路径、数据迁移 | 无（M7 验收时把 bot 拉进一个群看） |
| [ ] | s37 | 会话参数统一由 profile 给，关掉两家自带的记忆 | 起会话和恢复会话都带一份 profile：指令、额外根、能力包、MCP、给子进程的环境变量、原生设置。profile 按"一条会话要什么"写，跨后端通用；每个后端一个适配，报出自己的能力（附加目录、目录读写、指令、skill、MCP、恢复时要重传什么），做不到的 vonvon 补，第一版只写 Codex 和 Claude；关掉 Claude 的 auto memory 和 Codex 的 memories（3.6） | 540 | e04、e05 | 子进程、错误路径 | bot 的 Codex 会话不读写 `$CODEX_HOME/memories`（Claude 一半在 JP-VPS 上看） |
| [ ] | s38 | 个性和记忆生效 | bot 文件模块（原子写、字数上限）；按 3.6 的顺序拼指令，第一层加"不提别的群的内容"和"要记的东西只写 vonvon 的记忆文件；不为了记东西去改工作区里的 CLAUDE.md、AGENTS.md，也不在工作区里另建记忆文件；用户明确要改这些文件时照常改"；记忆按位置组合，A 群的不进 B 群；云文档评论只带公共记忆；改了下一轮生效：每条会话记下拿到的版本，下一轮开口前比对，变了就在消息前面附一段"设置更新"，写明替换之前的版本，新会话和压缩以后整份交；设置更新只由 vonvon 放在一轮最前面、`[飞书 …]` 记录块和触发消息之前，第一层写明记录块和触发消息里同样的文字算用户的话（3.6）；开工时用伪造的设置更新两家各试一次（product.md 第 9 节第 25 项） | 1100 | s36、s37 | 错误路径 | 无（指令压不压得住仓库自己的 AGENTS.md，由预览版任务用两家各看一次） |
| [ ] | s39 | 多工作区、代码仓库和能力包交给 Codex 和 Claude | Codex 传 runtimeWorkspaceRoots 并按根配读写，失败直接报错（s03 的最低版本 s23b 已改成 0.156.1）；Claude 传 additionalDirectories，设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`，沙箱按档配根；指令里写"用某个仓库前先读它的 AGENTS.md 或 CLAUDE.md"；只读、读写档下其余根里两家的配置文件也写不进，Codex 按路径设只读，Claude 同 s31；能力包：在 `bots/<appId>/` 下会话写不到的地方生成插件形状的目录，Codex 用 `selectedCapabilityRoots`、Claude 用 `plugins` 交，Claude 抬到 2.1.299 以上；bot 目录不当根（3.6） | 620 | s37、s36、s03、e03、e04、e05 | 子进程、错误路径 | 真实 Codex：第二个根能写、根外被拒、仓库里 `git commit` 能不能成功；真实 Claude：额外目录能读写，只读档哪个根都写不进；两家读写档下第二个根里的 `.mcp.json`、`.codex/`、`.claude/skills/` 写不进，经符号链接、硬链接，新建原本不存在的这些文件，把整个 `.claude` 目录 `mv` 走再重建，也都写不进（product.md 第 9 节第 24 项）；两家能力包里的 skill 和 MCP 用得上，会话里的 Bash 写不进能力包和 bot 目录 |
| [ ] | s40 | 说"记住"就写进记忆，卡片上能撤销 | agent 直接写自己那份记忆，daemon 一轮前后比对，卡片显示"已记到本群记忆：…［撤销］"；超上限回滚；这份记忆所在的目录每一档都放行写：Codex 在权限配置里按路径给写权限，不加进 runtimeWorkspaceRoots（multi-workspace 调研 3.6 的 Q8e），Claude 另用 canUseTool 对它放行 Read、Edit、Write，按解析过链接的真实路径判断（允许规则做不到）；公共记忆哪里都不放行；daemon 只读那一个文件，不跟随链接，不是普通文件、硬链接数不是 1 或超过大小上限就不读、记日志、回滚，回滚和撤销写新文件再 rename，rename 失败（比如 `group.md` 被换成目录）就把原来那个挪到会话写不到的 `bots/<appId>/quarantine/` 再 rename、记日志，不删，每份记忆最多留 3 个（只数 daemon 挪进去的），满了就不写回、卡片说明、诊断页提示清理；两条会话同时写同一份记忆时，daemon 在这几轮期间盯着文件、尽量留下读到的每一版，一轮结束时以行为单位按 diff3 三方合并（基准是这一轮开始时，相同的改动只算一次；怎么认出哪一版是哪条会话写的、按哪几版合，开工时定，守住 product.md 3.6 列的几条保证），两边新增的都留，别的会话还在跑时［撤销］等它结束再点，合并后超上限也不回滚，卡片写"和另一个会话同时改过，已合并"（本文第 5 节）；写了以后，用同一份记忆的其他会话下一轮按 s38 附"设置更新"（3.6） | 460 | s38、s39、s31 | 并发、错误路径 | 只读档下 agent 能写记忆文件、写不到别处；记忆目录里建指向别处的符号链接、硬链接和 FIFO 时 daemon 不跟、不卡住，经链接用 Edit 写 `../SOUL.md` 被拒；同群的主区和话题两条会话同时各记一行、各删一行，合并结果符合 product.md 3.6 列的保证，另一条还在跑时撤销不生效（"已记到本群记忆"的卡片 Claude 用 lark-cli 读，撤销 M7 验收时 owner 点） |
| [ ] | s41 | Bot 页：个性、规矩、智能提示词、记忆、工作区和仓库 | 编辑 SOUL.md、AGENTS.md、SMART.md（完整显示内置默认值，能恢复默认；程序附的格式行只读显示）、判断模型、工作区、代码仓库和公共记忆（3.1 第 6 条、3.4） | 600 | s36、s38、s23d | — | 无（目录选择器在 M7 验收时看） |
| [ ] | s42 | 群详情页的覆盖项 | 个性补充或替换、工作区和仓库、本群记忆、智能提示词、判断模型、权限档、网络、后端和模型的覆盖（3.2） | 420 | s41 | — | 无 |

开工要点：
- s36：群没设工作区时只用群自己的目录，不带 bot 的其余工作区，代码仓库照常继承（本文第 5 节）。仓库只收本机已有、带 `.git` 的目录。工作区和仓库只收数据目录以外或它的 `projects/` 下面的目录，不收数据目录的上级（product.md 3.6）。旧项目的 cwd 原样当作主工作区覆盖，不搬目录。
- s36 拆片（2026-10-17，Codex）：先交付 s36a 的配置存储契约，再做目录分配和群执行入口；`s36b` 仍是原来的入群设置卡。s36a 的默认值尚不交给 provider，不能据此勾选总项。个性、规矩、记忆和 skill/MCP 文件继续由 s38、s39、s44 等片负责，不在 defaults 块再存一份。
- s36c1 范围（2026-10-17，Codex）：先建立 `preferences.directories` 和群的 `directories` 存储边界；工作区用主目录与附加目录，缺省和仓库空列表分开。普通加载不查磁盘或改目录，保存只对实际改过的块核对真实路径和本机 Git 根，未改过的挂载失效不妨碍无关设置保存。未知旧字段与 cwd 保留；尚不分配新目录、不传 provider 多根，也不实现完整群执行继承。s36c2 的跨进程分配和恢复仍待实现，不能提前勾选总项。
- s36c1 JP-VPS 验证（2026-10-17，Codex）：真实临时目录、符号链接、Git 根和 linked worktree 验证准入；七文件 98 项、daemon build/typecheck、根 build/typecheck/lint 全部通过。独立完整及子进程、并发、错误追加审查复现 Git 直接子进程超时后后代仍占 stdout、保存队列超过 6.5 秒未返回；改成每次校验独占进程组、5 秒独立期限和完整收尾，真实 helper 回归先失败后通过。独立重跑该回归通过，另用注入 EPERM 核对拒绝有界、错误不泄漏输入。只对改过的列表查磁盘，旧配置修复保存、排队快照、CAS、未知元数据和群 cwd/主目录一致性均有行为覆盖；完整平台链以准确 head CI 为准。
- s36c2a 范围与验证（2026-10-17，Codex）：真实隔离模块复现并发添加时一个调用成功、另一个报 ENOENT，成功的那条却丢失。所有注册表写入现经同一个私有排队与现有内核互斥，第一次修改先保留旧单 bot 数据，再选唯一名字并共享账号落盘；旧整表覆盖接口已删除。新注册带独立身份，旧记录读取不回填；启停只改目标，删除和已验证凭据的提交共用归属并核对身份，失败不假称回滚或删除成功。实际子进程覆盖同时注册、同 app 只落一次账号、别名争用、SIGKILL 后恢复、回调失败和旧数据保留；本地屏障覆盖删除/刷新和旧身份拒绝，网页与终端入口验证管理员、偏好和默认值一致。七文件 125 项通过、1 项既有平台跳过，daemon build/typecheck 通过；完整平台链以准确 head CI 为准。跨进程保证限于遵守同一规则的新版进程；多文件失败可能留下部分账号数据，旧文件搬移的崩溃恢复未改变。目录分配、稳定 DM/RPC 操作号与完整执行继承仍未实现，不能勾选 s36c2/s36c/s36 总项。
- s36c2b 范围（#381，2026-10-17，Codex）：新注册在 `bots.json.allocations` 保留 app/tenant 的稳定目录、创建时句柄与 reserved/ready 证据，缺省工作区声明为该目录；显式工作区、仓库缺省/空列表和旧 cwd 保留。删除账号不删账本或工作区，同 app/tenant 再注册只复用当前身份匹配的 ready 目录。旧 bot 的读、启停、刷新与重复注册不分配、不回填；群目录和 provider 执行继承仍待 c2c/d，不能勾总项。账本采用根注册表同一写入 owner，替代未实施的 per-bot 记录方案，无第二套 claim 扫描或删除保留子树。
- s36c2b 验证与边界：真实临时文件和子进程覆盖注册、删除重注册、并发名字、五个 SIGKILL 边界、同步/rename 故障、旧失败父链重试和已替换目录拒绝；实现五文件 80 项、最终目录 26 项、主会话补充五文件 114 项通过（范围有重叠，不相加），根 build/typecheck/lint 通过。首次完整 Linux CI 暴露扫码注册测试 mock 缺少默认项目根目录，4 项失败；只补齐隔离路径后原 14 项断言全部通过，未放宽产品校验。根注册表读取新增 4 MiB、普通单链接文件和 4096 条分配记录上限，符号链接、硬链接或坏账本拒绝，不丢证据自动清理。dev/inode 是合作环境观察，保留 inode 重用/敌意替换限制；reserved+目录已存在拒绝接管。同步相关链到从不由程序创建的既有顶层祖先，不宣称硬件断电保证；账号多文件仍可能部分成功，配置比较不是跨进程原子 CAS。完整 Linux/macOS 结果以 PR 准确 head 为准。
- s36c2c 拆片（2026-10-17，Codex，按 owner 要求改用 gstack）：源码核查发现群目录接线还需要项目表统一写入、绑定重试、删除保留和建群未知结果恢复，完整范围难以在单片 1500 行内审查。先交 c1 的实际丢写修复，其余承诺保留在 c2–c4；总项不提前勾。原 M7 的 13 个叶子因本项拆成四片变为 16 个，拆片本身不增加完成数。
- s36c2c1 实现范围（#382，2026-10-17，Codex，gstack）：六类项目表修改复用同一内核 owner，锁住读、异步回调、目录校验与 rename；排队前固定状态路径与可变输入。8 个独立进程的强制竞争先复现成功返回却丢 7 行，修后全部保留；10 项 writer 回归、相关 88 项测试和 build/typecheck/lint 已通过。独立审查和准确 head 的 Linux/macOS CI 仍按 PR 门禁完成。不包含旧版本/手工写入、账号删除重建或旧布局搬移的原子性，也不宣称断电持久性；群绑定、目录和建群恢复仍待 c2–c4。
- s36c2c2 实现范围（2026-10-18，Codex，gstack）：已知群的同参数绑定在同一项目表 owner 内判定，只有首次保存者准备目录并发送欢迎，私聊和网页共用业务入口；网页成员身份检查照旧执行。新创建和新绑定的显式工作区经既有准入后写入 canonical cwd 与主目录声明，非法路径在远端建群前拒绝。旧记录重试不重写、不补目录、不覆盖操作者或设置；默认目录仍按原 root/name，仅重复绑定不再 mkdir。跨进程竞争、混合入口、冲突、旧记录、路径拒绝与创建请求重启重试由隔离夹具验证，独立审查和准确 head 的双平台 CI 仍按 PR 门禁执行。崩溃后的欢迎投递、远端建群未知结果、稳定默认群目录及旧 cwd 迁移不在本片保证内。
- s36c2c3 实现范围（2026-10-18，Codex，gstack）：已有群的默认工作区分配到 bot 稳定目录的 `groups/<建立时群名>`，根注册表保留 app/tenant/chat 的容器和群目录归属，解绑、账号删除与同账号重注册不删证据或内容；旧 bot 仅在新绑定默认目录时按需分配，已有同参数旧记录不重写。DM 与网页/RPC 共用绑定入口，网页可选新建空白目录或现有目录，CLI 保持显式目录。启动时捕获注册身份，绑定在根注册表到项目表的 owner 顺序内核对，待绑定清理也在该身份作用域内；旧实例不能向新注册账号绑定。真实子进程覆盖保留恢复、同名碰撞、未知容器拒绝、三处 SIGKILL 和竞争 writer；损坏账本拒绝且原字节保留。显式目录、欢迎失败和待绑定语义沿用 c2；欢迎投递不保证崩溃后恢复，reserved 加已有目录仍拒绝自动接管，不宣称敌意替换或硬件断电保证。本片勾选只表示实现完成，不代表 M7 完整验收通过；真实 Mac 界面检查、独立审查和准确 head 双平台 CI 仍待按 PR 门禁完成。建群默认目录和稳定远端操作身份仍待 c4，s36c2c/s36c2/s36c/s36 总项不提前勾选。
- s36c2c4 拆片（2026-10-18，Codex，gstack）：核对[飞书去重合同](research/2026-10-18-feishu-creation/uuid-contract.md)后，先交保留操作记录，再同时迁移 daemon 两个创建入口，最后交 RPC/UI 的持久草稿和显式恢复。每片仍以 1500 行为上限；M7 从 16 个叶子变为 18 个，拆片本身不增加完成数。原 c4 的全部承诺保留，未知结果不按时间过期后重新建群，c4 及上层总项不提前勾选。
- s36c2c4a 范围与验证：`creation-operations/<操作键哈希>/operation.json` 在 bot 数据目录外保留账号、操作者、语义输入签名、稳定远端 uuid 与单向状态；同操作共用真实内核 owner，其他操作和根注册表可继续写。记录最多 4096 项、不自动淘汰；读取有大小、单链接普通文件与 schema 校验，损坏保留原字节。写入先同步文件再 rename、同步目录，重开已有目录也同步其父项；写失败后当前 owner 不能继续，必须重开读取实际状态。真实临时文件与子进程验证重开、同参数不改字节、冲突、旧注册快照、SIGKILL、竞争、容量、落盘失败及回调抛错的收尾；三文件 74 项通过，1 项既有 macOS 专属用例留待平台 CI。新增父目录同步回归修前为 Missing expected rejection，修后通过。尚无生产调用，不代表远端建群、认证恢复或 M7 验收完成；整仓 build/typecheck/lint、独立审查和准确 head 双平台 CI 仍按本片门禁完成。不宣称敌意目录替换或硬件断电保证。
- s36c2c4b、s36c2c4c 移到 v1 之后（owner 2026-10-18）：Claude 接回后数了一下，s36 从一片拆成 11 片，合了 8 片约 4,500 行，全是存储、跨进程写入和崩溃恢复，M7 用户能看到的个性、记忆、多工作区还没开始；c4b、c4c 再要约 2,600 行，解决的是建群请求结果不明时的操作号和恢复入口，product.md 没有这项承诺；飞书对带 uuid 的建群请求有 10 小时去重窗口，但不保证重复请求返回原群号，也没有按 uuid 查询的接口（`docs/research/2026-10-18-feishu-creation/uuid-contract.md`）。owner 选了"停掉，转做看得见的"。用户能看到的那部分（新建群也用稳定目录）和最小保护（uuid、30 秒总时限、结果不明时的提示）并入 s36d；c4b1 已写的分支 `claude/s36c2c4b-creation-owner`（3eea272，没开 PR）留作参考，s36d 可以取它的限时 SDK client。c4a 的 `creation-journal.ts` 留着，暂时没有调用者。原 c4b、c4c 的范围记在 product.md 第 10 节。M7 因此从 18 个叶子回到 16 个，其中 8 个已完成；上面 s36c2c3 和 c4 拆片两条说的"总项不提前勾选"不再适用。
- s36a 做法：`config/defaults.ts` 从一份 Zod schema 推导类型，模型记录区分列表选择和手填，推理强度随模型保存；未选择的后端和模型不写 null。普通加载和保存不补默认值；注册构建配置时（也包括恢复已有 preferences）初始化缺省的读写、开网。保存先固定并校验将写的内容，再走现有串行写入和并发修改检查；不合法的值在建目录或覆盖文件前拒绝，错误不带配置原文。`load → 改无关偏好 → save` 保留未知旧字段，不承诺重新注册重建配置时保留任意顶层元数据。
- s36a JP-VPS 验证（2026-10-17，Codex）：`bot-defaults` 和 `register-bot` 两份定向测试共 54 项、daemon typecheck 通过；覆盖缺省旧配置不改盘、注册初始化、模型和自定义后端保留、无效保存不覆盖、排队写快照、并发修改拒绝后可恢复，以及显式路径的多 bot 隔离。完整平台链以 PR 准确 head 的 Linux/macOS 结果为准。
- s37：给子进程的环境变量在这一片定下，s46 的令牌也走它，所以 e04、e05 要先做完。
- s37：e05 实测，profile 在 `thread/start` 和每次 `thread/resume` 都要整份重传：`runtimeWorkspaceRoots`、`mcp_servers`（含禁掉用户的全局 MCP）、`skills.config`、`skills.bundled`、`projects.<cwd>.trust_level`，以及 memories 的两个键加 `features.memories: false`。memories 这三个 resume 后保不保留没查清：只带 cwd resume 后那一轮没重新注入记忆，`memory_mode` 和整合任务没单独查，按保险重传。只关两个键时，用户开着 memories 的话，bot 会话的第一轮仍会用 bot 的配置起一次全局整合任务，花主人的额度。不重传时用户的 MCP 和个人 skill 会悄悄回来。bot 的 skill 和 MCP 改由能力包交（s39），不再用进程级的 `skills/extraRoots/set`，预热池的进程也不用在取出后单独调。
- s37：resume 时传新的 `developerInstructions` 不生效（e05，4 个版本）；Claude 的 `systemPrompt.append` 也在第一次请求时定住，恢复时传新的被忽略（2.1.296、2.1.301 实测，multi-workspace 调研 4.3）。所以改过的个性、群的 `SOUL.md` 和记忆，按 product.md 3.6"改了什么时候生效"在下一轮消息前面附"设置更新"，归 s38。
- s37：今天的 `thread/start` 会把 bot 的工作区写进用户 `config.toml` 的信任记录（e05），和 3.6"不改用户的全局配置"不符。会话层传 `projects.<cwd>.trust_level` 就不写；`untrusted` 会跳过主工作区的 AGENTS.md 和项目配置，skill 照样加载；要加载 AGENTS.md 就传 `trusted`。但 `trusted` 还会加载主工作区 `.codex/config.toml` 里的 `developer_instructions` 和 MCP（app-server 0.163.0 实测，multi-workspace 调研 3.2；hooks 和 exec policy 是读源码），会话层没覆盖的设置会被它们改掉，比如多出 MCP；附加的根标了 `trusted` 也不加载项目配置；信任不随恢复保留，每次恢复都传；开工时定怎么处理，连同 product.md 3.3、3.6 里主工作区的 `AGENTS.md` 和 MCP 加不加载。拼错的字段和配置键都被静默忽略，实验字段生没生效要自己核对：`runtimeWorkspaceRoots` 看回包回显，MCP 看 `mcpServerStatus/list`，skill 看 `skills/list`。会话层信任时 `mcpServerStatus/list {threadId}` 不列主工作区项目配置里的 MCP，模型却有这些工具（实测），核对时别当成没起来。
- s39：按 e05 把最低版本抬到 0.156.1（见 s03 留下的），s23b 已改。起会话和恢复会话都传 `runtimeWorkspaceRoots`，不靠 0.156.1 起 resume 会保留它；回包回显的和传的不一致就报错。第二个根能写、根外被拒、`.git` 只读时 `git commit` 会不会失败，JP-VPS 上只在宽松的 `:root` 读档下测过：第二个根能写，`git commit` 失败（`.git/index.lock` 只读）；vonvon 真用的 `:minimal` 读档 bwrap 起不来，只在 Mac 检查里看（multi-workspace 调研 3.6）；macOS 上 `feishu` 权限配置加 `runtimeWorkspaceRoots` 时经沙箱读 AGENTS.md 正不正常，也一起看。第二个根里的 AGENTS.md 两家都不会加载（e05，bot-home 调研 B1），Claude 默认也不读那里的 CLAUDE.md。owner 2026-10-16 定（2A）两样都做：照 3.6 在指令里写"用某个仓库前先读它的 AGENTS.md 或 CLAUDE.md"；Claude 再设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 原生加载 CLAUDE.md（调研 B2 实测）。这个变量对所有附加目录生效，不受 `settingSources` 管，要排除某个目录用 `claudeMdExcludes`（multi-workspace 调研 4.2）。
- s39 能力包（owner 2026-10-16 定，1A；product.md 3.6）：
  - 目录：插件清单（`.claude-plugin/plugin.json`，Codex 也认）加 `skills/`、`.mcp.json`，按每个位置的生效名单生成在 `bots/<appId>/` 下，具体目录这一片定，不能在记忆目录、工作区和临时目录里。这一片先把 bot 自己的东西放进去，s44 接上库里的名单。
  - Codex：`thread/start` 的 `selectedCapabilityRoots: [{id, location: {type: "environment", environmentId: "local", path}}]`，实验字段，只在 0.163.0 测过：按线程、带 MCP、恢复后保留，不要特性开关；只能在 `thread/start` 给，`turn/start`、`thread/resume` 都没有这个字段，新进程恢复时重读包的内容（multi-workspace 调研 3.3，H5 到 H8）。先在最低版本 0.156.1 上测，不行就把最低版本抬到测过能用的版本，连同 s03 的常量。生没生效用 `skills/list` 和 `mcpServerStatus/list {threadId}` 核对，H5 到 H7 里两样都列得出。
  - Claude：SDK `plugins: [{type:'local', path}]`，起会话和恢复都传。2.1.296 有沙箱里的 Bash 能写插件目录的洞，2.1.299 修了：把 SDK 抬到带 2.1.299 以上的版本（2026-10-16 最新是 0.3.301，带 2.1.301），改 `D/agent/catalog.ts:31` 和 `packages/daemon/package.json`；抬不了就保证会话写不到能力包。
  - 开工时测：工作区 `.claude/settings.json` 里写 `"<插件名>@inline": false` 能不能关掉 vonvon 的插件（文档说能），能关就定对策（product.md 第 9 节第 22 项）。
  - bot 目录不当根：Codex 实测当根就整个可写，加只读条目也盖不住（multi-workspace 调研 3.6）。
- owner 2026-10-16 定：会话照旧从工作区起，不从 bot 自己的目录起。bot 的东西只在 `bots/<appId>/` 下由 vonvon 交给会话，vonvon 不往工作区写文件；私聊记忆改成一人一个目录 `memory/dm/<open_id>/dm.md`，这样能只放行这一份：s40 定放行的做法，s49 起私聊会话时按它放行这个人的 `memory/dm/<open_id>/`；bot 自己的 skill 放 `bots/<appId>/skills/`，s44 放进能力包交给会话（product.md 3.3、3.6；调研 `docs/research/2026-10-16-bot-home/`）。
- s31、s39：只读、读写档下 agent 不能写各个根里两家会原生加载的配置：`.mcp.json`、`.claude/settings.json`、`.claude/settings.local.json`、`.claude/skills/`、`.claude/commands/`、`.claude/agents/`、`.codex/`、`.agents/skills/`，只有完全访问档能改，见 product.md 3.6（owner 2026-10-16 问过，待回复时再改）。一起问的还有附加的仓库里的 MCP 要不要加载：今天两家都不加载附加目录里的 MCP，主工作区的 `.mcp.json` 经 SDK 不问批准就拉起、跑在沙箱外（Claude Code 2.1.296、SDK 0.3.296 实测）。Claude 一侧用沙箱的 `filesystem.denyWrite` 加 `Edit(...)` 拒绝规则：e02 只测到 `.claude/` 下的写在读写档的 `acceptEdits` 下也走回调，其余几处没测，所以不靠回调；s31 管主工作区，s39 管其余根。Codex 在权限配置里按路径设只读，归 s39。拒绝规则按工具收到的路径匹配，先建指向这些文件的符号链接、硬链接再写链接能不能挡住，新建原本不存在的这些文件、把整个 `.claude` 目录挪走再重建能不能挡住，两家都没测，开工时测，Claude 在 s31、Codex 在 s39（product.md 第 9 节第 24 项）。`CLAUDE.md`、`AGENTS.md`、`.claude/rules/` 故意不挡，理由见 product.md 3.6。
- s40：product.md 没定写入方式。这里选"agent 直接写文件，daemon 前后比对"，不在群里另开记忆命令，和 3.7"群里不能用设置命令"一致。公共记忆只在私聊里由 s54a 的设置命令写。

- s38–40：记忆来源、范围和版本从真实记录得出，不猜未捕获的写入者；核对字数和 UTF-8 大小但不静默截断，不改并发超限保留规则。失败不得报已记住，撤销保留并发约束。s41/s42 覆盖脏草稿、版本冲突、保存失败后可继续编辑。

### M8 skill、MCP 和查飞书上下文（s43、s44a/b、s45–48）

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s43 | 本机 skill 库和 MCP 库 | skill 从三个目录或本机文件夹拷进来，校验 SKILL.md，记下带不带脚本；MCP 从 Codex、Claude 的配置导入或手填；都不收 git 地址（3.6） | 970 | s38 | 错误路径 | 无 |
| [ ] | s44 | 能力包与个人能力隔离（总项） | 拆为 s44a 基础隔离、s44b 用户库组合；两片完成才勾，原范围全部保留 | — | s44a、s44b | 子进程、错误路径 | 真实检查分别在两叶子执行 |
| [ ] | s44a | 新 bot 的基础原生隔离与内置能力包边界 | 新 bot 不带 Claude 个人指令和两家个人 skill；Codex 个人 AGENTS.md 保留并声明 bot 规矩优先，导入 bot 不变。沿 s39 唯一能力包路径选择来源，包不能被会话篡改；尚未实现的设置/飞书工具不提前放入 | 500 | s37、s39、e02、e05 | 子进程、错误路径 | 两家新开、重开和 resume 不恢复个人 skill；新 bot 不读 Claude 个人指令，Codex 个人 AGENTS.md 冲突按 bot 规矩；包写入受限 |
| [ ] | s44b | skill/MCP 名单组合与原生交付 | 用户库和 bot 自有 skill 按位置组合、群增减、MCP 交付和恢复；扩展 s39/s44a 同一包生成器。名单改了按 3.6 生效，不覆盖内置包 | 650 | s44a、s43 | 子进程、错误路径 | 真实 Codex 用 bot skill、MCP 在 never 下调通且 resume 仍在；Claude 名单/恢复和 MCP 调用；原 s44 的其余真实能力项全部保留 |
| [ ] | s45 | skill 和 MCP 页面，bot 和群的启用名单 | 两个库页面，删除时列出还在用的 bot 和群；Bot 页的启用名单，群详情页的增减；Bot 页和群详情页也列出 `bots/<appId>/skills/` 里的 skill，群里能移除（3.2、3.6） | 550 | s43、s41、s42 | — | 无 |
| [ ] | s46 | 会话令牌和 agent 调 vonvon 的入口 | 每条会话一个令牌，经环境变量交给 agent；host 加一个只接 POST 的路由，子进程依次校验令牌、私聊、触发人、开关（3.7） | 520 | s37、e04 | 子进程、并发、关闭清理、错误路径 | agent 调不调得到 vonvon、带不带得上令牌：Codex 只读、读写、关网各一次，Claude 沙箱一次 |
| [ ] | s47 | vonvon settings 和 vonvon feishu 命令行框架 | 在 s07a 的命令上加：两组命令从环境变量读地址和令牌，不拿数据租约，输出 JSON；飞书组先做群列表和群成员（3.7） | 380 | s46、s07a | 错误路径 | 无 |
| [ ] | s48 | vonvon 飞书 skill：列话题、读另一条会话、读飞书消息 | 列本群话题、按会话 id 读另一条会话、按话题或时间读消息；只放行同一个 bot、同一个群、档不高于自己的会话；卡片写"读了话题 T1、T2 的会话"（3.5"查飞书上下文"） | 950 | s47、s44b、s13、e02、e11 | 子进程、错误路径 | 无（M8 验收前，预览版任务按 3.5 时间线第 7 步跑一遍） |

开工要点：
- s44a：`~/.codex/AGENTS.md` 按会话关不掉（e05，4 个版本；会话层 `project_doc_max_bytes: 0` 只关项目里的那份）。owner 2026-10-15 定（选了 A）：接受，带上它，在 bot 的指令里声明 bot 的规矩优先；product.md 3.6 已跟着改。`thread/start` 回包的 `instructionSources` 列出实际加载的文件，可以显示在桌面端。
- s44b（MCP）与 s44a（个人 skill 隔离）：bot 的 MCP 在 `feishu` 权限配置（`approvalPolicy: never`，工作区可写）下不配 `default_tools_approval_mode: "approve"` 时调用被拒（e05，0.162.1，只见过一次），和第 9 节第 2 项的推断一致；只读档和完全访问档不配会怎样没测，开工时补测。bot 的 MCP 改进能力包以后，包里的 MCP 在 `never` 下会不会被拒、能不能配 `approve` 也没测（product.md 第 9 节第 21 项），一起测；被拒又配不上，bot 的 MCP 改走会话层的 `mcp_servers`，只有 skill 留在能力包里。用户的个人 skill 先 `skills/list` 列出，再用 `skills.config` 逐个禁；系统 skill 用 `skills.bundled.enabled: false` 关。带 cwd 的 `skills/list` 也会列出工作区的 `.agents/skills`、`.codex/skills`（bot-home 调研 B1），按名字禁还会连同名的 bot skill 一起禁，所以只禁用户层的，按 scope 或 `path` 禁，不按名字禁；协议里有 `SkillScope`（`user`、`repo`、`system`、`admin`）。按 `path` 禁没实测，开工时补测。能力包在 `thread/start` 时定，名单改了，等下一条会话，或者进程重开后 `thread/resume`，新进程恢复时重读包的内容（multi-workspace 调研 3.3，H8）。e05 测的"中途换 skill 名单从 0.148.0 起下一轮生效"是进程级的 `skills/extraRoots/set`，不再用。Claude 带着插件恢复时，新加的 skill 会通知，移除的和改了描述的不通知（multi-workspace 调研 4.3）。
- s44a：Claude 一侧按 e02 第 6 节：新建的 bot 用 `claudeMdExcludes`（经 `options.settings` 传）或只给 `settingSources: ['project']`，导入的 bot 照旧。`skills` 白名单是 `string[]` 时会把工作区 `.claude/skills` 里的 skill 一起滤掉（SDK 0.3.296 实测，init 的 `skills` 里仍列着），白名单还会滤掉工作区的 command（multi-workspace 调研 4.3）。所以 vonvon 起会话前自己扫主工作区和附加目录的 `.claude/skills`、`.claude/commands`，把扫到的也加进白名单：白名单在起会话时就要传，init 消息在那之后才到。新 bot 只给 `settingSources: ['project']` 的话，个人 skill 可能本来就不加载（没测）。这一片测了再定：不加载的话可以不传白名单，也就不用扫目录（product.md 3.6）。
- s44a/b、s54a、s48 共用 s39 能力包生成路径。基础隔离先于 s49；内置设置 skill 的内容和 DM/开关过滤归 s54a，飞书 skill 内容归 s48，用户库组合归 s44b。各入口只列已交付命令，不另建 profile 或打包器，不把令牌拼进提示词。
- s46：变量名避开 TOKEN、KEY、SECRET，Codex 默认会滤掉含这些词的变量。e04 证明连不上时，按 product.md 第 9 节第 2 项的退路，把同一组命令做成 vonvon 自己的 MCP 工具，这一片照那个做。
- s48：飞书 skill 的 SKILL.md 随 daemon 包发，每个会话都装。
- s48：读 Codex 的会话按 e11：用常驻的 utility 进程发 `thread/turns/list`，带 `itemsView: "summary"`，服务端只留用户消息和 `phase: "final_answer"` 的回答；按 `nextCursor` 翻页，要最近几轮就用默认的 `desc` 加 `limit`。不用 resume、不花额度、不传 cwd。`thread/read` 带 `includeTurns: true` 在 0.162.1 上已标过时，`thread/items/list` 读不了旧格式，都不用。今天的 `mapTurn`（`D/agent/codex-appserver/backend.ts:723`）把 commentary 也拼进回答，不能直接复用；仓库里生成的协议比 0.162.1 旧，没有 `ThreadTurnsListParams`、`TurnItemsView`，按 s03 定的版本重新生成或手写这几种类型。今天的 `readHistory`、`readSessionTitle`（`backend.ts:597-641`）也用 `thread/read`，每次多一条 `deprecationNotice`，顺手换掉。
- s48：e11 读到的几种特殊情况：正在跑的会话最后一轮显示 `interrupted`、只有用户消息，和真被打断的一样，utility 进程看到的状态永远是 `notLoaded`，所以按 daemon 自己的记录写"这一轮还在进行"；还没跑过回合的会话报 `thread not loaded`，和 id 不存在的错一样，s13 登记表里有的按空会话返回；压缩单独算一轮、条目为空，跳过；`status` 不是 `completed` 的轮单独标出。
- s48：读 Claude 的会话时，把那条会话记下的 cwd 作为 `dir` 传给 `getSessionMessages`，自己滤掉工具步骤、思考块和合成的通知条目；子 agent 的消息不在里面（e02 第 5 节）。

### M9 私聊（s49、s50、s51a–c、s53、s54a/b、s55、s56a/b、s57）

原 s52 并进了 s51a 到 s51c，编号 s52 不再使用。本轮 s54/s56 保留为总项，叶子增为 12 项，完成数不因拆片增加；s44 拆分后 M8 为 7 个叶子，s23c/d 拆分后 M5 为 15 个叶子。s56a/b 从原设置范围前移实际 writer 与撤销，s54a/b 复用，不重复实现。只导出无人调用的公共组件不能勾完成；实际超 1500 行时按命令族重切并更新编号/统计。

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [ ] | s49 | 主人和管理员私聊直接干活 | 私聊走单会话的回合路径，用 bot 的主工作区、名单和默认档；私聊里能 `/new`、`/resume`；私聊里的话题单独成会话；这个人的私聊记忆目录 `memory/dm/<open_id>/` 每一档都可写，按 s40 的做法放行（第 4 节、3.5、3.6） | 500 | s37、s36、s38、s40、s44a、e10 | 并发、错误路径 | 无（M9 验收时看主人和另一个管理员各有一条会话） |
| [ ] | s50 | 陌生人私聊卡片和私聊设置页 | 不是管理员的人私聊，回"在群里 @ 我"并列出共同的群；设置页能改私聊用的工作区、skill、MCP、权限档、后端和模型（第 4 节） | 520 | s49、s44b、s45 | 错误路径 | 无（陌生人收到的卡片和群链接，M9 验收第 2 步由 owner 请同事看） |
| [ ] | s51a | 拿掉私聊控制台（一）：菜单和运维卡 | 删私聊首页菜单（含"安装桌面版 · Windows x64"按钮）、bot 菜单事件的路由和引导文案里的 menu_v6，以及体检、重连、重启、更新、用量和分享这些私聊卡（第 4 节） | 900 | s49 | — | 无 |
| [ ] | s51b | 拿掉私聊控制台（二）：项目和权限卡 | 删新建项目、项目列表、话题、删除确认、项目设置、权限、默认模型、白名单、管理员这些私聊卡；被拉进群时的设置卡留着（3.4、第 4 节） | 950 | s51a、s36b | — | 无 |
| [ ] | s51c | 拿掉私聊控制台（三）：设置卡 | 删全局设置、语音、云文档评论、会话标题、看门狗和完成提醒这些私聊卡和它们的测试（第 4 节） | 950 | s51b | — | 无 |
| [ ] | s53 | 飞书应用的所有者、管理员和开发者都能管 bot | 开了 self_manage 时读所有者和协作者名单，缓存 10 分钟；管理员判断读"飞书名单 ∪ 扫码人 ∪ 本机名单"；设置页标出来源（第 6 节） | 640 | s01 | 并发、错误路径 | 开了 self_manage 的测试 bot 在真实租户里读出所有者和协作者 |
| [ ] | s54 | 私聊文字与能力设置（总项） | 拆 s54a 文字设置、s54b 能力设置，复用 s56a/b 的真实提交路径；两片完成才勾 | — | s54a、s54b | 并发、错误路径 | 真实调用按两叶子执行 |
| [ ] | s54a | 私聊改个性、规矩、判断设置和记忆 | 复用 s56a 的 SOUL writer/undo，补齐 AGENTS、SMART、判断模型和三种记忆；只限本 bot。内置设置 skill 只交授权 DM；含默认开启的聊天设置开关及桌面/网页紧急关闭入口。每个写入口同时交回执/撤销，判断设置未过前不勾本项 | 850 | s47、s49、s38、s39、s40、s44a、s56a、s23d | 并发、错误路径 | 预览版中真实 Codex/Claude 各调一次，验证鉴权、下一轮生效、回执和撤销 |
| [ ] | s54b | 私聊管理 skill/MCP 能力 | 复用 s43/s44b 与 s56b 的实际名单 writer/undo，接聊天启用名单和已支持的本机导入入口；不加 Git 安装/连接器市场，保留扩大能力标记和原生生效时机 | 500 | s54a、s43、s44b、s56b | 并发、错误路径 | 两家真实调用，名单只在正确位置和生效时机起作用 |
| [ ] | s55 | 私聊里改工作区、模式和权限档 | 设置命令加仓库和工作区、会话方式和免 @、权限档和网络（3.7） | 300 | s54a、s36、s56b | 并发 | 无 |
| [ ] | s56 | 回执、撤销与扩大能力标记（总项） | s56a/b 基础 writer 与 s54a/s54b/s55 的完整修改、回执和撤销都集成后才勾；不能只靠公共类型/helper 完成 | — | s56a、s56b、s54a、s54b、s55 | 并发、错误路径 | 对应真实设置路径验收 |
| [ ] | s56a | SOUL 实际修改与文字设置回执/撤销 | 交付本机授权 settings RPC/CLI 的 bot 默认 SOUL 读取、修改、撤销，实际文件 writer 输出目标、前后值、版本和生效时机。daemon 校验权限和当前版本；重复请求不重写、旧回执不覆盖新改动。s54a 复用同一入口，不另写一套 | 700 | s38、s40、s46、s47、s49 | 并发、错误路径 | 无（真实 RPC/CLI 行为先验，飞书回执与 s54a 集成后验） |
| [ ] | s56b | 实际能力名单修改与回执/撤销 | 交付至少一条本机授权 skill/MCP 启用名单修改与撤销，复用 s43/s44b，显示实际能力扩大和生效时机，供 s54b 复用。s55 的目录、升档、开网、模式 writer 与对应回执在 s55 同片完成，不把未接线类型算成果 | 600 | s56a、s43、s44b、s36 | 并发、错误路径 | 真实名单变化/生效和撤销，不能仅验证合成回执 |
| [ ] | s57 | 建群和拉人 | `group create` 建群（默认完全访问，必须带会话方式，主人没说 agent 先问）并把触发人拉进来；`group invite` 按 open_id 拉人；已有的群只回拉 bot 进群的步骤（3.7） | 260 | s54、e10 | 错误路径 | 无（M9 验收时 owner 让 bot 建群并把自己拉进去） |

开工要点：
- s49：私聊里有话题（e10）：用户开的和 bot 用 `reply_in_thread` 开的，事件里都带 `thread_id`，按 `thread_id` 单独成会话，和群里一样。
- s51a 到 s51c：开工前先在草稿上用 `git diff --stat` 量，超过 1500 行再拆。每个 PR 里列一张"私聊卡片 → 网页上的对应页面"对照表；s51b 删之前逐项确认网页有替代：新建项目、绑群、权限、白名单、管理员；s51c 也一样：语音、云文档评论、会话标题、看门狗、完成提醒。其中语音、云文档评论、完成提醒是 3.12 要保留的，看门狗按 3.12 改成 10 分钟（s11）。网页上没有对应开关的，先在同一片里补上再删卡。群里 `/settings` 用的 GS 卡，`tierLabel`、`permissionSummary` 这些共享函数，以及群里 `/usage` 等命令要用的卡片都保留。
- s51a 到 s51c 与 s54a/b 涉及 `handle-message.ts` 同一入口的修改不要同时在飞。
- s53：从飞书来的人不能在本机删。缺权限或接口出错时保留上一次的结果，从来没拿到过时退回"扫码人加本机名单"。
- s57：拉人要 `im:chat.members:write_only`，它现在在可选的进群权限组里。e10：机器人能自己进公开群（`PATCH /im/v1/chats/:chat_id/members/me_join`），私有群回 HTTP 400、`code 232008`。lark-cli 建的群默认私有；客户端建群的默认值没查，开了入群审批的公开群能不能进也没测，开工时补。product.md 3.7 写的是"机器人自己进不了已有的群"，改成"公开群 bot 自己进"是承诺变强，属于本文 4.2 第 3 类：owner 2026-10-15 定（选了 B）：不用 `me_join`，已有的群一律发拉 bot 进群的步骤；product.md 3.7 的承诺不变，只改了事实。自己进群也会推 `im.chat.member.bot.added_v1`，操作人是 bot 自己，今天的 `onBotAddedToChat` 把它记成 `bot-added-nonadmin`、什么也不做；要和别人拉它进群（s36b）分开处理，绑定不靠这个事件触发。`me_join` 靠哪个权限，开工时用只开一个权限的应用试一次。

### M10 从 bridge 迁移

| 状态 | 编号 | 切片 | 内容 | 约行数 | 依赖 | 风险 | Mac 检查 |
|---|---|---|---|---|---|---|---|
| [x] | s58 | 迁移前的清理：删掉没上线的改名迁移 | 删从没上线的改名迁移及专属兼容修复；保留现行数据目录、凭据 getter 识别和互斥/租约（cli-bridge 和它的 Windows 分支由 s02c 删） | 450 | — | — | 无 |
| [ ] | s59 | 导入预检 | 从 #226 移植预检、本地文件读取和旧密钥库，去掉准入互斥锁和 Windows 部分；每个 bot 只读地查第 5 节第 2 步那几项 | 1180 | s58 | 数据迁移、macOS 原生、错误路径 | 用 bridge 0.6.14 的数据副本和隔离的 HOME：预检和实际一致，真实主机名能解开密钥，launchctl 看得出 bridge 在跑 |
| [ ] | s60 | 把 bridge 的数据换算成第一版的形状 | 一个纯函数：bot 照搬，管理员进本机名单，个人指令照旧带上；每个群变成规则模式下的覆盖，cwd 原地引用（第 5 节） | 320 | s59、s36、s21、s12 | 数据迁移 | 无 |
| [ ] | s61 | 导入事务（上）：停 bridge、占锁、复制、回滚 | 第 5 节第 3 到 5 步：调 bridge 自己的 stop，按 bridge 的格式占锁，复制并用新密钥重新加密；任何一步失败就倒序回滚，再 start bridge | 650 | s60、e07、e08 | 子进程、并发、关闭清理、错误路径、数据迁移、macOS 原生 | 在 Mac 的测试用户账号里装 bridge 0.6.14：前半段后 plist 被删、手动 run 被拒；复制后故意失败，回滚后 bridge 重新起来 |
| [ ] | s62 | 导入事务（下）：Codex 兜底、hook、启动、回执 | 第 5 节第 6 到 9 步：找 codex，备份后卸掉 bridge 的 hook，启动全部 bot，写迁移标记和回执；之后每次启动都占 bridge 的锁 | 450 | s61 | 子进程、并发、错误路径、macOS 原生 | 同一个测试用户账号里从头导入：旧会话接得上，卸掉 hook 后审批回到终端里问；第 8 步故意失败能回滚；导入后手动 run 被拒 |
| [ ] | s63 | 导入页 | 发现 bridge 就显示导入页：预检表、"会感到的变化"和"失去"两张清单、进度、回执；清单加"可选：从 bridge 导入"，只在 macOS 显示（第 5 节） | 520 | s62、s04 | 错误路径 | 无（M10 验收前，预览版任务在测试用户账号里走一遍导入页） |
| [ ] | s64 | bridge 最后一版（feishu-codex-bridge 仓库） | 从 0.6.14（`6698118`）开分支：看到迁移标记就拒绝启动，stop 和 status 给提示，第一次启动给主人发通知（第 5 节、第 8 节第 4 条） | 200 | s62 | 错误路径 | 无（发布前由 owner 在飞书客户端里看通知） |

开工要点：
- s58、s59 不依赖 M3 到 M9，M4 之后在第二条线上做。
- s58 做法（#373）：删除生产入口未使用的 `data-root-migration.ts`、`legacy-data-root.ts`、`host/migration.ts`，以及只为改名迁移服务的兼容修复、错误类型和测试。现行 `resolveDataRoot` 继续默认使用 `~/.vonvon-bot`，显式 `VONVON_HOME` 的行为不变；getter 识别、互斥与租约仍保留。隔离的真实 CLI 启动与退出验证默认和显式目录两条路径，两个旧目录的实体、内容和孤立迁移日志均保留。原来的改名做法和第 5 节"复制数据、旧目录原地引用"相反；`~/.vonvon-bridge` 的识别在 s59 里按预检的需要重写。
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
| [x] | e10 | 第 6、14、15、16 项和第 17 项后半：飞书平台（"同时发送到群"和给没开过会话的人发私聊当时没测，2026-10-16 都补测了，见 s14d 和 M4 的 s18 开工要点） | JP-VPS（客户端里看的由 owner 看） | 用测试 bot 的应用身份调接口，lark-cli 以 owner 的用户身份发消息：机器人能否自己进已有的群；`with_sender_name` 拿不拿得到名字；能否拉到别的 bot 卡片回答的正文；话题里的引用分不分得出是哪条；"同时发送到群"收几次事件；私聊里的话题；能否给没开过会话的人发私聊；断线期间的消息重连后会不会补推。只有客户端里才看得到的，留给 owner 找同事看：没开过会话的人收到的私聊在客户端里怎么显示、有没有通知。测"同时发送到群"要有人发一条这样的消息，lark-cli 发不出来时，改在客户端里发 | s09、s14；s18、s22、s27、s49、s57 也用它的结果 | s09 之前 |
| [x] | e11 | 第 18 项的 Codex 一半 | JP-VPS | 用真实 Codex 起两条线程、关掉一条，再用 utility 进程发 thread/read，看不加载线程能不能读到用户消息和最终回答 | s48 | s48 之前 |
| [ ] | e12 | 第 9 项：判断的延迟和额度 | JP-VPS | s23b 合入后用 Codex 订阅的 gpt-6-luna、s23c 合入后用 Claude 订阅的小模型，各跑 50 次判断（`test/judge-real-codex.test.ts`、`test/judge-real-claude.test.ts` 加次数参数），记延迟分布和额度变化，用来定 s25 每群每小时的上限。额度看各自的账户页面，跑之前和跑完由 owner 各读一次 | s25 | s25 之前 |
| [ ] | e13 | 第 7 项：企业租户的权限审核 | — | 不单独做，现在没有企业租户。清单里写一句"企业租户里新权限可能要管理员审核"；M11 时 owner 手里有企业租户，就顺手看一次 | — | — |
| [x] | e14 | 第 8 项和第 17 项前半 | JP-VPS | M3 验收时在 JP-VPS 上看：用 `codex resume` 和 `claude --resume` 打开 bot 的群会话，看到的和 bot 是否一样，两边同时写会怎样；手动 `/compact` 后摘要里引用行还在不在。Codex 应用里打开是什么样，可以在 Mac 上顺带看，不是必做。只影响说明文字和"最近 5 个活跃话题"那张表 | — | M3 验收时 |

e01、e02 已做完，结果在 `docs/research/2026-10-14-v1-spikes/`。e02 没测完的两件写进了 s31 的开工要点。

e05、e06、e07、e10、e11 已做完，结果在 `docs/research/2026-10-15-v1-spikes/`，对各片的影响写进了开工要点（s03、s09、s14、s18、s22、s23、s27、s31、s37、s39、s44、s48、s49、s57、s59、s61、s62、s64）。没测完的：e05 的第二个根能不能写归 s39 的 Mac 检查；e07 的真机部分在 e08；e10 的"同时发送到群"和给没开过会话的人发私聊 2026-10-16 补测了（见 s14d 和 M4 的 s18 开工要点），断线补推在 s09 开工时用 daemon 自己的长连接再测。和 product.md 不一致的几处按 4.2 处理。

按 Linux 先行（本文第 1 节），只有 e03、e04（macOS 沙箱）和 e08（Mac 的测试用户账号）整个留在 Mac 上，e09、e10 只把客户端里看的部分留给 owner，Codex 不碰 owner 的飞书客户端。

Mac 上按最晚期限排：e03、e04、e08，一次一个。e10 留给 owner 的两项在 s14、s18 之前，e09 在客户端里看的部分在 s30 之前，Claude 分别请 owner 做。

JP-VPS 上剩下的按最晚期限排：e12（Codex 的一半等 s23b 合入，Claude 的一半等 s23c）、e09 看消息数据的一半。e14 已在 2026-10-15 做完，见 `docs/research/2026-10-15-v1-spikes/e14-resume-same-session.md`；"两边都写"要不要改（每轮开口前看一眼会话，别人写过就重新接上；Codex 每轮结束就放开线程），等 owner 定。

### 4.2 实验结果和 product.md 不一致时

1. 先开一个只改 `docs/product.md` 的纯文档 PR，写清改了什么、为什么，以及属于下面哪一类。产品切片等它合入后再按新说法做。
2. 不改用户能感到的承诺：照 owner 的回答改写；或者实测发现某个接口做不到、某个版本才有，换一种做法仍能兑现 product.md 的承诺。Claude 找另一个模型审查后合入，不等 owner 认可。依据：owner 在被请求认可 #294（按 owner 第 19 到 29 题改的 product.md）时说"不是每条 PR 都要我认可吧？"。实测修正事实这一种是 Claude 照这句话补的，owner 可以改。
3. 改了承诺或范围：用户能感到的承诺变弱或变强，或者多做、少做某件事，不管起因是不是实测。用【需要你决定】通知 owner，等 owner 定。例如 s44：`~/.codex/AGENTS.md` 关不掉，"新建的 bot 默认不带个人指令"（3.6）就做不到，算这一类（owner 2026-10-15 已定，见 s44）。

product.md 开头的状态说明按这三条写（s01 改的）。

## 5. Claude 定的默认值

product.md 没给值、由 Claude 定的。owner 可以在任何时候改。

| 项 | 默认值 | 理由 | 用在 |
|---|---|---|---|
| bot 默认权限档 | 读写、开网。只给私聊用，群在建立时有自己的默认档（3.8） | 管理员包含飞书应用的开发者（第 6 节），他们都能私聊 bot。私聊默认完全访问，等于把主人 Mac 上执行任意命令的权限交给所有开发者。读写档下 agent 只能写工作区和这一次的记忆目录，越权直接拒绝，和 owner 第 23 题"超出权限就直接拒绝"一致。主人要完全访问，在桌面端或网页里改 | s36、s49 |
| Linux 上用 Codex 时的私聊 | Linux 的首次运行清单加一步，写明"Linux 上 Codex 只能用完全访问"，由主人自己选要不要把 bot 默认档改成完全访问，不自动放开 | 读写档在 Linux 上的 Codex 起不来（3.8） | s20a |
| 群没设工作区时 | 只用群自己的目录，不带 bot 的其余工作区；代码仓库照常继承 | 每个群的文件和记忆分开（3.3） | s36 |
| 每群每小时的判断上限 | 60 次，e12 量完再调 | 3.4 要求有上限，没给数 | s25 |
| 界面上要不要先露出决策模型 | 不露出。存设置时留出"大模型""决策模型"两类，界面只显示大模型 | owner 说决策模型先不用支持，第四题没答；放一个点不了的选项只会让人困惑，以后加选项不用迁移数据 | s23、s41 |
| 智能提示词的显示 | 完整显示内置默认值，改过的能一键恢复默认；程序附的格式行只读显示 | owner 要提示词"都可以看到"；格式行改了程序就读不懂结果 | s41、s42 |
| 判断的超时 | 主区和话题 20 秒，主区被 @ 的 10 秒，从调用算到出结果，含排队和冷启动；e12 量完再调 | 规格没给。被 @ 的一定回，判断只定位置，超时就回在主区，少让人等 | s23a |
| 判断的并发 | 每个 bot 进程、每个后端：Codex 同时 4 条，Claude 2 条，各排队 16 条，满了算 busy（不回，被 @ 的回在主区）；名额等后端调用落定才还，最多等 15 秒。上限按 bot 进程算：N 个 Claude 智能 bot 最多 2N 个 CLI（3 个约 1.5 GB），N 个 Codex 智能 bot 各一个判断进程；整机统一限流在 s26 | Claude 每次判断起一个约 250 MB 的 CLI，JP-VPS 只有 3.9 GB；s25 到 s26 之间接受按进程算的上限 | s23a、s26 |
| 判断出错后的冷却 | 结构化的错误码才冷却 5 分钟：没登录、额度用完冷这个后端，版本、模型冷这个后端加模型；只从文字猜出来的不冷却 | 额度用完时每条消息都去调只会白白排队；文字匹配很宽，误判一次让这个 bot 所有智能群停 5 分钟，代价太大 | s23c |
| 默认判断模型 | Codex 用 gpt-6-luna，推理强度取模型列表里最低的一档（现在是 low），列表还没拉到时也用 low；手填的 id 和不支持推理强度的模型不传。Claude 用别名 haiku、请求时关思考（haiku 仍会少量思考，s23c 实测）；只有 `ANTHROPIC_BASE_URL` 指向非 Anthropic 的地址（网关）时才用网关的模型（s23c）| 3.4 要小模型、控制成本；订阅用户在 settings 里写 `"model":"opus"` 很常见，判断跟着用 Opus，每条群消息一次，额度高一个数量级 | s23a、s23c |
| 以后加决策模型 | 升 `PROTOCOL_VERSION`，或者先发一版让设置视图里 `judge.selection` 的 kind 有兜底分支 | 视图里的 selection 按 kind 区分，老的命令行和网页读到不认识的 kind 会整个设置视图解析失败 | 加决策模型的那片 |
| 许可证 | UNLICENSED | 第一版闭源，第 8 节第 3 条要求发布前改掉 MIT | s65 |
| Linux 验收在哪做 | JP-VPS 上的普通用户账号，做完卸载 | 第 8 节第 5 条要一台 systemd 主机 | s20b |
| Linux 上 `service install` 怎么问 linger | 只在终端里问一句，回车或 y 算同意；不是终端、没带 `--linger` 就不开，只打命令；`--linger` 不问就开，`--no-linger` 不开；不用 sudo，开不了给出 sudo 的命令 | 3.10 说"没开就问一句，同意后执行"，没说没人回答时怎么办；没人回答不算同意 | s20a |
| 卸载时的 linger | 不关，只提示 `loginctl disable-linger` | linger 是这个账号的设置，别的用户服务可能也靠它，也分不出是不是 `service install` 开的 | s20a |
| `open --print` 什么时候打凭据 | 只在 stdout 是终端时；没有图形界面时的 `vonvon open` 和 Linux 上 `service install` 的最后一段一样 | 管道、重定向和服务管理器会把它留进日志 | s20a |
| Claude 的沙箱多久查一次 | 跟执行工具每 60 秒一次，装完后端时也查 | 一次是两次目录扫描加一个约 8 毫秒的 bwrap，比同一轮里起的两个 Codex 进程便宜得多 | s20a |
| Linux 上的两步什么时候显示 | 只在 Linux 上、对应的工具不是"未安装"时；不算进"还差几步"，也不影响"可以用了"；只说明、给命令，不改默认档和系统设置 | 没装的工具没有权限档可说；这两步是说明，不是必做 | s20a |
| Linux 上 Codex 的群多久回一次说明 | 被 @ 每次；免@ 每群 10 分钟一次，被 @ 时回的也算 | 免@ 的单会话群每条消息都会触发，条条都回就刷屏；被 @ 是有人在等它回 | s20b |
| Linux 上 Codex 的群改成只读、读写 | 网页置灰，保存拒绝，已存的不动 | 3.8 说不自动放开：已存的只读是被拉进群时的默认档，留着，改不改由主人定；能存下却起不了会话的档不该让人再选 | s20b |
| 设置卡发给谁 | 拉 bot 进群的人是主人或管理员就发给这个人，不是就发给主人 | owner 2026-10-16 要绑定时选会话方式（3.4），得有人收到卡；今天别人拉进来的群没人收到卡，一直绑不上 | s36b |
| 会话方式的文案 | 主标题、副标题见 product.md 3.4；不预选、不标推荐，命令行必须带；多会话、单会话再选免 @，默认多会话开、单会话关；话题群把多会话和单会话合成"按话题聊"，和智能二选一 | owner 2026-10-16 给了三项的顺序和意思，文案让 Claude 定；不预选是因为 owner 把多会话排第一，第 1 节又主推智能，由选的人定 | s21、s36b |
| 新建的单会话群免 @ 默认关 | 绑定和建群一样，单会话不选就关；以前 bot 自己建的单会话群默认开，已有的群不改 | product.md 3.4 写的是"单会话关着"，没分建群和被拉进来；整群每句话都跑一轮太冲。owner 没单独定，按 3.4 字面做（2026-10-16） | s21 |
| 没设置好的群被 @ 时 | 回一句"主人还没设置好这个群"，同一个群 10 分钟最多一次；不 @ 的消息不读 | 和 Linux 上 Codex 的说明同一个节奏；还没选会话方式和工作区，读了也没处放 | s36b |
| 记忆怎么写 | agent 直接写自己那份记忆文件，daemon 在一轮前后比对，卡片显示写了什么 | 3.6 只说"记住"能写、带撤销，没说怎么写；不在群里另开记忆命令，和 3.7"群里不能在聊天里改设置"一致 | s40 |
| 两条会话同时写同一份记忆 | 用这份记忆的会话有一条在跑一轮时，daemon 盯着文件，文件一变或工具步骤结束就读一次，尽量留下每一版；一轮结束时这期间别的会话也在跑、文件也变过，以行为单位按 diff3 三方合并，基准是这一轮开始时的内容，相同的改动只算一次，两边新增的都留，别的会话还在跑时撤销不生效、等它结束，同一行冲突两份都留并标出；卡片写"和另一个会话同时改过，已合并"，［撤销］退回这一轮开始时并写明会连带撤掉另一条的；合并后超字数上限也不回滚，提示先整理 | 同群的主区和话题会话能同时跑，私聊的主会话和话题也是，都直接写同一个记忆文件（3.6）。agent 直接写文件，加锁挡不住；只在一轮前后看，会漏掉中途被另一条会话盖掉的那一版。宁可多留一行，不丢一行；有意删掉的行偶尔被加回来（大多是另一条会话删后的那一版没读到时），主人能在桌面端删；只有读到的版本才有保证 | s40 |
| "设置更新"什么时候交整份 | 新会话从开场指令交；压缩以后的第一轮整份再交；恢复会话不重交，平时只在变了的下一轮附 | 3.6 定了下一轮生效。压缩可能把之前的"设置更新"摘要掉，和 3.5 压缩后附话题表同一个时机；恢复时开场那份和之前的更新都还在历史里 | s38 |
| 改设置卡片上的［撤销］谁能点 | 主人和管理员 | 3.7 只说带撤销；和 3.8 里"Claude 自己要问的"卡一样 | s56a/b |
| Codex 最低版本 | 0.156.1，比它旧显示"版本太旧"、按钮是更新 | e05 测出 0.139.0 用 ChatGPT 登录试过的模型都跑不了，0.148.0 跑不了 gpt-6-luna，0.156.1 各项都过（第 3 节 s03 留下的）；s23b 改的 | s03、s23b |
| Codex 验证过的版本 | 跟托管安装锁定的版本，现在是 0.156.1；比它新的照常用，只在本机环境页写一句"比验证过的新" | 只有这个版本完整跑过；新版本大多兼容，拦住反而让用户装旧版 | s03 |
| 首次运行清单多久查一次飞书 | 10 秒，只在清单页开着时查，只查还没做完的 bot，一个一个查；全部变绿就停，点"重新检测"马上查 | 每查一个 bot 要调四五个飞书接口；长连接状态直接从快照来，不用查 | s04 |
| Claude 登录结果留多久 | 已登录留 30 分钟，其他留 5 分钟；点"检查登录"马上重查 | 每查一次要起一个约 250 MB 的 CLI，本机环境页每次打开都会问。daemon 自己不查，首页只显示上一次查到、还没过期的结果 | s03 |
| 最近没回的消息记多少 | 每个 bot 30 条，新的在前；同群、同位置、同原因、同后端 10 分钟内并成一条带次数；放 daemon 主进程内存，重启清空 | 3.1 第 8 条只说"最近"；没登录时群里连发十条只占一条；记录不带正文，用不着跨重启 | s19 |
| 运行中被拒的权限显示多久 | 每个权限留最近一次，最多 10 项，显示 24 小时内的 | 发布新版本以后，旧的拒绝不该一直挂着 | s19 |
| 诊断页多久查一次 | 打开时每个 bot 读一次飞书设置，点"重新检查"再读，不轮询；Claude 登录每个窗口最多自动问一次 | 每读一个 bot 要调 3 到 4 个飞书接口，问 Claude 要起约 250 MB 的 CLI | s19 |
| bot 子进程起不来（spawn 失败）算不算崩溃 | `EAGAIN`、`ENOMEM` 这类不算：一分钟最多记一条"出错退出"，按退避重试，最长 30 秒一次；只有 `ENOENT`、`EACCES`（可执行文件没了、不能执行）算 | 资源不够是这台电脑的事，不是 bot 的；算的话 7 秒内就把所有 bot 一起停了，资源回来也不自己起 | s18a |
| bot 子进程拿不到自己的锁 | 退出 75，不算崩溃，不放大崩溃退避：前两分钟 5 秒一次，之后 30 秒一次；两分钟后日志和诊断页写出占锁进程的 PID，每次重试重查 | 多半是主进程死后旧子进程还在排空，等它放锁就好（s18a 做法 D2），几十秒内 5 秒接上；占锁的是主人手动跑的 `daemon run --bot` 时不会放锁，5 秒一次一天要起一万七千多个子进程 | s18a、s18d |
| bot 子进程自己退出（退出码 0） | 不算崩溃，照退避重启，只记日志 | 没见过这种情况；算崩溃的话正常的退出也会停掉 bot | s18a |
| 单个 bot 的"恢复运行" | 网页红条发 `setAgentEnabled(true)`，命令行不加 `bot resume`，用 `vonvon daemon restart`（会重启全部 bot） | 用 `restartHost` 会重启全部 bot、丢掉别的 bot 的排队消息，和"只停这一个"相反；`bot resume` 以后有人要再加 | s18a |
| 快照里列多少条崩溃记录 | 24 小时内的，最多 20 条，新的在前；`crash/` 变了或过了 30 秒才重读 | 3.10 只说列出最近的；快照每 5 秒重建一次，不能每次都读几十个文件 | s18a |
| 重启时丢掉的消息回多久以前的 | 停了 24 小时以内的回，超过的作废、只记日志；停了 10 分钟以上开头写"bot 停了一阵"，不写"刚才重启了" | 3.10 只给了"刚才重启了"；隔一夜再起来说"刚才"不对，超过一天发信人多半已经另想办法，再回只是打扰 | s18c |
| 重启时丢掉的消息回在哪 | 每个群一条，回在这个群最新的那条下面，话题里的回在话题里，写明还有几条；走原始的回复接口，带按消息和汇总版本定的 uuid，原消息没了就不回 | 3.10 说每个群最多一条；SDK 的发送在原消息没了时会改成在群里另发一条，没头没尾；uuid 按消息和汇总版本定，下一个进程重试同一快照只回一条 | s18c |
| 关闭时长连接什么时候断 | 关闭一开始就断，之后到的消息靠飞书重推给下一个进程 | 原来最后才断，关闭那几秒到的消息被确认了又丢掉，谁也不回；代价是关闭期间点卡片按钮提示失败 | s18c |
| 孤儿子进程排空多久 | 20 秒，到点退出 0 | 主进程死后没人再补 SIGKILL，排空不结束就一直占着锁，新的子进程起不来；托管下正常排空最长 8 加 3 秒 | s18d |
| 没发出去的暂停私聊 | 排上就落盘；下次启动同一轮还暂停着、24 小时内才用原来的 uuid 补发 | 主进程在发出去之前被 kill -9 和关闭时没发完是同一个问题；恢复运行或重启机器以后，"已停止自动重启"不再是真的 | s18e |
| 已有会话补拉的条数 | 最多 40 条，更早的只写"更早还有 N 条" | 3.5 只给了开场的条数（主区 20、话题 10），已有会话只说"字数超预算就留最近的"；40 条约 12 KB | s14a |
| 补拉和查引用的时限 | 一次补拉所有页合起来 10 秒，查一条消息 10 秒 | SDK 的请求没有超时，这一轮要等它；和登记表查第一条用的 10 秒一样。拉满 10 页要多久没测过，M3 看日志里有没有 `*-context-timeout` 再调 | s14a |
| 别的 bot 没答完的卡片重拉多久 | 距触发消息 10 分钟以内的才重拉 | 卡在流式输出里一直不结束的卡片，不能让每一轮都从它那里重拉 | s14a |
| 一个记录块最多几行引用行 | 10 行，留最新的，多的只写"还有 N 个话题没列" | 3.5 没给数；一行约 150 字，10 行约 1.5 KB，不算进消息的 20 条、40 条、10 条 | s14b |
| 认别的 bot 开的话题 | 每轮最多查 5 个，每个限 3 秒，并行；一个话题每次启动只查一次 | 主区里话题多时，这一轮也不能多等；查失败的不再查，免得每轮都等 | s14b |
| 认话题群 | `chat.get` 限 3 秒；查到的记 1 小时，查不到的当普通群、记 10 分钟 | 群设置里能改消息形式，不能一直记；`im:chat:readonly` 是可选的 | s14b |
| bot 正忙时的 `/compact` | 这一轮结束后马上压，排在已经排队的消息前面；一条会话只排一个；`/goal` 运行中和 `/new`、`/resume` 占着时不收 | 3.5 只说"等这一轮结束再压" | s15 |
| 每条会话记几条撤回说明 | 20 条，留最新的 | 3.5 没给数；说过一次就清，平时到不了 | s15 |
| 比消息先到的撤回记多久 | 进程内记一天，最多 2000 个消息 id，不落盘 | 飞书的事件不保证按顺序到；隔得更久的很少见 | s15 |
| 预览版 | 只出 Apple Silicon，不公证 | 只装在 owner 自己的 Mac 上验收；universal 包和公证在 M11（第 8 节第 1 条） | 本文第 7 节 |

## 6. Windows 代码去留

第一版不做 Windows（product.md 第 7 节），不写新的 Windows 专属代码，CI 不跑 Windows（#290）。已有的代码要删，但不为 Windows 单独铺开改动，分三类。

**一、专门开两片来删：s05a、s05b**（约 1,890 行，没有用户可见的变化）
- 要删的：`D/service/windows.ts`、`win-startup.ts` 和三份 Windows 服务测试；`definitions.ts`、`identity.ts`、`registration.ts` 里的 win32 分支；`D/cli/index.ts:15` 白名单里的 `__win-relaunch` 和 `:57` 的命令本体。`D/service/control.ts:91` 正则里的 `__win-relaunch` 是识别 bridge 的兼容标识，保留。
- 理由：这些代码没有调用方，而 s06、s07 要改的正是这几个文件。先删，后台服务那两片就只剩 macOS 和 Linux 的逻辑，审查更集中，以后也少维护约 1,300 行。

**二、跟着本来就要改这些文件的切片一起删**
- s08b：`cli-registration.ts` 的 Windows PATH 注册和 `.cmd` 入口，命令行注册只认 macOS；`windows-native.test.ts`；electron-builder 的 win nsis 和 linux AppImage 目标；`daemon-dependencies.ts` 的 `windowsHide` 和两份桌面端测试里的 win32 小分支。删完以后桌面端（`packages/desktop`）不再有 Windows 代码。issue #288 按 product.md 3.10 以"第一版不做 Windows"关闭。
- s20a：`open.ts` 的 `cmd /c start`；协议平台枚举里的 windows，以及界面上的"这台 Windows 电脑"。（s20a 已删，CSS 里 `data-desktop-platform="windows"` 的几条规则一起删了）
- s20b：Codex 只读、读写档的 win32 分支；`codex-appserver/windows-job.ts`、它的两处引用和两份测试。（s20b 已删）
- s51a：私聊菜单里的"安装桌面版 · Windows x64"按钮。
- s02c：cli-bridge 整个删掉，它的 cmd.exe 引号、命名管道、PowerShell 离开检测和 Windows 提示跟着没了；`config/paths.ts` 的命名管道分支。分在 s02c2 到 s02c5，见第 3 节的 s02c 拆法。s02c5 删完了，`data-compatibility.ts` 里给 cli-bridge 算旧命名管道名的 `bridgePipeName` 也在 s02c5 删了。
- s58：从没上线的改名迁移（`data-root-migration.ts`、`legacy-data-root.ts`、`host/migration.ts`）；`data-compatibility.ts` 剩下的 Windows 分支（`bridgePipeName` 已随 s02c5 删）。`isBridgeGetter` 还有人用，留下。
- s59：`D/service/control.ts` 里检测 bridge 的 Windows Run 键和计划任务。导入只做 macOS。

**三、先留着**
- `provider/process` 下的 windows-supervisor、windows-job-probe、windows-command-line，以及 `test/provider/windows-*` 测试。它们属于 ProcessHost；main 上 ProcessHost 只在启动时清理孤儿进程，第一版没有切片要改它，这些代码也只在 win32 上会走到。要删它们，得先定那层没接线的 provider 代码留不留，放到第一版之后一起定。
- Codex 协议生成的 `Windows*.ts`，这些是生成文件。
- 约 40 个文件里零散的 `process.platform === 'win32'` 小分支和 `windowsHide` 参数，都在 daemon 和 `scripts/` 里，桌面端的已随 s08b 删掉。以后改到这些文件时顺手删，不专门开 PR。

## 7. 预览版怎么出

第 2 节的提前 A/B 体验检查按已完成切片出预览版，使用同样的隔离、签名和任务规则。它们不替代整个 M7/M8/M9 验收；真实结果按准确版本记录，后续相关行为变更再复验。

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
- 验收 daemon 的 Claude 会话读 operator 用户的 `~/.claude`（回合一直读 user 和 project 两层设置，`D/agent/claude-agent/backend.ts` 的 `BRIDGE_SETTING_SOURCES`）：开发用的 CLAUDE.md 和 lark 技能都在里面。所以 JP-VPS 上的 Claude bot 有时像开发 agent 一样做事。2026-10-15 实测到三种：
  - 用 lark-cli 查飞书；
  - 翻验收 daemon 的日志和数据目录（没读出凭据）；
  - 说"这一项不能算验收通过"。
  只读档下 Bash 照样能联网（product.md 3.8 的已知缺口，s31 修），lark-cli 存着 owner 的用户授权。所以 s31 合入前，JP-VPS 的测试群里只放 owner，不拉同事。M3 第 7 步已拿掉（owner 2026-10-16）。以后要拉同事进测试群，在 owner Mac 上的 bot 做：用 Codex 的群，权限档设成只读、关网，Mac 上 Codex 的只读档有 Seatbelt 沙箱。判断 Claude 的回答时，靠翻日志或 lark-cli 查到的不算上下文给到了。s19 起日志不带正文，翻日志这条路已经断了。
- Linux 上的 Codex 只能用完全访问（product.md 3.8，`D/agent/codex-appserver/backend.ts`），JP-VPS 上用 Codex 的测试群要明确改成完全访问。一个群只有一档（s15c），改成完全访问的测试群里谁说话都是完全访问；这种群里不放别人。

**Mac 上怎么打包。**
1. Claude 往 #322 贴一个预览版任务，提示词整份写在任务里，不再另开 `Mac 预览版 <里程碑名>` issue。Mac 上没有会话在处理队列时，Claude 请 owner 在 Mac mini 上新开 Codex 会话，模式选 full access（owner 2026-10-15），发一次"按 modelzen/vonvon-bot#322 正文做"。规则见 `AGENTS.md`"工具和同步"。
2. Codex 在临时 worktree 里取 Claude 给的 main sha，`npm ci`，`npm run build`，先按上面第 2 步查网页端，过了再在 `packages/desktop` 下用 `electron-builder --config electron-builder.yml --dir` 打包，也就是今天的 `package:dir` 脚本。electron-builder 会自动用钥匙串里的 Developer ID 签名。不公证，只出 Apple Silicon。
3. 装之前（s20e 起），Codex 先确认 owner 默认的 daemon 不是 s20c 之前的版本：只读看装好的 app 带的命令行 `vonvon daemon status --json` 里的 `pid`、`startedAt`，和 `launchctl print gui/$(id -u)/com.vonvon.bot.daemon`。`startedAt` 早于 2026-10-17 03:48 UTC（#322 任务 21 第一次在这台 Mac 上装好含 s20c 的 app、贴出结果的时间）的，就是 M3 预览版起的、s20c 之前的版本：先按服务的正常方式 `launchctl kickstart -k gui/$(id -u)/com.vonvon.bot.daemon`，让 launchd 用当前装好的 app 重新拉起，确认换了 PID、`startedAt` 是刚才，再装。重启会让 owner 的 bot 断几秒，Claude 在任务里按步骤列出这一步（`AGENTS.md`：owner 的 `com.vonvon.bot.daemon` 只有预览版任务能碰）。确认（需要时重启）之前，不对 owner 默认的数据目录跑 `vonvon daemon run`（带不带 `VONVON_SERVICE` 都不跑）、`vonvon secrets set`、`vonvon secrets remove`。原因见"s20e 留下的"。然后打好的 .app 装进 /Applications，按上面第 3 步先做标"Codex 先查"的步骤，再由 Claude 通知 owner 验收。
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
| 一位同事或第二个飞书账号 | e10（s18 之前）、e09（s30 之前）、M6 第 4 步、M9 第 2 和第 6 步 | 验收时要有另一个人点卡片、私聊 bot |
| JP-VPS 上再加两个测试 bot | 已做（2026-10-16） | M5 要同一台机器上三个 bot（一个规则模式、两个智能模式）。owner 在 JP-VPS 的终端里扫码建了 Vonvon Bot 7、Bot 8，开发者后台由 Mac 上的 Codex 配好、发布（本文第 10 节"M3 验收期间顺带看到的"） |
| JP-VPS 上给 bwrap 加载 AppArmor profile | 已做（2026-10-15） | owner 经 SSH 加载了，结果见本文第 7 节。M6 第 1 到 3、5 步和 M7 第 3 步不再退回 owner |
| bridge 最后一版什么时候发 | M10 之前定 | product.md 第 8 节第 4 条，s64 按这个时间发 |
| 验收 bot 和 owner Mac 上的 bot 订阅「撤回消息」事件 | M3 第 6 步之前 | 在开发者后台的事件配置里（长连接）加 `im.message.recalled_v1`，再发布一个版本；没有接口，Claude 做不了。Claude 先在 JP-VPS 上用应用版本接口查验收 bot 订阅了没有，缺了才找 owner，和别的事一起说。缺了不挡：bot 照常用，清单里只提示（owner 2026-10-16）；Bot 4、Bot 5 已订阅 |
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

Linux：`vonvon service uninstall`，`vonvon daemon stop`，`npm rm -g vonvon-bot`，`rm -rf ~/.vonvon-bot`。卸载不关 linger；装的时候开了 linger、这个账号上又没有别的用户服务要它，再运行 `loginctl disable-linger`（s20a）。

**Linux 验收**（s20b 填，product.md 第 8 节第 5 条的 Linux 一半）：2026-10-16，Claude 在 JP-VPS 的普通用户账号里做，用 s20b 的 `b4132c187275b0d295aa88218a438a6a8c37602a`。
- 打包和安装：在干净的 PR worktree 里 `npm run pack:vonvon-bot -- --out <临时目录>`，得到 `vonvon-bot-0.7.0.tgz`，sha256 `333f6617ecdb2c4aaf5c657698b879efba71e2066e3ce9f045dab5a2421c5c7d`；`check-vonvon-bot-package.mjs --head <这个 sha>` 通过（7269 个文件）。用 `npm install -g --prefix <临时前缀> --offline --ignore-scripts` 装到不在任何 git checkout 里的临时目录，之后每条命令前面带 `npm_config_prefix`、`VONVON_HOME` 和 `PATH`，直接运行 `vonvon`。
- `vonvon service install --port <P>`：装成 `~/.config/systemd/user/vonvon-bot-<数据目录哈希的 12 位>.service`，`ExecStart` 是 `/usr/bin/node <临时前缀>/lib/node_modules/vonvon-bot/bin/vonvon.mjs daemon run --port <P>`，`Restart=on-failure`、`RestartSec=5`。装完 `active`，MainPID 1675248，`NRestarts=0`；`daemon status --json` 的 pid 和 MainPID 一样，`curl 127.0.0.1:<P>/` 回 200。install 打印"linger 已开"。
- `kill -9` 这个 MainPID：日志里是 `status=9/KILL` 和 "restart counter is at 1"，7 秒内 MainPID 换成 1675476，`NRestarts` 从 0 到 1，还是同一个端口，`curl` 回 200。
- `vonvon daemon stop`：打印 `stopped`，退出 0。之后 20 秒里 unit 一直是 `inactive`，MainPID 0，`NRestarts` 还是 1；没有 `daemon.pid`，端口空出来了。
- `vonvon service uninstall`：打印 `uninstalled: Uninstalled` 和 linger 的提示"linger 没关：…不需要的话运行 loginctl disable-linger。"；`LoadState=not-found`，unit 文件和 `default.target.wants` 里的链接都删了。
- linger：`loginctl show-user` 前后都是 `Linger=yes`，没关。JP-VPS 上在跑的验收 daemon 前后是同一个进程，它和它的端口都没碰。
- 无头网页检查（实现时在 JP-VPS 上跑的）：Linux 上 Codex 项目的权限设置里，只读问答、允许写入两档是置灰的。

**M3 验收期间顺带看到的**（2026-10-16，不属于哪一片）
- 卡片回调：JP-VPS 的 Bot 6 第一次被真人点卡。在「⚙️ 群设置」卡上点「设置默认模型」，原卡不变，另发一张设置默认模型的卡。
- M1 第 6 步的余项：运行卡过程面板里多行输出是一行一个（Mac 飞书）。「调用参数」那一栏显示的是工作目录或工具的说明，不是命令参数，留给界面那一轮。
- M5 第 8 步（s14d）：owner 在 Mac 飞书里，话题里勾「同时发送到群」再 @Bot 6，bot 只在话题里回了一次，主区没有新卡片，也没有回复。
- s16：Mac 上的 Bot 4（Claude 经 DeepSeek 网关）手填模型 id 和推理强度，能回复，没报错。
- s14d 的查询：Bot 6 这次运行的第一次 `message.get` 超时了（1.5 秒），按设计当普通消息照常回。只看到这一次，没有再调。
- 测试 bot：JP-VPS 上在终端用 `bot add` 扫码建了 Vonvon Bot 7、Vonvon Bot 8，都连上了（本文第 8 节"JP-VPS 上再加两个测试 bot"）。开发者后台的事件和回调由 Mac 上的 Codex 用浏览器配好：两个都是 8 个事件、1 个卡片回调，长连接，各发布了 1.0.1；权限和 Bot 6 一样，没改。
- s18 的预检（bot 主动私聊没开过会话的主人）：owner 从没打开过 Bot 7 的私聊。用 Bot 7 的应用身份发两条文字私聊，一条按 `union_id`（从 lark-cli 的应用取的 owner 的 union_id），一条按 Bot 7 扫码时记下的 `ownerOpenId`，都返回 code 0，进了同一个私聊。owner 确认手机和电脑都弹了通知。所以崩溃私聊直接按扫码时记下的 `ownerOpenId` 发，不用等主人先开私聊。同一租户的自建应用之间 `union_id` 通用。
- 飞书发消息的 `uuid` 去重（给 s18b）：同一个 uuid 在一小时内发两次，两次都成功，返回同一个 `message_id`，群里只有一条。

**发布前的 Mac 验收**（s67 填，product.md 第 8 节第 5 条的 Mac 一半）：待填。
