# 隔离开发版 App

用 `VONVON_DESKTOP_PREVIEW=1` 构建专用入口，再通过 `packages/desktop` 的 `package:preview` 包装。标准构建使用原入口和原包装配置。预览包装检查独立应用身份、构建标记和入口哈希，拒绝普通 stage 或启用了正式更新的 stage。

```sh
VONVON_DESKTOP_PREVIEW=1 \
VONVON_ACCOUNT_WEB_ORIGIN=https://recipes-staging.vonvon.cc \
VONVON_ACCOUNT_API_ORIGIN=https://recipes-staging.vonvon.cc \
npm run build
npm run package:preview -w packages/desktop -- --mac --arm64
```

macOS 产物名为 `Vonvon Bot Preview.app`，bundle ID 为 `com.vonvon.bot.preview`。启动入口在载入主程序前覆盖继承的测试目录变量，始终使用当前用户的 `Library/Application Support/Vonvon Bot Preview/desktop` 和 `data`，普通 Finder 启动也隔离 Electron 状态与后台数据。预览版使用 ad-hoc 签名，不是已公证安装包；设置中拒绝全局 CLI 注册和登录项服务操作，启动时忽略旧服务注册并直接启动包内 daemon，不启用正式更新，不替换 `/Applications/Vonvon Bot.app`。

账号网页/API地址编译进桌面及随包 daemon。正式服务使用同一批验收源码，但正式域名不同须重新构建，不能声称二进制相同。预览账号、草稿和安装记录只在测试环境，正式启用后按本轮清单清理，不迁入正式数据库。

回归验证包括实际入口打包后的模块执行顺序、继承正式目录时仍覆盖为预览目录、包装拒绝普通入口及过期字节、随包 daemon 保留编译地址。GUI 启动、真实登录与安装由本轮主验收者统一操作。
