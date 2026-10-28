# Windows 安装体验（2026-10-28）

- [VS Code 下载说明](https://code.visualstudio.com/docs/supporting/faq)：Windows 区分 User Installer 与 ZIP。用户安装包与免安装包是不同用途，下载页应明确区分。
- [开源 VSCodium 的发行页](https://github.com/VSCodium/vscodium/releases)：Windows User Installer 文件名包含 UserSetup、架构与版本。Vonvon 采用 `Vonvon-Bot-Setup-<version>-x64.exe`，保留 `Vonvon-Bot-<version>-windows-x64.zip`。
- [微软路径限制说明](https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation)：传统 Windows API 有 MAX_PATH 边界，不能假定所有解压器和卸载路径都支持长路径。
- 本机 0.7.5 证据：NSIS 内存在深层 dunder-proto/get.js，安装目录对应文件缺失；已有文件最长 255 字符。运行后台报 MODULE_NOT_FOUND，桌面报就绪超时。旧卸载器更新模式移动文件到更长临时路径也失败，普通卸载保留数据后成功。
- 体积：安装后 Electron 约 337 MB，后台依赖约 91 MB，npm 约 12 MB，其他资源约 10 MB。owner 接受正常 Electron 体积；本次只调整造成安装错误的依赖布局。
- 产品约定：Windows 两个用户包、两个入口；与 Mac 两个 DMG 合计四个官网入口。更新元数据不作为用户安装入口。未签名提示如实说明，不改变系统安全设置。

核实记录：依赖布局、失败保护、NSIS 和启动检查由不同模型独立审查；实际安装和运行证据保存在本机交接目录。Windows 0.7.6 的界面已打开交 owner 验收；签名升级和公开发布不在本次完成范围内。
