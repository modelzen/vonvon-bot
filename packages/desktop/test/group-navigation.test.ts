import {describe, expect, it, vi} from 'vitest';
import {GroupNavigation, captureGroupLaunches, parseGroupConfiguration} from '../src/group-navigation.js';
import {createDesktopFacades} from '../src/facade.js';
import {desktopChannels} from '../src/ipc-contract.js';
const link = 'vonvon-preview://groups/cli_testA/oc_groupA';

describe('group configuration links', () => {
  it('requires exact build scheme, route and identifiers without URL normalization', () => {
    expect(parseGroupConfiguration(link, 'vonvon-preview')).toEqual({botAppId: 'cli_testA', groupId: 'oc_groupA'});
    expect(parseGroupConfiguration(link.replace('vonvon-preview:', 'vonvon:'), 'vonvon')).toBeDefined();
    for (const raw of [link.replace('vonvon-preview:', 'vonvon:'), link + '?apply=true', link + '#x', link + '/', link + '\n',
      ' ' + link, link.replace('groups/', 'user@groups/'), link.replace('groups/', 'groups:123/'),
      link.replace('/cli_', '/%63li_'),
      link.replace('cli_testA', 'invalid'), link.replace('oc_groupA', 'invalid'), undefined]) {
      expect(parseGroupConfiguration(raw, 'vonvon-preview'), String(raw)).toBeUndefined();
    }
  });
  it('retains cold launches and warm opens until exact acknowledgement, with deduplication and copy isolation', () => {
    const navigation = new GroupNavigation('vonvon-preview');
    let open: (event: {preventDefault(): void}, url: string) => void = () => {};
    let second: (argv: string[]) => void = () => {};
    const reveal = vi.fn();
    captureGroupLaunches(navigation, {argv: ['app.exe', link], reveal, onOpenUrl(listener) {open = listener;}, onSecondInstance(listener) {second = listener;}});
    const first = navigation.pending()[0];
    const listener = vi.fn(), off = navigation.onOpen(listener);
    const event = {preventDefault: vi.fn()};
    open(event, link);
    second(['app.exe', link.replace('oc_groupA', 'oc_groupB')]);
    expect(navigation.pending()).toHaveLength(2);
    expect(listener).toHaveBeenCalledWith(first);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledTimes(3);
    const copy = navigation.pending(); copy[0].navigationId = 'changed';
    expect(navigation.pending()[0]).toEqual(first);
    navigation.acknowledge(first.navigationId);
    expect(navigation.pending()).toHaveLength(1);
    open(event, 'vonvon://groups/cli_testA/oc_groupA');
    expect(navigation.pending()).toHaveLength(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    off();
    expect(() => navigation.acknowledge('bad')).toThrow();
  });
  it('validates the retained IPC queue and delivers validated live navigation events', async () => {
    const navigation = new GroupNavigation('vonvon-preview'); navigation.open(link);
    const value = navigation.pending()[0];
    let receive: (value: unknown) => void = () => {};
    const invoke = vi.fn(async (channel: string) => ({ok: true, value: channel === desktopChannels.groupNavigationPending ? [value] : undefined}));
    const {shell} = createDesktopFacades({invoke, receive(listener) {receive = listener; return () => {};}});
    expect(await shell.groupNavigation.pending()).toEqual([value]);
    const listener = vi.fn(); shell.groupNavigation.onOpen(listener);
    receive({type: 'groupNavigation', value});
    expect(listener).toHaveBeenCalledWith(value);
    await shell.groupNavigation.acknowledge(value.navigationId);
    expect(invoke).toHaveBeenLastCalledWith(desktopChannels.groupNavigationAcknowledge, value.navigationId);
  });
});
