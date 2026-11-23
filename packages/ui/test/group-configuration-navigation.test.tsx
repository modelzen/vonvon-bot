// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {desktopSnapshotSchema, groupConfigurationNavigationSchema, type DesktopSnapshot, type GroupConfigurationNavigation, type GroupNavigationShell} from '@vonvon/protocol';
import {groupConfigurationDestination, useGroupConfigurationNavigation} from '../src/group-configuration-navigation';
import {DraftGuardProvider, useDraft} from '../src/settings/DraftGuard';

const snapshot = desktopSnapshotSchema.parse({
  revision: 1, observedAt: Date.now(), stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.10.1'},
  agents: ['cli_testA', 'cli_testB'].map(id => ({id, name: id, enabled: true, running: true, connection: 'connected', activation: 'active'})),
  groups: [{id: 'oc_test', name: 'Test'}],
  memberships: ['cli_testA', 'cli_testB'].map((agentId, i) => ({id: `member${i}`, agentId, groupId: 'oc_test', name: 'Test', directory: '/tmp/test', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false})),
  tools: [], jobs: [], application: {platform: 'macos', version: '0.10.1', loginItem: false, dataPath: '/tmp/test'},
});
const navigation = groupConfigurationNavigationSchema.parse({navigationId: '11111111-1111-4111-8111-111111111111', botAppId: 'cli_testB', groupId: 'oc_test'});

describe('group configuration destination', () => {
  it('selects the exact Bot membership when multiple Bots share a group', () => {
    expect(groupConfigurationDestination(snapshot, navigation)).toEqual({kind: 'available', route: {kind: 'membership', id: 'member1', pane: {kind: 'settings'}, parent: {kind: 'agent', id: 'cli_testB', pane: {kind: 'groups'}}}});
  });
  it('offers actions for unavailable Bot/group, stale snapshots, and inconsistent memberships', () => {
    for (const value of [{...snapshot, host: {kind: 'disconnected', message: 'offline'}} satisfies DesktopSnapshot, {...snapshot, agents: []}, {...snapshot, groups: []}, {...snapshot, memberships: []}, {...snapshot, stale: true}, {...snapshot, memberships: [...snapshot.memberships, snapshot.memberships[1]]}]) {
      const result = groupConfigurationDestination(value, navigation);
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') expect(result.message).toMatch(/请/);
    }
  });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const dispose of cleanup.splice(0)) await dispose();});

it('retains cold-launch navigation through initial starting snapshot until connected, then accepts live opens', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  let listener: (value: GroupConfigurationNavigation) => void = () => {};
  const acknowledge = vi.fn(async () => {}), open = vi.fn();
  const shell: GroupNavigationShell = {pending: async () => [navigation], acknowledge, onOpen(callback) {listener = callback; return () => {};}};
  function Harness({value}: {value?: DesktopSnapshot}) {useGroupConfigurationNavigation({shell, snapshot: value, open}); return null;}
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  cleanup.push(async () => {await act(async () => root.unmount()); element.remove();});
  await act(async () => root.render(<DraftGuardProvider><Harness/></DraftGuardProvider>));
  expect(open).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  await act(async () => root.render(<DraftGuardProvider><Harness value={{...snapshot, host: {kind: 'starting'}, agents: [], groups: [], memberships: []}}/></DraftGuardProvider>));
  expect(open).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  await act(async () => root.render(<DraftGuardProvider><Harness value={snapshot}/></DraftGuardProvider>));
  expect(open).toHaveBeenCalledOnce(); expect(acknowledge).toHaveBeenCalledWith(navigation.navigationId);
  await act(async () => listener({...navigation, navigationId: '22222222-2222-4222-8222-222222222222'}));
  expect(open).toHaveBeenCalledTimes(2);
  expect(snapshot.memberships[1].response).toBe('mention');
});

it('keeps edits intact when group navigation is cancelled, and does not replay the cancelled link', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const acknowledge = vi.fn(async () => {}), open = vi.fn(), discard = vi.fn();
  const shell: GroupNavigationShell = {pending: async () => [navigation], acknowledge, onOpen() {return () => {};}};
  function Harness() {
    useDraft(true, {title: 'Group edits', discard});
    useGroupConfigurationNavigation({shell, snapshot, open});
    return null;
  }
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  cleanup.push(async () => {await act(async () => root.unmount()); element.remove();});
  await act(async () => root.render(<DraftGuardProvider><Harness/></DraftGuardProvider>));
  expect(open).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  const stay = [...document.querySelectorAll('button')].find(button => button.textContent === '继续编辑');
  expect(stay).toBeDefined();
  await act(async () => stay?.click());
  expect(discard).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(navigation.navigationId);
});
