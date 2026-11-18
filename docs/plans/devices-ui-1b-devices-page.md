# U1b `devices-ui-1b-devices-page`：设备页、添加和切换、状态和版本提示

> **2026-11-03 起**：添加设备的帮助和错误文案里，"去那台电脑哪里生成链接"指 设置 → 设备 →「允许别的设备连接」（0.9.0 在"应用与启动"）。下文旧路径是历史记录。

总设计见 `docs/plans/devices.md`（下文简称"设计"）4.6、6.1、6.4、第 15 节，本片对应第 13 节的 U1b 行。**和 U1a（`docs/plans/devices-ui-1a-connections.md`）合成一个 PR**，分支 `claude/devices-ui-1`。本片只碰界面，主进程、协议和连接管理全在 U1a。产品行为以 `docs/product.md` 3.14 为准。

缩写同 D1：`P/`、`CL/`、`D/`、`DT/`、`U/` 分别是 protocol、client、daemon、desktop、ui 的 `src/`。行号以 `origin/claude/devices-integration`（8051b03c；本片引用的 ui、desktop 文件和 a2577fb3 相同）为准。

## 1. 做什么

用户能看到的：
- **设备页。** 设置里多一页"设备"：
  - 第一行永远是"这台电脑"，下面是加过的设备。
  - 每台显示名字、系统、状态点和状态字（在线、正在连接、重连中、连不上、版本不一致、已撤销、需要重新配对、上次在线 <时间>）、版本，以及"切换到""改名""删除"；有问题的设备显示"重新配对"。
  - 页底有一段 Tailscale 建议。
- **添加。** "添加设备"：粘贴连接链接 → 看到设备名、地址和类型（Tailscale、局域网……）、剩几分钟 → 起名字 → "连接并添加"。
  - 失败时按原因说清楚，连不上时按地址类型给建议。
  - 链接已被用掉时有专门的说明。
- **切换。** 主导航旁有当前设备的小标签，只在加过别的设备后出现，点开能切换。
  - 切换就是整个界面换到那一台；有没保存的修改时照旧先确认。
  - 切到连不上或已撤销的设备时，整页说明原因，并给"重试""回到这台电脑"。
  - 切过去的设备名字会出现在窗口里，但窗口外框保持这台电脑的样式。
- **断线和提示。**
  - 远程连接断了，顶部出一条提示条，说明正在重连，或者对面在重启、已停止。
  - 对面重启过、升级过，重新连上后提示一次。
  - 被撤销后 1 秒内页面换成"已撤销"的说明。
- **版本提示**（设计 4.6）：
  - 版本号不同、协议相同：顶部提示，不拦。
  - 协议不同：只留设备列表和升级面板（维护视图）。

依赖：U1a（同 PR）。I3 已拆成 I3a（`server-3a-update-core`，#632，b55cc5d3）和 I3b（`server-3b-update-helper`，#633，83550082，叠在 I3a 上）；`UpdatePanel` 以 I3b 为准。I3 已合入时，维护视图里的升级用它；没合入时只显示文字。对面是桌面端自带服务端时的升级按钮归 U4。

## 2. 范围

做：
- `U/devices/DesktopRoot.tsx`（新）：`DesktopRoot`、`DesktopRootView`、`DeviceGate`、`OutsideWindow`（含订退出）和三个纯函数（`desktopPlatformMark`、`shouldMarkPlatform`、`quitOutsideApp`）；`U/main.tsx` 只改 97 行去 import 它。
- `U/devices/`（新目录）：
  - `devices-presentation.ts`：纯函数和全部文案。
  - `DevicesPanel.tsx`、`AddDeviceDialog.tsx`、`DeviceSwitcher.tsx`、`DeviceConnectionView.tsx`、`MaintenanceView.tsx`、`DeviceStatusBanner.tsx`、`DeviceVersionNotice.tsx`、`TailscaleAdvice.tsx`。
  - `devices.css`。
- 改：`U/App.tsx`、`U/LocalShell.tsx`、`U/TodayHome.tsx`、`U/collaboration-model.ts`、`U/search.ts`、`U/url-actions.ts` 和 `DT/bridge.ts` 的 `externalKinds`。
- `docs/product.md` 3.14 一句（第 7 节）。

不做：
- 设计 6.4 表里远程时各页面的隐藏和改文案，包括"应用与启动"页的标题 `deviceTitle(...)` 在远程时写成"这台 Linux 主机" → U2。
- "允许别的设备连接"、生成链接、撤销别的客户端、改这台电脑的名字 → U3。
- 对面是桌面端自带服务端时的"更新 <设备> 上的 Vonvon Bot"按钮 → U4。
- 二维码、浏览器远程、非当前设备的后台状态 → 不做（`product.md` 3.14"不做"）。

## 3. 现在的代码

- `U/main.tsx`：`Root` 28-102；桌面端分支 97 是 `<ClientProvider client={injected} shell={window.vonvonShell}><DirectoryPickerProvider><App/>`；网页端的连接页 98-101。
- `U/App.tsx`：
  - `App()` 142-144：`DraftGuardProvider` → `DesktopUpdateProvider` → `DesktopApp`；`DesktopApp` 145。
  - `watchSnapshots` 的 effect 在 285-295，291-292 把 `document.documentElement.dataset.desktopPlatform` 设成快照的 `application.platform`。这份快照来自远程时，Mac 上会换成 `linux`，窗口外框的样式（`collaboration.css:43`、`reference/styles/*.css` 里的 `html[data-desktop-platform="macos"]`）就掉了。
  - `if (!snapshot)` 在 507；`titles: Record<Page, string>` 在 526-540。
  - `<AppShell` 在 603；`{feedback}` 在 643；"daemon 尚未就绪"在 644-650。
  - `SettingsHome` 在 674；"应用与启动"页的 `UpdatePanel` 在 902-904，用的是 `deviceTitle(snapshot.application.platform)`。
- `U/LocalShell.tsx` 的 `AppShell` 在 8-34：主导航 16-21 只在 `!firstUse` 时显示，右侧操作 22-26。
- `U/TodayHome.tsx`：`settingsEntries` 21-30；`SettingsHome` 31-38 按 `slice(0, 4)` 和 `slice(4)` 分成两组。
- `U/collaboration-model.ts:2`：`Page` 联合类型。
- `U/search.ts`：`searchEntries(snapshot, capabilities)` 89，页面表 90-103。
- `U/settings/DraftGuard.tsx`：`navigate(action)` 29，自动保存的草稿先保存（34），再执行动作。
- `U/desktop-update.tsx`：`DesktopUpdateProvider` 39、`useDesktopUpdate` 55。`U/DesktopUpdateButton.tsx:7`。
- `U/conversation-time.ts:2`：`conversationTime(value, now)` 出的是当天的时刻、"昨天"或日期，不是"N 分钟前"；会话列表在用它，不改。本片在 4.9 自己写 `relativeTime`。
- `U/main.tsx` 末尾在模块顶层 `createRoot(root).render(<Root/>)`，测试 import 它就会去找 `#root`；`test/connection.test.ts` 靠 `vi.mock` 掉 `App` 等模块才能 import。
- 退出：`App.tsx:152` 是唯一订 `shell.onQuitRequested` 的地方。`DT/facade.ts:86` 在没有订阅者时把请求记成 `pendingQuit`，下一个订阅者一订上就补发（258）。
- 窗口外框：`DT/preload.ts:8` 设 `data-desktop-chrome="silver"`；`desktop.css:85-116` 只给 `.today-window` 留 34px 的 `.desktop-titlebar` 一行（可拖动），控件 `no-drag`。`App` 以外的页面没有这一行。
- 根目录 `vitest.config.ts` 只收 `*.test.ts`；ui 包的 `npm test` 是 `vitest run`，用默认的 include，`.tsx` 也收。ui 包没有 jsdom。
- `U/setup/service-toggle.tsx:39`：`deviceTitle`。
- `U/url-actions.ts:17`：`allowedExternalUrl(value, kind)` 按种类白名单；`DT/bridge.ts:19` 的 `externalKinds`。
- UI 组件在 `U/reference/components/ui/`：`Dialog.tsx:22`、`index.tsx:201` 的 `InlineNotice`、`Button`。
- serverInfo v2 的 `platform` 取值是 `macos | linux | windows | unsupported`（D1 分支 `P/handshake.ts:23`）。

## 4. 怎么改

所有界面文字集中在 `devices-presentation.ts`（4.9），组件里不写散的中文。远程设备在句子里一律写成"「名字」"，这台电脑写"这台电脑"（U1a 的 `deviceCopyName`）。界面上叫"设备"，不叫"服务器"。

### 4.1 `U/devices/DesktopRoot.tsx`：`DesktopRoot` 和 `DeviceGate`

放在新文件里并导出，不放进 `main.tsx`：`main.tsx` 在模块顶层就 render（第 3 节），测试 import 不了它。`main.tsx` 97 行改成 `return <DesktopRoot fallback={injected} shell={window.vonvonShell}/>;`，`test/connection.test.ts` 加一行 `vi.mock("../src/devices/DesktopRoot", () => ({ DesktopRoot: () => null }))`。

```tsx
export const desktopPlatformMark = (state?: DevicesState) => state?.devices[0]?.platform;   // 本机永远是第一行
export const shouldMarkPlatform = (device: ActiveDevice) => !device.isRemote;              // App 的 effect 用
export function DesktopRoot({ fallback, shell, renderApp = () => <App/> }: { fallback: VonvonClient; shell?: ShellCapabilities; renderApp?: () => ReactNode }) {
  const devicesShell = shell?.devices;
  const [state, setState] = useState<DevicesState>();
  useEffect(() => devicesShell?.onState(setState), [devicesShell]);
  const localPlatform = desktopPlatformMark(state);
  useEffect(() => { if (localPlatform) document.documentElement.dataset.desktopPlatform = localPlatform; }, [localPlatform]);
  return <DesktopRootView state={state} fallback={fallback} shell={shell} renderApp={renderApp}/>;
}
// 没有 effect，测试用 renderToStaticMarkup 直接给 state。
export function DesktopRootView({ state, fallback, shell, renderApp }: { state?: DevicesState; fallback: VonvonClient; shell?: ShellCapabilities; renderApp: () => ReactNode }) {
  const devicesShell = shell?.devices;
  const device = state ? activeDeviceFrom(state) : LOCAL_ACTIVE_DEVICE;
  const client = useMemo(() => devicesShell ? devicesShell.clientFor(device.id) : fallback, [devicesShell, device.id, fallback]);
  if (!devicesShell) return <ClientProvider client={fallback} shell={shell}><DirectoryPickerProvider>{renderApp()}</DirectoryPickerProvider></ClientProvider>;
  if (!state) return <OutsideWindow shell={shell}><h1>正在打开 Vonvon Bot…</h1></OutsideWindow>;
  return <ClientProvider client={client} shell={shellForDevice(shell, device)} device={device} devices={state}>
    <DeviceGate key={device.id} state={state} renderApp={renderApp}/>
  </ClientProvider>;
}
export function DeviceGate({ state, renderApp }) {
  const a = state.active;
  if (a.id === 'local') return <DirectoryPickerProvider>{renderApp()}</DirectoryPickerProvider>;
  if (a.phase === 'connecting' || a.phase === 'failed') return <DeviceConnectionView/>;
  if (a.mode === 'maintenance') return <MaintenanceView/>;          // ready 或 reconnecting，U1a 在 reconnecting 时保留上次的 mode
  return <DirectoryPickerProvider>{renderApp()}</DirectoryPickerProvider>;   // ready/full，或连上过又在重连
}
```

- `key={device.id}`：切换时整棵页面树重建，包括 `DraftGuardProvider`、`DesktopUpdateProvider`、`DirectoryPickerProvider` 和各页的本地状态。同一台设备重连时不重建，页面留着旧数据，顶部出提示条（4.6）。
- 每台设备的页面用的是 `clientFor(device.id)` 绑定的 client（U1a 4.6），它发出的请求只会到这台。
- 窗口外框的平台标记只按本机那一行设，不看正在看的设备。
- `renderApp` 只给测试注入，生产里就是 `<App/>`。

**`App` 以外的页面**（加载页、`DeviceConnectionView`、`MaintenanceView`）共用 `OutsideWindow`：

```tsx
export const quitOutsideApp = (shell: ShellCapabilities | undefined, onError: (message: string) => void) => () =>
  void shell?.quit?.().catch(error => onError(error instanceof Error ? error.message : '后台服务尚未确认停止，请稍后再试。'));
export function OutsideWindow({ shell, children }: { shell?: ShellCapabilities; children: ReactNode }) {
  const [quitError, setQuitError] = useState<string>();
  useEffect(() => shell?.onQuitRequested?.(quitOutsideApp(shell, setQuitError)), [shell]);
  return <div className="device-outside-window">
    <div className="desktop-titlebar" aria-hidden="true"/>
    <main className="app-connection-state">{children}{quitError && <p role="alert">{quitError}</p>}</main>
  </div>;
}
```

- 退出：今天只有 `App` 订 `onQuitRequested`（第 3 节）。不在 `App` 里时按 Cmd+Q 或托盘"退出"没人接，请求还会被 facade 记成 `pendingQuit`，切回 `App` 时突然退出。`OutsideWindow` 里的 effect 订它：这里没有草稿，不经过 `DraftGuard`，直接 `shell.quit()`；失败的文字和 `App` 一样。`App` 和 `OutsideWindow` 不会同时挂着，订阅者总是一个。
- 标题栏：`devices.css` 加
  - `.device-outside-window { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 100dvh; }`；
  - `html[data-desktop-chrome="silver"] .device-outside-window { grid-template-rows: 34px minmax(0, 1fr); }`，全屏（`data-desktop-fullscreen="true"`）时回到一行；
  - `html[data-desktop-chrome="silver"] .device-outside-window :is(button, a, input, textarea) { -webkit-app-region: no-drag; }`。
  `.desktop-titlebar` 自己的样式（34px、可拖动、全屏隐藏）沿用 `desktop.css`。不这样，Mac 的红黄绿按钮压在连不上页的标题上，窗口也拖不动，而用户在连不上时停在这一页。

### 4.2 `U/App.tsx`

- 285-295：effect 里先取 `const device = useActiveDevice()`。页面按设备重建，所以闭包里的值不会变。只在 `shouldMarkPlatform(device)`（4.1）为真时写 `dataset.desktopPlatform`，网页端照旧写。
- `Page` 加 `'devices'`（`collaboration-model.ts:2`）；`titles` 加 `devices: '设备'`；在设置页那一串条件渲染里加 `{page === 'devices' && <DevicesPanel/>}`。
- `SettingsHome` 674 传 `devices={Boolean(shell?.devices)}`。
- 643 `{feedback}` 之后插 `<DeviceStatusBanner/>` 和 `<DeviceVersionNotice onUpgrade={() => openPage('application')}/>`。两个都只在远程时有内容。
- `<AppShell` 603 加 `deviceSwitcher={<DeviceSwitcher onManage={() => openPage('devices')}/>}`。
- `searchEntries(snapshot, { …, devices: Boolean(shell?.devices) })`。

### 4.3 `U/LocalShell.tsx`、`U/TodayHome.tsx`、`U/search.ts`

- `AppShell` 的 props 加 `deviceSwitcher?: ReactNode`，渲染在 `.today-header-actions`（22-26）里的第一个，搜索按钮前面。
  - 不做成 `.today-app-header` 的第四个子元素：表头是三列的网格（`today.css:20` 把操作区放在第 3 列），多一个子元素会把右侧操作挤到第二行。
  - `.today-header-actions` 本来就在 `!firstUse` 的条件外面，远程那台还没有 bot 时也能切回来；外框下它已是 `no-drag`（`desktop.css:97`）。
- `settingsEntries`（今天 8 项，`SettingsHome` 按 `slice(0, 4)`"模型与工具"、`slice(4)`"连接与应用"分组）在下标 4 插 `{ page: 'devices', title: '设备', description: '加别的设备，切换着管理', icon: MonitorSmartphone }`，也就是 `setup`（飞书连接）前面。
  - 图标用 lucide 里现有的那个，名字以实现时为准。
  - `SettingsHome` 加 `devices?: boolean`，为假时在切分之前滤掉这一条，网页端没有这页。
  - 插在下标 4：`slice(0, 4)` 还是原来四项；"设备"是"连接与应用"的第一项，原来那四项顺延到第 2–5 项，没有哪一项换组。`devices` 为假时滤掉后两组和今天一模一样。
- `searchEntries` 的 `capabilities` 加 `devices?: boolean`。为真时在页面表里加 `{ id: 'devices', title: '设备', aliases: ['远程', '添加设备', '切换设备', '连接链接', '配对', 'Tailscale', '服务器'], page: 'devices' }`。"服务器"只作搜索词，界面上不出现。

### 4.4 `U/devices/DeviceSwitcher.tsx`

- 只在 `state.devices.length > 1` 时显示，网页端（没有 `devices`）不显示。
- 按钮：状态点 + 当前设备名（本机写"这台电脑"）+ 下箭头。`aria-label` 写"当前设备：<名字>，点击切换"。
- 点开是一个小菜单：
  - 每台一行：状态点、名字，当前那台标"当前"。
  - 末尾一行"管理设备…"，调 `onManage`。
- 点某台时 `navigate(() => void devices.switchTo(id).catch(reportSwitchFailure))`，走 `useDraftGuard().navigate`。有未保存的修改时照旧先确认；自动保存的先保存，存完才切，这样保存发往原来那台。
- `reportSwitchFailure` 只在控制台记，切换失败在页面上由状态反映。

### 4.5 `U/devices/DevicesPanel.tsx`（"设备"页）

- 标题"设备"。说明一行："一次看一台。切换后，整个界面都换成那台设备上的 Vonvon Bot。"
- 列表状态不正常时，顶部出 `InlineNotice`（文案在 4.9）：`registry` 是 `recovered`、`newer` 或 `unreadable`，或者 `secureStorage` 为假。
- 每行（`rowView(row, now)` 给出文字和色调）：
  - **这台电脑**：主文字"这台电脑"，副文字是本机的名字和系统；状态点；版本；不是当前时显示"切换到"。不能删，也不能在这里改名。
  - **远程设备**：名字、系统（macOS / Windows / Linux）、状态点和状态字、版本、"切换到"（当前且在线时灰掉）、"改名"、"删除"。
    - 状态是 `revoked` 或 `needs-pairing` 时，多一个"重新配对"，打开 `AddDeviceDialog`，并带上 `repairOf: row`。
  - 状态点的颜色：
    - 在线：绿。
    - 正在连接、重连中：黄。
    - 版本不一致：橙。
    - 连不上、已撤销、需要重新配对：红。
    - 上次在线、还没连过：灰。
    - 不用动画。
- "改名"：行内输入框。客户端先用 `deviceAliasSchema` 校验（1–40 字，不含控制字符），不过就在框下写"名字要 1 到 40 个字。"；过了再调 `devices.rename`。
- "删除"：确认框（4.9 的删除确认）。
  - 确定后调 `devices.remove`。
  - 回 `revokedRemotely: false` 时，页面上留一条提示（4.9"删了但对面还记着"）。
- "切换到"：`navigate(() => void devices.switchTo(id))`。
- "添加设备"按钮在列表上方。`secureStorage` 为假，或 `registry` 不是 `ok`/`recovered` 时灰掉，旁边写原因。
- 页底：`<TailscaleAdvice/>`。

### 4.6 `U/devices/AddDeviceDialog.tsx`

组件内部用一个纯 reducer `addDialogReducer`，可单测。几个阶段：

1. **粘贴**：多行输入框"连接链接"。
   - 下面写怎么拿链接："在要连接的设备上运行 `vonvon pair`，或者在那台电脑的 Vonvon Bot → 设置 → 应用与启动 →「允许别的设备连接」里点「生成连接链接」。链接 10 分钟内有效，只能用一次。"
   - 输入变化后 150 ms 调 `devices.inspect`。回 `ok: false` 就在框下写对应文案（4.9），按钮灰掉。
2. **确认**（`ok: true`）：
   - 显示"设备：<链接里的名字>"。
   - 地址列表，每条写类型："Tailscale（推荐）""局域网""运营商地址""公网"，再跟 `host:port`。
   - 剩余时间"还剩 8 分钟"，每 30 秒刷新，到 0 时按钮灰掉并改写过期文案。
   - 名字输入框，默认链接里的名字。
   - 主按钮"连接并添加"。
   - 重新配对时标题是"重新配对「X」"。链接的 `deviceId` 不是要修的那台时，写"这条链接是「Y」的，不是「X」的。"，照样允许添加。
3. **进行中**：
   - 读 `useDevicesState().adding`：`connecting` 写"正在连接 <host:port>…"，`pairing` 写"正在配对…"，`checking` 写"正在核对版本…"。
   - 次按钮"取消"调 `devices.cancelAdd()`。
4. **完成**：
   - `added` → "已添加「X」。"，按钮"切换到「X」"和"完成"。
   - `updated` → "「X」已经在列表里了，已按新链接更新了它的地址。"
5. **失败**：
   - `failureCopy(code, name)`，下面接 `routeHints(attempts, name)`，每条尝试过的地址一行。
   - `link_used`、`link_expired`、`pairing_failed` → 按钮"粘贴新链接"，清空回到第 1 步。
   - 其余 → "再试一次"（同一条链接，没过期时）和"关闭"。

关闭对话框时清掉链接文本。链接文本只放在这个组件的 state 里，不进 context，也不进日志。对话框在 `DeviceConnectionView` 里也能用：它只依赖 `shell.devices` 和设备状态，不需要 `DraftGuard`。

### 4.7 `U/devices/DeviceConnectionView.tsx` 和 `MaintenanceView.tsx`

两者共用一个外框 `DeviceOutsideFrame`，最外层是 4.1 的 `OutsideWindow`（`shell` 取 `useShellCapabilities()`），所以有标题栏、能拖动、能退出：
- 顶部是设备名和状态。
- 底部有"回到这台电脑"，以及"其他设备"的紧凑列表，可以直接切；也能"添加设备"。
- 这时不在 `App` 里，没有草稿，切换不用经过 `DraftGuard`。

**连接中、连不上、已失败**（`phase` 为 `connecting` 或 `failed`）：
- `connecting`，还没失败过：标题"正在连接「X」…"。
- `connecting`，失败过（`failure` 存在）：
  - 标题"连不上「X」"。
  - 正文 `failureCopy(failure.code, name)`，下面每条 `failure.attempts` 一行 `routeHint`。
  - "<N> 秒后再试一次"，按 `retryAt` 每秒倒数。
  - 按钮"现在重试"，调 `devices.retry()`。
- `failed`，按问题写（4.9）：
  - `revoked`、`identity_changed`、`unknown_client` → 按钮"重新配对"。
  - `key_unreadable` → 按钮"重新配对"和"再试一次"。
- 尝试过的地址里有 `tailscale`，或失败码是网络类（`refused`、`unreachable`、`timeout`）时，附 `<TailscaleAdvice/>`。

**维护视图**（`mode === 'maintenance'`）：
- 标题"「X」和这台电脑的版本不能一起工作"，正文 `versionNotice(...)` 的文字。
- 服务端旧，`capabilities` 含 `update.standalone` 或 `update.npm`：
  - 显示 I3 的 `UpdatePanel`，外面包 `DraftGuardProvider` 和 `DesktopUpdateProvider`。
  - U2 把服务端那一段抽成 `ServerUpdateCard`（U2 计划 4.4.2）。顺序是定的：U2 依赖 U1a，U1a、U1b 是一个 PR，所以本片先合入，U2 再把这里换成 `<ServerUpdateCard variant="remote">`。`request` 照样传 `maintenanceRequest(...)`。
  - `request` 传 `maintenanceRequest(client.machine)`：请求不在 `MAINTENANCE_KINDS` 里就在本地拒绝，回"版本不一致时只能做升级"，不发出去。维护子集以外的请求，D1 的 `authz.ts` 回 `permission_denied`（D4a 换成 `protocol_mismatch`），连接不关，界面不该发这种请求；只有反复越界（D4a 计划 4.4：连续 20 条）服务端才以 4001 关掉连接。
  - 含 `update.bundled` 的按钮归 U4，本片只写文字。
  - I3 没合入时也只写文字。
- 客户端旧：显示"这台电脑上的应用"的更新：`DesktopUpdateButton`，外面包 `DesktopUpdateProvider`。
- 服务端旧，有 `capabilities` 但不含任何 `update.*`：只写 `versionNotice` 的文字，再接 4.9 的"不能远程升级"那句，没有按钮。D1 的 v2 daemon 只报 `['device']`，`update.standalone`、`update.npm` 要到 U2 才报（U2 计划 4.11），所以本片合入后、U2 合入前，对面服务端旧时走的都是这一条。
- 没有 `capabilities`：只写"服务端太旧"的文案，没有按钮。

### 4.8 `U/devices/DeviceStatusBanner.tsx` 和 `DeviceVersionNotice.tsx`

只在当前是远程、页面在显示（`ready` 或 `reconnecting`）时出现，放在 `App` 的页面最上方（4.2）。

**提示条**按优先级取一条（文案见 4.9）：
1. `phase === 'reconnecting'`：
   - `expected === 'restart'` → 重启中。
   - `expected === 'stop'` → 已停止。
   - `active.disabledAt` 有值 → 对面关了远程连接。看 `disabledAt`，不看 `failure.code`：4006 之后的重连会得到 `refused`，`failure.code` 第一次失败就变了（U1a 4.4"断了"）。
   - 其余 → 正在重连，倒数到 `retryAt`；`attempt >= 3` 时下面接 `routeHints`。
   - 都带"现在重试"按钮，调 `devices.retry()`。
2. `ready` 且有 `notice`：
   - `restarted` → "「X」重启过了，已重新连上。"
   - `updated` → "「X」已更新到 0.9.1。"
   - 带关闭按钮；关掉的按 `notice.at` 记在组件 state 里。

**版本提示**：`ready/full` 时用 `versionNotice` 比较 `active.serverInfo.version` 和 `state.client.version`，相同就不显示。
- 服务端旧：文字加按钮"升级「X」"。只有 `capabilities` 含 `update.standalone`、`update.npm` 或 `update.bundled` 时才给按钮，按钮调 `onUpgrade`，到"应用与启动"页。
- 客户端旧：文字加按钮"去更新"，同样到"应用与启动"页。
- 可以关掉。关掉的按 `deviceId + 两个版本` 记在模块级的 `Set` 里，这次运行内不再出现。

### 4.9 `U/devices/devices-presentation.ts`（纯函数，全部文案）

导出：`rowView(row, now)`、`statusLabel`、`statusTone`、`platformLabel`、`routeKindLabel`、`routeHint(route, code, name)`、`routeHints(attempts, name)`、`failureCopy(code, name)`、`linkPreviewCopy(code, name)`、`registryNotice(state)`、`bannerCopy(active, name, now)`、`versionNotice({ serverVersion, serverProtocol, clientVersion, clientProtocol, capabilities, name })`、`compareVersions(a, b)`、`maintenanceRequest(machine)`、`relativeTime(at, now)`。`name` 一律已经是 `deviceCopyName` 的结果。

**相对时间 `relativeTime`**：不复用 `conversationTime`（它出时刻和日期，第 3 节）。不到 1 分钟"刚刚"；不到 1 小时"N 分钟前"；不到 24 小时"N 小时前"；不到 7 天"N 天前"；再早写"M月D日"，不是今年的加"YYYY年"。`at` 比 `now` 晚（两台的钟不一样）也写"刚刚"。

**系统 `platformLabel`**：`macos` → macOS，`windows` → Windows，`linux` → Linux。`unsupported` 和没有（v1 的对面不报这个字段）回空字符串，行上就不显示系统这一项，不写"未知"。

**状态字**：

| 状态 | 字 |
|---|---|
| `online` | 在线 |
| `connecting` | 正在连接 |
| `reconnecting` | 重连中 |
| `offline` | 连不上 |
| `maintenance` | 版本不一致 |
| `revoked` | 已撤销 |
| `needs-pairing` | 需要重新配对 |
| `unknown`，有 `lastConnectedAt` | 上次在线 <相对时间> |
| `unknown`，没有 | 还没连过 |

**按地址类型的提示 `routeHint`**（设计第 15 节"客户端连不上"，有两处改动，见第 7 节）：

| 类型 | 文字 |
|---|---|
| `tailscale` | 连不上「X」（100.x.y.z）。两台设备都登录了同一个 Tailscale 账号吗？在这台电脑上运行 `tailscale ping 100.x.y.z` 看看。 |
| `lan` | 连不上「X」（192.168.x.x）。两台设备在同一个局域网里吗？那台设备开着吗？ |
| `cgnat` | 连不上「X」（100.x.y.z）。这是运营商分配的地址，一般从外面连不进去，建议两台都装上 Tailscale。 |
| `public` | 连不上「X」（x.x.x.x）。那台设备的防火墙放行了 <端口> 端口吗？ |
| 码是 `forbidden` 时，不分类型 | 「X」在 <host:port> 上没有开放连接，它可能换了地址。在那台设备上重新生成连接链接，粘到"添加设备"里，会自动更新地址。 |
| 码是 `refused` 时，接在类型那句后面 | 那台设备上的 Vonvon Bot 可能没在运行，或者没有允许别的设备连接。 |
| 码是 `device_identity_changed` 时，不分类型 | <host:port> 上的 Vonvon Bot 不是「X」，可能是同一个网络里别的电脑换到了这个地址。会接着试别的地址；都不行就在「X」上重新生成连接链接，粘到"添加设备"里更新地址。 |

**失败和问题 `failureCopy`**：

| 码 | 文字 |
|---|---|
| `client_revoked`、`revoked` | 「X」已取消这台电脑的访问。要再连，请在那台设备上重新生成连接链接。（设计第 15 节） |
| `device_identity_changed`、`identity_changed` | 「X」的身份和配对时不一样了（可能重装过，或换了数据目录）。为安全起见已断开。确认是你自己的设备后，重新配对。（第 15 节） |
| `unknown_client` | 「X」不认识这台电脑了，那台设备上的配对记录可能被清掉了。在那台设备上生成新链接，重新配对。 |
| `key_unreadable` | 读不出连接「X」用的密钥：系统钥匙串拒绝了，或者应用换过签名。可以再试一次；还不行就重新配对。 |
| `remote_disabled` | 「X」关闭了远程连接，或者换了地址。在那台设备上重新开启（运行 `vonvon remote enable`，或在「允许别的设备连接」里选一个地址）后，这里会自动连上；换了地址的话，在那台设备上生成新的连接链接，粘到"添加设备"里，只会更新地址，不用重新配对。（A1 改） |
| `rate_limited` | 「X」暂时拒绝了这台电脑：短时间内连得太多次。1 分钟后会自动再试。 |
| `handshake_failed` | 和「X」建立加密连接失败。会自动再试；一直失败的话，在那台设备上重新生成链接、重新配对。 |
| `protocol_mismatch` | 「X」和这台电脑的版本不能一起工作。 |
| `refused`、`unreachable`、`timeout`、`closed` | 连不上「X」。（后面接每条地址的 `routeHint`） |
| `link_used`、`pairing_failed` | 这条链接已经被用掉了。如果不是你用的，请马上到「X」上撤销它：在那台设备的「允许别的设备连接」里，或者运行 `vonvon clients ls` 查看最近配对的设备、`vonvon clients revoke <id>` 撤销。然后生成一条新链接。 |
| `link_expired` | 这条链接已经过期（10 分钟内有效）。在「X」上重新生成一条。 |
| `busy` | 正在添加另一台设备，等它完成。 |
| `aborted` | 已取消。 |
| `registry_write_failed` | 没能保存设备列表，这次没有添加。再试一次。 |
| 配对中途断开、补连也没成功 | 连接在配对中途断了。在「X」的「允许别的设备连接」里看一下有没有这台电脑：有就直接重试，没有就生成新链接。 |
| 链接预览的码（`invalid_link`、`already_added` 等，`add` 时才发现的） | 用下面 `linkPreviewCopy` 的那句 |
| 其他 | 没能连上「X」（<码>）。 |

**链接预览 `linkPreviewCopy`**：

| 码 | 文字 |
|---|---|
| `invalid_link` | 这不是 Vonvon Bot 的连接链接。链接以 `vonvon://pair#` 开头：在要连接的电脑的 Vonvon Bot → 设置 → 应用与启动 →「允许别的设备连接」里点「生成连接链接」；Linux 主机上运行 `vonvon pair`。 |
| `link_expired` | 同上表 |
| `own_link` | 这是这台电脑自己的链接，不用添加。把它粘到另一台电脑的 Vonvon Bot 里。 |
| `already_added` | 「X」已经在设备列表里了。（按钮：切换到「X」） |
| `no_secure_storage` | 这台电脑的系统钥匙串现在用不了，没法安全地保存连接密钥，暂时不能添加设备，也不能重新配对。 |

**不能远程升级**（维护视图，有 `capabilities` 但没有 `update.*`，4.7）："「X」上的这个版本还不能从这里升级，请在那台设备上升级 Vonvon Bot。"
| `registry_newer` | 设备列表是更新版本的 Vonvon Bot 写的，这个版本只能看、不能改。先更新这台电脑上的应用。 |
| `registry_unreadable` | 读不了设备列表文件，暂时不能添加设备。看一下 Vonvon Bot 的数据目录权限。 |
| `too_many` | 最多加 32 台设备。先删掉不用的。 |

**列表状态 `registryNotice`**：`recovered` → "设备列表文件损坏了，已另存一份并重新开始。之前加过的设备要重新添加。"；`newer`、`unreadable`、`secureStorage` 为假时，同上表对应的那句。

**删除**：
- 确认框标题"从列表里删除「X」？"。
  - 当前且在线时，正文"会同时让「X」取消这台电脑的访问。"
  - 否则"这台电脑会忘掉连接它的密钥。「X」上还留着这台电脑的配对记录，可以在那边撤销。"
- 按钮"删除"。
- 删了但对面还记着：提示"已从列表里删除「X」。它上面还留着这台电脑的配对记录，到那台设备的「允许别的设备连接」里撤销，或运行 `vonvon clients revoke`。"

**提示条 `bannerCopy`**：

| 情况 | 文字 |
|---|---|
| 重连中 | 和「X」的连接断了，正在重连（<N> 秒后再试）。 |
| 重启中（`expected: restart`） | 「X」正在重启，好了会自动连上。 |
| 已停止（`expected: stop`） | 「X」的后台服务已停止，只能在那台设备上重新启动。启动后这里会自动连上。 |
| 对面关了远程 | 同 `remote_disabled` |
| 重启过 | 「X」重启过了，已重新连上。 |
| 升级过 | 「X」已更新到 <版本>。 |

**版本 `versionNotice`**：`compareVersions` 按 `x.y.z` 逐段比数字，带 `-` 后缀的预发布版小于同号正式版。

| 情况 | 文字（设计第 15 节） |
|---|---|
| 协议相同，服务端旧 | 「X」的服务端是 <a>，这台电脑是 <b>。可以继续用；建议升级服务端。 |
| 协议相同，客户端旧 | 这台电脑的 Vonvon Bot（<b>）比「X」（<a>）旧。建议先更新这台电脑上的应用。 |
| 协议不同，服务端旧 | 「X」的服务端是 <a>，这台电脑是 <b>，两边不能一起工作。升级服务端后才能继续管理。 |
| 协议不同，客户端旧 | 这台电脑的 Vonvon Bot（<b>）比「X」（<a>）旧，两边不能一起工作。先更新这台电脑上的应用。 |
| 没有 `capabilities`（v1） | 「X」上的 Vonvon Bot（<a>）不支持远程管理，请在那台设备上升级一次。 |

**`TailscaleAdvice`**：写法照 Orca，先说推荐什么、为什么，再给退路：
> 推荐用 Tailscale 把两台设备连起来：两台都装上 Tailscale、登录同一个账号，就能用 100.x 开头的地址直接连，不用开端口，也不经过公网。没有 Tailscale 也可以：两台在同一个局域网里时，用局域网地址。

后面跟一个链接"下载 Tailscale"，地址是 `https://tailscale.com/download`。它需要在 `url-actions.ts` 加一个种类 `tailscale`，只认这个确切的 URL，并在 `DT/bridge.ts:19` 的 `externalKinds` 里加上。

**用词检查**：本文件所有文案里没有"服务器"，也没有"登录 Codex""登录 Claude"这类说法，测试里核（4.9 的测试）。说"登录同一个 Tailscale 账号"可以。

## 5. 测试

都在 `packages/ui/test/`，用 `renderToStaticMarkup` 和纯函数，沿用现有的写法。静态渲染不跑 effect，ui 包也没有 jsdom，所以靠 effect 的东西（设备状态的订阅、平台标记、退出订阅）都拆成纯函数或 `DesktopRootView` 来测。

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `devices-presentation.test.ts`（新） | 状态字 | 每种 `status` → 上表的字；`unknown` 带 `lastConnectedAt` 5 分钟前 → "上次在线 5 分钟前"。main 必败 |
| 同上 | 地址提示 | `tailscale` 100.64.0.10 → 含 `tailscale ping 100.64.0.10`；`lan` → 含"同一个局域网"；`cgnat` → 含"运营商"；`public` 端口 17767 → 含"17767"；`forbidden` → 含"重新生成连接链接" |
| 同上 | 失败文案 | 失败表里每个码 → 非空，含"「X」"（`busy`、`aborted`、`registry_write_failed` 除外）；`link_used` 含 `vonvon clients ls` |
| 同上 | 版本 | (0.9.0, 2) 对 (0.9.1, 2) → "建议升级服务端"、有升级动作；(0.9.2, 2) 对 (0.9.1, 2) → "先更新这台电脑"；(0.9.0, 2) 对 (0.10.0, 3) → "两边不能一起工作"、服务端旧；协议 3 对客户端 2 → 客户端旧、阻断；没有 `capabilities` → v1 那句、没有动作；相同版本 → `null` |
| 同上 | 版本比较 | `0.10.0 > 0.9.9`；`0.9.0-beta.1 < 0.9.0`；`0.9.0 == 0.9.0` |
| 同上 | 相对时间 | `now` 减 30 秒 → "刚刚"；减 5 分钟 → "5 分钟前"；减 3 小时 → "3 小时前"；减 2 天 → "2 天前"；减 10 天 → "M月D日"；去年 → 带年份；比 `now` 晚 → "刚刚" |
| 同上 | 系统 | `macos`、`windows`、`linux` → 三个名字；`unsupported`、`undefined` → 空字符串，`rowView` 不出系统这一项 |
| 同上 | 用词 | 导出的所有文案里没有"服务器"，没有"登录 Codex""登录 Claude""Vonvon 不代你登录" |
| 同上 | 维护请求 | `maintenanceRequest(fake)({ type: 'status' })` 被拒、fake 没收到；`checkCoreUpdate` 转发 |
| `devices-panel.test.tsx`（新） | 列表 | 状态里本机 + A（在线、当前）+ B（`revoked`）→ 第一行"这台电脑"且没有"删除"；A 的"切换到"灰掉；B 有"重新配对"、红点；页底有 Tailscale 建议。main 必败 |
| 同上 | 不能添加 | `secureStorage: false` → "添加设备"灰掉，旁边是 `no_secure_storage` 那句 |
| 同上 | 列表坏过 | `registry: 'recovered'` → 顶部提示"已另存一份" |
| `add-device-dialog.test.tsx`（新） | reducer | 粘贴 → `inspect` 回 ok → 确认阶段带默认名字；`add` 回 `failed: link_used` → 失败阶段、按钮"粘贴新链接"；点它 → 回粘贴、链接清空 |
| 同上 | 确认阶段 | 预览两条地址（tailscale、lan）→ "Tailscale（推荐）""局域网"各一行；`expiresAt` 已过 → 按钮灰掉 |
| 同上 | 重新配对别的设备 | `repairOf: A`，链接是 B → 显示"这条链接是「B」的" |
| `device-gate.test.tsx`（新，从 `../src/devices/DesktopRoot` 直接 import `DeviceGate`、`DesktopRootView`，注入 `renderApp`） | 本机 | `active.id = 'local'` → 渲染 `renderApp` |
| 同上 | 外框 | `DesktopRootView` 不给 `state` → 加载页；`connecting`、`failed`、`maintenance` 各一次 → 输出里都有 `device-outside-window` 和 `desktop-titlebar` |
| 同上 | 连接中 | 远程 `connecting`，没有 `failure` → "正在连接「X」"；有 `failure`（`unreachable`、一条 tailscale 地址）→ "连不上「X」"、`tailscale ping`、"现在重试" |
| 同上 | 已撤销 | `failed` + `client_revoked` → "已取消这台电脑的访问"、"重新配对"、"回到这台电脑"。main 必败 |
| 同上 | 维护 | `ready` + `maintenance`、服务端旧 → 维护视图，没有渲染 `renderApp` |
| 同上 | 重连中留着页面 | `reconnecting`、上次 `full` → 渲染 `renderApp` |
| 同上 | 客户端绑定 | 切换前后 `clientFor` 被以 `'local'`、`A` 调用；`ClientProvider` 里的 client 是 `clientFor(A)` 的返回值 |
| `device-platform.test.ts`（新，纯函数） | 窗口外框 | 本机行 `platform: 'macos'`、当前远程 `linux` → `desktopPlatformMark(state) === 'macos'`；`shouldMarkPlatform(远程)` 为假、`shouldMarkPlatform(LOCAL_ACTIVE_DEVICE)` 为真。main 必败 |
| 同上 | 不在 App 里退出 | 假 `shell.quit` → `quitOutsideApp(shell, onError)()` 调一次 `quit`；`quit` reject → `onError` 收到文字，不抛错；`shell` 没有 `quit` → 什么都不做 |
| `device-switcher.test.tsx`（新） | 只有本机 | 不渲染 |
| 同上 | 位置 | 渲染 `AppShell` 带 `deviceSwitcher` → 它在 `.today-header-actions` 里、搜索按钮前面；`firstUse` 时也在 |
| 同上 | 有远程 | 显示当前名字和状态点；菜单列出全部设备，当前那台标"当前"，末尾"管理设备…" |
| `device-status-banner.test.tsx`（新） | 提示条 | 远程 `reconnecting`、`expected: 'restart'` → "正在重启"；`notice: updated` → "已更新到 0.9.1"；`disabledAt` 有值、`failure.code: 'refused'` → "关闭了远程连接"，不是"可能没在运行" |
| `connection.test.ts`（改） | 不受影响 | 加 `vi.mock("../src/devices/DesktopRoot", …)`，原有用例照过 |
| `search.test.ts`（改） | 设备页 | `devices: true` → 有 `id: 'devices'`；不传 → 没有 |
| `settings-home` 相关测试（改，现有文件名以实现时为准） | 入口 | `devices` 为真 → "模型与工具"组仍是原来四项，"设备"在"连接与应用"组第一项、后面依次是飞书连接、导入 Bridge、应用与启动、状态与诊断；为假 → 两组和今天一样，没有"设备" |
| `url-actions` 测试（改） | 白名单 | `https://tailscale.com/download` 在 `tailscale` 种类下通过；`https://tailscale.com/download?x=1`、`http://…`、`https://evil.com` 不过 |

## 6. 自测和验收

**删除文件的硬规矩**（`~/.claude/CLAUDE.md`，原样照抄）：
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。

### 6.1 Claude 在 JP-VPS 上（无头）

1. 单测（根目录的 vitest 不收 `.tsx`，在 ui 包里跑）：
   `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npm test -w packages/ui -- test/devices-presentation.test.ts test/devices-panel.test.tsx test/add-device-dialog.test.tsx test/device-gate.test.tsx test/device-platform.test.ts test/device-status-banner.test.tsx test/device-switcher.test.tsx test/connection.test.ts test/search.test.ts`
   再在锁里跑 U1a 第 6 节第 1 步的那组测试，然后 `flock /tmp/vonvon-heavy.lock` 跑 ui、desktop 的 `typecheck`、`lint`、`build`。最后 `rm -rf -- "${T:?}"`。
2. U1a 第 6 节第 2 步的真通道探针：添加、切换、撤销 1 秒内、4006、重启、删除。
3. 页面截图，可选，给审查者看：
   - 用 VPS 上的无头浏览器打开 ui 的构建产物，注入一个假的 `window.vonvonShell`。它带 `devices`，状态按场景写死；脚本放 `packages/ui/test/manual/devices-fake-shell.ts`，不进 vitest。
   - 场景：设备页有三台（在线、已撤销、上次在线）；添加对话框的确认阶段；连不上页（tailscale 地址）；维护视图；重连提示条。
   - 截图贴 PR，只用假名字和文档地址段。

### 6.2 Mac 上的 Codex（#322）：真机验收

交给 Mac：只有桌面端外壳能连远程设备，设备页、切换和远程连接都在外壳里，网页端碰不到。所以这里**用 Computer Use**，不用网页控制。不发飞书消息。

前提：D2、D3 已合入集成分支；PR 已推上去。

Claude 先在 JP-VPS 上准备（不进提示词正文的真实地址和数据目录只用占位）：
1. 拿验收 daemon 的目录锁：`mkdir /tmp/accept-user.d`，并写上 `claude <UTC 时间>`。
2. 记下验收 worktree 现在的 sha，把它切到 PR 的 sha（detach），构建 daemon，用它重启验收 daemon（Bot 6 那套数据）。
3. 用前缀 `VONVON_HOME=<验收数据目录>` 运行 `vonvon remote enable "$(tailscale ip -4)"`（A1 去掉了 `--tailscale`），端口用默认 7767；被占就 `remote port 17767`，并在提示词里写明。
4. 后台起验收助手 `packages/desktop/test/manual/devices-accept-helper.ts`。助手进 git，只在本 PR 里用。
   - 它只绑 `<JP-VPS 的 Tailscale 地址>:<助手端口>`，只有 tailnet 里的设备能连。不带令牌，链接不经过 GitHub。
   - 两小时后自己退出。
   - 每个接口在子进程环境里带 `VONVON_HOME` 跑一条 `vonvon` 命令，回 JSON：
     - `POST /link` → `vonvon pair --json` 的链接。
     - `POST /restart` → `vonvon daemon restart`。
     - `POST /remote/disable`、`POST /remote/enable`。
     - `POST /revoke` → 撤销助手启动后新配对的 `desktop` 客户端，回 `revokedAt`。
     - `GET /status` → daemon 的 pid、`startedAt`，以及助手启动后新配对的客户端和它们的 `revokedAt`。
   - 日志不记链接。

提示词贴进 PR，任务贴 #322，任务号用 `next-mac-task.sh` 取。提示词按 #322 的格式写清：
- 第 0 步查开始和结果标记；开始前、每次 push 前都看有没有取消。
- 隔离：在临时 worktree 里取 PR 的 sha，`npm ci`、构建。照 #322 正文"Mac 的测试环境"起开发版桌面端，前缀 `VONVON_DESKTOP_TEST_HOME=<临时目录>/desk VONVON_HOME=<临时目录>/vh`，不 export。
- 不碰的东西：owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和它的数据、飞书客户端。
- 上面三条删除规矩原样写进去。
- 结果评论的标记；结果打码：不贴链接、地址、群名、完整 id。

Mac 上的步骤（Computer Use 操作开发版桌面端；`curl` 在 Mac 终端里打 JP-VPS 的助手）。链接 10 分钟内有效，要再粘同一条链接的检查都紧跟在拿到它之后做：
1. 设置 → 设备：只有"这台电脑"；顶部没有设备标签。
2. `curl -fsS -X POST http://<JP-VPS 的 Tailscale 地址>:<助手端口>/link` 拿链接 → 设备 → 添加设备 → 粘贴。
   - 确认阶段：看到设备名，地址标"Tailscale（推荐）"，剩余时间不到 10 分钟。
   - 改名为"验收设备 1"，点"连接并添加" → "已添加"。
   - 弹出钥匙串授权（"Electron Safe Storage"）就点允许，并在结果里记一笔。
   - 马上把同一条链接再粘一次 → "已经在设备列表里了"，并有"切换到"按钮。
3. 顶部设备标签（在右上角搜索按钮左边）→ 切到它：
   - Bot 列表里有 Bot 6，群组数和 JP-VPS 上 `vonvon` 看到的一致。数字由 Claude 在提示词里给。
   - 标签显示新名字。
   - 窗口左上角红黄绿按钮旁的留白和切换前一样，外框没变成别的系统样式。截图对比，结果里用文字描述。
4. 切回"这台电脑"再切回去，用标签和设备页各两次。每次内容都对，没有报错条。
5. `POST /restart`：页面顶部先出"正在重连"或"正在重启"，45 秒内变成"重启过了，已重新连上"。
6. `POST /remote/disable`：提示条写"关闭了远程连接"。等 15 秒（这期间至少重连失败一次）再看，提示条还是这句，没有变成"可能没在运行"。`POST /remote/enable` 后 45 秒内自动连上，没有点任何按钮。
7. 撤销：
   - `POST /revoke`，`curl` 一返回就截图：页面已经换成"已取消这台电脑的访问"，并有"重新配对""回到这台电脑"。Computer Use 截一次图本身要一两秒，这里只核"很快就换了"（2 秒内）；1 秒的判据由 U1a 第 6 节第 2 步的同机探针核。
   - 参考值：回包里的 `revokedAt`（JP-VPS 的钟）和 `<临时目录>/desk/userData/devices.log` 里 `device-closed … code=client_revoked` 那一行的时间（Mac 的钟）相减，写进结果。两台的钟可能差几十毫秒，不拿它判对错。
   - 这一页：顶部有 34px 的标题栏，红黄绿按钮不压字；拖标题栏能移动窗口；按 Cmd+Q 能退出。退出后用同一条命令再启动开发版桌面端，停在"这台电脑"，设备页里那台是"已撤销"。
8. 设备页 → 删除这台。不在线，所以确认框写的是"这台电脑会忘掉连接它的密钥…"。
9. 用过的链接：
   - 再拿一条新链接，添加（不切过去）；设备页 → 删除它。
   - 10 分钟内把这条链接再粘一次 → 预览通过，点"连接并添加" → "这条链接已经被用掉了…`vonvon clients ls`…"。
10. 再拿一条新链接，添加，切过去，看到 Bot 6。
11. 退出开发版桌面端（菜单或托盘的"退出"）。`GET /status` 显示 daemon 的 pid 和 `startedAt` 没变：退出桌面端不碰对面。
12. 再启动开发版桌面端：
    - 停在"这台电脑"。
    - 设备页里那台显示"上次在线 …"，不是"在线"。
    - 切过去能连上。
13. 收尾：
    - 切到它 → 删除。在线，所以确认框写"会同时让…取消"。`GET /status` 显示这台客户端已撤销。
    - 关掉开发版桌面端，用 `git worktree remove` 删临时 worktree。

做不了的写进结果：
- 版本提示条和维护视图：三台装的是同一个版本，真机上出不来，靠第 5 节的单测和 6.1 第 3 步的截图。
- 4.4 的"未保存修改先确认"：在已有的 DraftGuard 测试里覆盖。

Claude 收尾：停助手；`remote disable`；撤销验收中配对的客户端；验收 worktree 切回原来的 sha，并重启验收 daemon；放锁 `rm -f /tmp/accept-user.d/owner && rmdir /tmp/accept-user.d`。

## 7. 文档

- `docs/product.md` 3.14，在实现 PR 里改。"配对"里"链接已经被别的设备用掉时，提示里列出最近配对的客户端"改成"链接已经被用掉时，提示到那台设备的「允许别的设备连接」或 `vonvon clients ls` 看最近配对的是谁，不是自己就撤销"。原因：客户端此时还没配上，看不到对面的客户端列表。
- `docs/plans/devices.md` 第 15 节，已在本计划的 PR 里改：
  - "客户端连不上"的 tailscale 一句改成"在这台电脑上运行 `tailscale ping <那台的地址>`"。客户端知道对面的地址，不一定知道自己的。
  - "链接已被用掉"一行按 4.9 改。
  - 其余新文案以本计划 4.9 为准，设计第 15 节注明"客户端一侧的完整文案见 `devices-ui-1b-devices-page.md` 4.9"。
- 合入时在设计第 13 节 U1b 行标"已合入"。

## 8. 验收要点

1. 全部文案在 `devices-presentation.ts`。没有"服务器"，没有暗示要登录订阅；远程设备一律"「名字」"。
2. `DeviceGate` 按 `key={device.id}` 重建；同一台重连不重建。
3. 每台设备的页面用 `clientFor(device.id)` 的 client，测试里核过。
4. 窗口外框的平台标记只按本机行设，`App` 在远程时不写。
5. 切换都经过 `DraftGuard.navigate`（标签、设备页）；`DeviceOutsideFrame` 里的切换不经过，因为那里没有草稿。
   - 切换标签在 `.today-header-actions` 里第一个，不改表头网格。
6. 维护视图只发 `MAINTENANCE_KINDS` 里的请求，别的在本地拒绝。有 `capabilities` 但没有 `update.*` 时只有文字。
   - 加载页、连接页、维护视图都在 `OutsideWindow` 里：有 34px 标题栏、能拖动，Cmd+Q 和托盘"退出"能退出，不会攒成 `pendingQuit`。
7. 版本提示：协议相同不拦，协议不同只留设备列表和升级面板（设计 4.6）；按钮只在 `capabilities` 有对应项时给。
8. 非当前设备不显示"在线"，只显示上次的结果；"上次在线"用本片自己的 `relativeTime`，`conversationTime` 不动。`unsupported` 和没有平台的设备不显示系统。
   - "关闭了远程连接"的提示条看 `active.disabledAt`，后续重连失败不把它换掉。
9. 链接文本只在对话框组件的 state 里，关闭即清。
10. 外链只多了 `https://tailscale.com/download` 这一条确切地址。
11. 验收助手只绑 Tailscale 地址、两小时自停、不记链接；在 PR 里写明它只为验收用。
12. diff 里没有真实 id、密钥、本机路径和地址；示例地址只用文档段和占位。

## 9. 风险和行数

- 估计约 1,500 行：
  - presentation 280、设备页 220、添加对话框 260、gate 和两个外部视图 230、提示条和版本提示 130、切换标签 100、App/LocalShell/TodayHome/search/main.tsx 的改动 120、css 80、url-actions 10、验收助手 120。
  - 测试约 500，压缩写。
- 和 U1a 合起来约 3,450 行。审查分法见 U1a 第 9 节：一个读整个 diff，两个按 `DT/`+`P/` 和 `U/` 分，再加一轮多角度审查。
- I3 的 `UpdatePanel` 如果在请求里带了维护子集以外的东西，维护视图里它会显示"版本不一致时只能做升级"，不会把连接弄断。I3 合入后实现时再核一次。
- Mac 能不能经 Tailscale 打到 JP-VPS 的助手端口，没有实测过。两台的 Paseo daemon 就是走 Tailscale 互通的，应该可以。不行就由 Claude 把链接经 `paseo send` 发给 Mac 上的 Codex 会话（要 owner 同意开 Paseo 会话），不经过 GitHub。
- 开发版桌面端的 `safeStorage` 用的是"Electron Safe Storage"钥匙串项，第一次会弹授权框，Computer Use 点允许；锁屏会让 Computer Use 失败，按 #322 的规矩停下写"卡住了"。
- 窗口外框的检查靠截图描述，比较主观。单测已经核了平台标记的纯函数，真机只是补一眼。
- 撤销后多久换页，Mac 上只能用截图核"很快"，跨机计时只作参考；1 秒的判据靠 JP-VPS 上的同机探针（U1a 第 6 节第 2 步）。

## 10. 审查后改了什么

2026-11-02，#640 上 Sonnet 审查（读整个 diff 一位，读 U1a+U1b 一位）。下面每条都接受了：

- 连接页、维护视图和加载页不在 `App` 里，没人订 `onQuitRequested`，Cmd+Q 和托盘"退出"无效，切回 `App` 时又突然退出。加 `OutsideWindow`，里面订退出、直接 `shell.quit()`（4.1、4.7、第 5 节、第 8 节第 6 条）。
- 这几页也没有 34px 标题栏，红黄绿按钮压在内容上、窗口拖不动。`OutsideWindow` 带 `.desktop-titlebar`，`devices.css` 给它留一行（4.1）。
- `conversationTime` 出的是时刻和日期，不是"N 分钟前"，测试过不了，改它还会动会话列表。改成本片自己的 `relativeTime`（第 3 节、4.9、第 5 节）。
- 界面测试按原计划跑不起来：根目录 vitest 不收 `.tsx`；`DesktopRoot`、`DeviceGate` 放在模块顶层就 render 的 `main.tsx` 里，`DeviceGate` 没导出；状态和平台标记靠 effect，静态渲染不跑。挪到 `U/devices/DesktopRoot.tsx` 并导出，加 `DesktopRootView` 和两个纯函数，`connection.test.ts` 加 mock，命令改成在 ui 包里跑（4.1、第 5 节、6.1）。
- 切换标签原来是表头的第四个子元素，会把右侧操作挤到第二行。改放进 `.today-header-actions` 第一个（4.3、第 8 节第 5 条）。
- `platform` 可能是 `unsupported`，v1 的对面也没有它。`platformLabel` 对这两种回空，行上不显示（4.9、第 5 节）。
- 维护视图没管"有 `capabilities` 但没有 `update.*`"。U2 之前的 v2 daemon 只报 `['device']`，正是这种。只写文字，加"不能远程升级"那句（4.7、4.9）。
- 4006 之后的重连会把 `failure.code` 换成 `refused`，提示条留不住。改看 U1a 的 `active.disabledAt`（4.8、第 5 节、6.2 第 6 步）。
- `invalid_link` 只提 `vonvon pair`，可 Windows 不注册 `vonvon` 命令（owner 2026-11-01）。加上桌面端里生成链接的路径（4.9）。
- 单条地址上的 4005 不再整台终止（U1a 改），`routeHint` 加这一行的说法（4.9）。
- 验收第 5、9 步粘第 2 步的旧链接，中间隔了重启和等待，链接多半已过 10 分钟，得到的是 `link_expired`。改成拿到链接马上再粘（第 2 步），用过的链接单独拿一条新的、10 分钟内做完（第 9 步）（6.2）。
- 撤销计时 t1 − t0 < 1000 包含 Computer Use 的延迟和跨机的钟差，量不准。Mac 上只截图核"很快"，跨机差值只作参考，1 秒的判据交给 U1a 的同机探针；顺便在这一页核标题栏、拖动和 Cmd+Q（6.2 第 7 步、第 9 节）。
- "30 秒内自动连上"等于退避上限，加一次连接超时可能偶发失败。改成 45 秒（6.2 第 5、6 步）。
- 维护视图里"本片先合入或 U2 先合入"两种写法，后一种不会发生。改成定序（4.7）。
- I3 拆成 I3a、I3b 后，开头钉的 `server-3-update-engine` 过期。改成 I3a（#632）、I3b（#633），`UpdatePanel` 以 I3b 为准（第 1 节依赖）。

## 11. 实现时和计划不一样的地方

按本计划在 U1a 之上实现（同一分支 `claude/devices-ui-1`，基于 D2 的 318c1b1c）。和计划不一样的地方：

1. **文件分法**：`TailscaleAdvice`、`OutsideWindow`、`quitOutsideApp` 和三个小件（`StatusDot`、把文案里反引号包的命令显示成 `<code>` 的 `CopyText`、每隔一段时间刷新的 `useNow`）放在 `U/devices/device-bits.tsx`；`DeviceVersionNotice` 和 `DeviceStatusBanner` 同在 `DeviceStatusBanner.tsx`；`desktopPlatformMark`、`shouldMarkPlatform` 写在 `devices-presentation.ts`。`DesktopRoot.tsx` 照计划把它们都再导出。原因：`DesktopRoot` 要 import `App` 和两个外部视图，它们又要用这些，放在 `DesktopRoot.tsx` 里会循环引用。
2. **整体失败码是 `forbidden` 时**，`failureCopy` 写"连不上「X」。"再接每条地址的提示，和 `refused` 那一组一样，不走"其他"的"没能连上「X」（forbidden）。"。
3. **提示条的重连倒数**：`retryAt` 没有或已过（正在连）时写"和「X」的连接断了，正在重连。"，不写"（0 秒后再试）"。
4. **同一台设备、换了地址的链接**：预览回 `already_added` 且 `routesChanged` 时，对话框直接调 `add`（U1a 只更新地址、不用掉邀请），显示"「X」已经在列表里了，已按新链接更新了它的地址。"。这样 4.9 `forbidden` 那句"粘到"添加设备"里，会自动更新地址"才成立。地址没变时照计划写"已经在设备列表里了"并给"切换到「X」"。
5. **重新配对的默认名字**：链接正是要修的那台时，名字框默认是列表里现在的名字，不是链接里的名字，免得重新配对顺手把用户起的名字改回去。
6. **"配对中途断开、补连也没成功"** 的失败码是 U1a 的 `pairing_interrupted`。
7. **维护视图的服务端升级**：I3（#632、#633）已合入集成分支，但本分支基于 D2 318c1b1c，没有 I3，`UpdatePanel` 还是旧的。所以服务端旧时照 4.7"I3 没合入时也只写文字"；`maintenanceRequest` 已写好并有测试，等 U2 的 `ServerUpdateCard` 接上。客户端旧时除了 `DesktopUpdateButton`，再给一个"检查更新"：`DesktopUpdateButton` 在没查到新版本前什么都不显示，只放它会没有按钮可按。
8. **`failed` 的标题**也写"连不上「X」"，具体原因在正文；页顶那一行是设备名、状态点和状态字（"已撤销""需要重新配对"）。
9. **"这台电脑"一行的副文字**：本机的名字只在正看这台电脑时有（设备状态里只有当前设备的 `serverInfo`），看远程时只写系统和版本。
10. **连接页、维护视图能滚动**：标题栏下面单独一层 `.device-outside-scroll`，连不上页文字多时，底部的"回到这台电脑"等按钮能滚到。
11. **验收助手 `packages/desktop/test/manual/devices-accept-helper.ts`（6.2 第 4 步）没写**：它要 D3 的 `vonvon remote enable`、`pair --json`，D3 还没合入；和 U1a 的探针一样，D3 合入后和 Mac 验收一起写。
12. **测试**：几个界面测试共用 `test/devices-fixture.ts`（假名字、文档地址段）；设置首页的测试加在 `test/application-ui.test.tsx`。截图脚本 `test/manual/devices-fake-shell.ts` 用 Node 直接跑（`node packages/ui/test/manual/devices-fake-shell.ts <目录>`），只听 127.0.0.1。
13. **行数**：U1b 约 1,400 行（界面 ~780、测试 ~490、截图脚本 ~90、文档 ~40），和估的 1,500 差不多；和 U1a 合起来整个 PR 不含 lockfile 约 5,200 行。

已知限制（按真实用法不另做处理）：
- 在设备页删掉正在看的那台：删完立刻回到这台电脑，页面整个重建，"删了但对面还记着"那条提示随旧页面一起没了。只在自撤销没成功时才会有这条提示。
- 页面上"已撤销"多快出现完全取决于 U1a 推来的状态，界面这边不另计时。

## Codex 审查后改了什么（任务 235–237）

2026-11-02，Codex 在 JP-VPS 上审了 head 3ed5f8b6（任务 235 通读、237 看 ui）。和本片有关的下面三条都接受了：

- **235-4 "应用与启动"页的固定标题盖住设备菜单，远程设备那一项点不到。** 表头（`today.css` 的 `.today-app-header`，`z-index: 5`）自成一层，菜单的 `z-index: 20` 出不了这一层；页面里 sticky 的"应用与启动"标题也是 5、排在后面，就盖在菜单上。改成菜单打开时把表头抬到 30（`devices.css`，`.today-app-header:has(.device-switcher__menu)`），菜单关着时什么都不变。无头浏览器在"应用与启动"页打开菜单，每一项中心点到的都是它自己（`test/manual/devices-fake-shell.ts` 加 `switcher-over-application`）。
- **237-1 改名表单没登记草稿，切换设备时没保存的名字静默丢掉。** `RenameRow` 用 `useDraft` 登记：名字改了还没保存时，用标签或"切换到"切换、离开设置页，都先弹"有未保存的修改"；"保存并离开"先改名再切，"放弃并离开"关掉表单。草稿标题"设备名字"只在保存失败时出现在确认框里（`test/device-rename-draft.test.tsx` 新增；`devices-fake-shell.ts` 加 `rename-then-switch`）。
- **跟着 U1a 的 235-2**：连接页停在"身份和配对时不一样了"时，除了"重新配对"再给"再试一次"，和 `key_unreadable` 一样；文案没改（`test/device-gate.test.tsx`）。
