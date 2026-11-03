import {beforeEach, expect, it, vi} from 'vitest';
import {createDesktopTray} from '../src/tray.js';
import {join} from 'node:path';

const fake = vi.hoisted(() => {
  const base = {addRepresentation: vi.fn(), setTemplateImage: vi.fn()};
  const retina = {toDataURL: vi.fn(() => 'data:image/png;base64,retina')};
  const source = {isEmpty: vi.fn(() => false), resize: vi.fn(({width}: {width: number}) => width === 18 ? base : retina)};
  const tray = {setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn()};
  return {base, retina, source, tray, image: undefined as unknown};
});
vi.mock('electron', () => ({
  nativeImage: {createFromPath: vi.fn(() => fake.source)},
  Menu: {buildFromTemplate: vi.fn((items: unknown) => items)},
  Tray: class {constructor(image: unknown) {fake.image = image; return fake.tray;}},
}));

beforeEach(() => {vi.clearAllMocks(); fake.image = undefined;});

it('uses an 18-point template tray icon with a 2x Retina representation on macOS', () => {
  createDesktopTray('/app/assets/tray.png', vi.fn(), vi.fn(), 'darwin');
  expect(fake.source.resize).toHaveBeenCalledWith({width: 18, height: 18, quality: 'best'});
  expect(fake.source.resize).toHaveBeenCalledWith({width: 36, height: 36, quality: 'best'});
  expect(fake.base.addRepresentation).toHaveBeenCalledWith({scaleFactor: 2, dataURL: 'data:image/png;base64,retina'});
  expect(fake.base.setTemplateImage).toHaveBeenCalledWith(true);
  expect(fake.image).toBe(fake.base);
});

it('uses the full-color multi-resolution logo ICO on Windows', () => {
  const pngPath = join('app', 'assets', 'tray.png');
  createDesktopTray(pngPath, vi.fn(), vi.fn(), 'win32');
  expect(fake.source.resize).not.toHaveBeenCalled();
  expect(fake.base.setTemplateImage).not.toHaveBeenCalled();
  expect(fake.image).toBe(join('app', 'assets', 'windows-icon.ico'));
});

it('keeps the source icon on Linux', () => {
  createDesktopTray('/app/assets/tray.png', vi.fn(), vi.fn(), 'linux');
  expect(fake.source.resize).not.toHaveBeenCalled();
  expect(fake.image).toBe(fake.source);
});

it('offers Chinese open and quit actions without revealing the window just to open the macOS menu', () => {
  const show = vi.fn();
  const quit = vi.fn();
  createDesktopTray('/app/assets/tray.png', show, quit, 'darwin');
  const menu = fake.tray.setContextMenu.mock.lastCall?.[0] as Array<{label?: string; type?: string; click?: () => void}>;
  expect(menu.map(item => item.label ?? item.type)).toEqual(['打开 Vonvon Bot', 'separator', '退出 Vonvon Bot']);
  menu[0]?.click?.();
  expect(show).toHaveBeenCalledOnce();
  expect(quit).not.toHaveBeenCalled();
  menu[2]?.click?.();
  expect(quit).toHaveBeenCalledOnce();
  expect(fake.tray.on).not.toHaveBeenCalledWith('click', expect.anything());
});

it('still opens the window from a tray click on Linux', () => {
  const show = vi.fn();
  createDesktopTray('/app/assets/tray.png', show, vi.fn(), 'linux');
  expect(fake.tray.on).toHaveBeenCalledWith('click', show);
});

it('adds an update item at the top of the menu and takes it away again', () => {
  const show = vi.fn();
  const tray = createDesktopTray('/app/assets/tray.png', show, vi.fn(), 'darwin');
  const labels = () => (fake.tray.setContextMenu.mock.lastCall?.[0] as Array<{label?: string; type?: string}>).map(item => item.label ?? item.type);
  tray.setUpdate('有新版本 0.7.1');
  expect(labels()).toEqual(['有新版本 0.7.1', 'separator', '打开 Vonvon Bot', 'separator', '退出 Vonvon Bot']);
  expect(fake.tray.setToolTip).toHaveBeenLastCalledWith('Vonvon Bot · 有新版本 0.7.1');
  const menu = fake.tray.setContextMenu.mock.lastCall?.[0] as Array<{click?: () => void}>;
  menu[0]?.click?.();
  expect(show).toHaveBeenCalledOnce();
  const rebuilt = fake.tray.setContextMenu.mock.calls.length;
  tray.setUpdate('有新版本 0.7.1');
  expect(fake.tray.setContextMenu.mock.calls.length).toBe(rebuilt);
  tray.setUpdate(undefined);
  expect(labels()).toEqual(['打开 Vonvon Bot', 'separator', '退出 Vonvon Bot']);
  expect(fake.tray.setToolTip).toHaveBeenLastCalledWith('Vonvon Bot');
});

// devices-ui-4: another device updating this computer says so at the top of the menu, as a line that is not a button.
it('shows a remote update notice above the update item and takes it away again', () => {
  const tray = createDesktopTray('/app/assets/tray.png', vi.fn(), vi.fn(), 'darwin');
  const menu = () => fake.tray.setContextMenu.mock.lastCall?.[0] as Array<{label?: string; type?: string; enabled?: boolean; click?: () => void}>;
  tray.setUpdate('有新版本 0.9.1');
  tray.setNotice('「笔记本」正在更新这台电脑上的 Vonvon Bot。');
  expect(menu().map(item => item.label ?? item.type)).toEqual(['「笔记本」正在更新这台电脑上的 Vonvon Bot。', 'separator', '有新版本 0.9.1', 'separator', '打开 Vonvon Bot', 'separator', '退出 Vonvon Bot']);
  expect(menu()[0]).toMatchObject({enabled: false});
  expect(menu()[0]?.click).toBeUndefined();
  const rebuilt = fake.tray.setContextMenu.mock.calls.length;
  tray.setNotice('「笔记本」正在更新这台电脑上的 Vonvon Bot。');
  expect(fake.tray.setContextMenu.mock.calls.length).toBe(rebuilt);
  tray.setNotice(undefined);
  expect(menu().map(item => item.label ?? item.type)).toEqual(['有新版本 0.9.1', 'separator', '打开 Vonvon Bot', 'separator', '退出 Vonvon Bot']);
  // the tooltip stays the update's
  expect(fake.tray.setToolTip).toHaveBeenLastCalledWith('Vonvon Bot · 有新版本 0.9.1');
});
