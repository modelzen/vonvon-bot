# Windows 命令行

安装并打开 Vonvon Bot 后，关闭并重新打开 PowerShell 或 CMD，即可使用安装包自带的 `vonvon`。不需要额外安装 Node.js 或 npm，也不需要管理员权限。

```powershell
vonvon --version
vonvon --help
vonvon daemon status --json
```

命令复用桌面安装包中的程序和同一份数据。只有 Linux 提供独立服务端安装；Windows 的命令注册不增加登录自启或后台服务。

入口是安装目录下的 `resources\cli\vonvon.exe`。桌面启动时会核对入口并注册该目录到当前用户的 PATH；不会改系统 PATH、PowerShell profile 或其他程序的条目。正在运行的终端可能仍使用旧 PATH，请退出整个终端程序后重开。

若仍提示找不到命令，重新打开 Vonvon Bot 后再重启终端；也可以用完整路径运行该 `vonvon.exe`。用户 PATH 需允许修改，入口损坏或缺失时请重新安装。若已有别的同名命令，用 `where.exe vonvon` 检查实际解析的入口。

若现有用户 PATH 的注册表类型允许展开环境变量，安装目录不要包含字面 `%名称%`；这会被 Windows 当成变量，程序会拒绝注册该目录并保留原 PATH。中文、空格、`&`、`!` 安装目录可以使用。

卸载桌面版会一起删除命令入口；用户 PATH 中若还保留旧安装目录，可以在 Windows 的“编辑账户的环境变量”里移除该目录。Bot 数据仍按桌面版原有的卸载规则保留。
