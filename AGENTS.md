# vonvon-bot 分工规则

- vonvon-bot 在两类机器上开发：没有桌面的 Linux 服务器上用 Claude Code，有桌面的 Mac 上用 Codex。
- Linux 上的 Claude Code 负责写代码，跑 typecheck、测试和构建，然后 push 到功能分支。
- Mac 上的 Codex 负责 pull 同一个分支，启动应用，在真实窗口里检查，把看到的结果写进对应的 PR。打包、签名这类只能在 Mac 上做的事也由 Codex 负责。
- 一个功能只用一个分支，两边轮流在上面工作。Mac 上发现只有 Mac 才有的问题，就直接在同一个分支上修，然后 push。
- 开始前先 pull，停下时 push，不要 force-push。
- 各台机器只通过 Git 同步，各自运行 npm ci，不要拷贝 node_modules、dist、build、release。
