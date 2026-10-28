# Windows 重装失败与下载选项（2026-10-28）

## 本次故障

0.7.6 Setup 在“卸载旧版”阶段报 `Failed to uninstall old application files: 2`。不是解压新版 payload 时失败。

确认的证据：

- owner 从实际 PowerShell 回传：当前用户的 32/64 位卸载注册表视图都留有 `DisplayVersion=0.7.5`，卸载命令指向 `%LOCALAPPDATA%\Programs\Vonvon Bot\Uninstall Vonvon Bot.exe`。
- 对停在错误窗口的 NSIS 进程只读检查：当前用户模式、旧安装目录、原始卸载命令与 owner 输出一致；最终 `$R0=2`。未修改进程内存。
- 旧目录、其中的应用 EXE、卸载器以及临时旧卸载器均不存在。之前仅查看另一个 `vonvon-bot-desktop` 安装目录不足以解释此次失败；工具看到的注册表与 owner 实际会话也有差异，故采用 owner 输出与安装器进程状态交叉确认。
- 仓库锁定的 electron-builder 26.15.3：`uninstallOldVersion` 无法启动旧卸载器时保留 `Errors`；其默认结果处理允许这类缺失继续。但 0.7.6 的自定义恢复 hook 无条件把 `Errors` 转成 2，并退出，因而残留注册记录阻止重新安装。
- 独立 NSIS 小程序复现：无旧记录为 0；旧注册指向缺失的卸载器时，旧代码为 2。没有证据把这个报错归因于 Windows ARM 的 x64 仿真。

## 修复边界与验证

仅在当前用户安装、原卸载命令能解析、旧目录可确定，且旧卸载器和旧应用 EXE 都不存在时允许继续。安装器正常写入新版文件及注册信息；不删用户数据、不清理其他目录、不清零实际旧卸载器的非零退出码。

检查依据是原注册记录及其目录，不能用新的 `/D` 目的地代替。保留 0.7.5 的普通卸载恢复调用与数据参数。畸形命令、其他安装模式、旧程序或卸载器仍在而卸载失败的情形继续中止。

`scripts/windows-installer-smoke.mjs` 编译并运行真实 NSIS 和锁定的 electron-builder 函数，使用随机独立注册键和临时假程序。覆盖全新安装、孤立记录、不同目的地、缺 InstallLocation 的回退、畸形注册、真实卸载错误、0.7.5 恢复及其他模式，共 13 项。Windows 构建在生成包后执行该检查。该隔离验证不等于发布后的完整安装验收。

## 下载产品参考

| 产品 | 官方做法 |
| --- | --- |
| [VS Code](https://code.visualstudio.com/docs/setup/windows) | 推荐免管理员权限的 User Setup，也保留 System Setup 和 ZIP |
| [VSCodium](https://github.com/VSCodium/vscodium/releases) | Windows x64、ARM64 分别提供 User Installer、System Installer 和 ZIP |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio/releases) | Windows x64、ARM64 分别提供 Installer 和 Portable；[安装说明](https://cherryai.com/docs/en/cherry-studio/installation/windows/)要求按设备架构选择 |
| [Chatbox](https://github.com/chatboxai/chatbox/releases) | Windows 以 x64 Setup 为用户下载入口；说明并非每个社区应用都必须提供相同数量的包 |

建议：下一片考虑 x64（Intel / AMD）与 ARM64 原生安装版；不新增 32 位 x86。普通下载主推当前用户安装版，ZIP 可保留为“其他下载”，不必与推荐安装版并列。

owner 已选择本次只修安装错误，双架构下一片做。ZIP 是否继续提供及下一片的具体发布清单待后续决定，本次不变更包数量或官网。

## 核实记录

- 独立模型审查了修复的旧目录判定、数据保留、真实错误拒绝和 0.7.5 恢复路径，独立运行前一版 12 项 NSIS 验证通过，并复核最后的退出码收紧条件与新增案例。最终 13 项由实现者运行通过。
- 这里只提交代码到 dev；不改 main，不覆盖 0.7.6 下载对象，不发布。Mac 后续使用新的统一产品版本构建并验收；新版本实际安装后的结果另记。
