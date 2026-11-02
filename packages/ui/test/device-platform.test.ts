import {expect, it, vi} from 'vitest';
import {activeDeviceFrom, LOCAL_ACTIVE_DEVICE} from '../src/client-context';
import {desktopPlatformMark, quitOutsideApp, shouldMarkPlatform} from '../src/devices/DesktopRoot';
import {A, devicesState, info} from './devices-fixture';

// devices-ui-1b 第 5 节 device-platform. main 必败: the chrome followed whichever snapshot came last.
it('marks the window chrome by this computer only', () => {
  const state = devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()});
  expect(desktopPlatformMark(state)).toBe('macos');
  expect(desktopPlatformMark(undefined)).toBeUndefined();
  expect(shouldMarkPlatform(activeDeviceFrom(state))).toBe(false);
  expect(shouldMarkPlatform(LOCAL_ACTIVE_DEVICE)).toBe(true);
});

it('quits from the pages outside App, saying why it could not', async () => {
  const quit = vi.fn(async () => {});
  const onError = vi.fn();
  quitOutsideApp({quit}, onError)();
  expect(quit).toHaveBeenCalledOnce();
  quitOutsideApp({quit: async () => { throw new Error('后台还在停'); }}, onError)();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('后台还在停'));
  expect(() => quitOutsideApp({}, onError)()).not.toThrow();
  expect(() => quitOutsideApp(undefined, onError)()).not.toThrow();
});
