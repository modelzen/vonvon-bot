import {useEffect, useMemo, useState} from 'react';
import {flushSync} from 'react-dom';
import type {DesktopSnapshot, ScheduledTaskView} from '@vonvon/protocol';
import {AppShell} from '../LocalShell';
import {useActiveDevice, useClient, useShellCapabilities} from '../client-context';
import {DeviceSwitcher} from '../devices/DeviceSwitcher';
import {DesktopUpdateProvider} from '../desktop-update';
import {InlineNotice} from '../reference/components/ui';
import {coreUpdatable} from '../management/UpdatePanel';
import {DesktopUpdateButton} from '../DesktopUpdateButton';
import {DraftGuardProvider, useDraftGuard} from '../settings/DraftGuard';
import {SearchDialog} from '../SearchDialog';
import {OPEN_SETTING_EVENT, searchEntries, type Destination} from '../search';
import {useAccountPage} from '../accounts/account-page';
import {CommunityPage} from './CommunityPage';
import {useCommunity} from './community-context';

export function CommunityWindow() {
  return <DraftGuardProvider><DesktopUpdateProvider><CommunityWindowContent/></DesktopUpdateProvider></DraftGuardProvider>;
}

function CommunityWindowContent() {
  const client = useClient();
  const device = useActiveDevice();
  const shell = useShellCapabilities();
  const accountPage = useAccountPage();
  const community = useCommunity()!;
  const {navigate} = useDraftGuard();
  const [searchOpen, setSearchOpen] = useState(false);
  const [quitError, setQuitError] = useState<string>();
  const deviceReadLease = useMemo(() => ({client, deviceId: device.id}), [client, device.id]);
  const [read, setRead] = useState<{deviceReadLease: typeof deviceReadLease; snapshot: DesktopSnapshot}>();
  const [coreRead, setCoreRead] = useState<{deviceReadLease: typeof deviceReadLease; available: boolean}>();
  const [scheduleRead, setScheduleRead] = useState<{deviceReadLease: typeof deviceReadLease; tasks: ScheduledTaskView[]}>();
  const snapshot = read?.deviceReadLease === deviceReadLease ? read.snapshot : undefined;
  const schedules = scheduleRead?.deviceReadLease === deviceReadLease ? scheduleRead.tasks : [];
  const running = snapshot?.agents.filter(agent => agent.running).map(agent => agent.id) ?? [];
  const runningKey = JSON.stringify(running);
  const externalCoreAvailable = coreRead?.deviceReadLease === deviceReadLease && coreRead.available;
  const connectedVersion = snapshot?.host.kind === 'connected' ? snapshot.host.version : undefined;
  useEffect(() => {
    let active = true;
    const unsubscribe = deviceReadLease.client.watchSnapshots(next => {if (active) setRead({deviceReadLease, snapshot: next});});
    return () => {active = false; unsubscribe();};
  }, [deviceReadLease]);
  useEffect(() => {
    if (!searchOpen) return;
    let active = true;
    setScheduleRead({deviceReadLease, tasks: []});
    void Promise.all(running.map(botId => deviceReadLease.client.schedule(botId, {action: 'listBot'}).then(reply => reply.kind === 'tasks' ? reply.tasks : [], () => [])))
      .then(lists => {if (active) setScheduleRead({deviceReadLease, tasks: lists.flat()});});
    return () => {active = false;};
  }, [deviceReadLease, searchOpen, runningKey]);
  useEffect(() => {
    if (!searchOpen || snapshot?.host.kind !== 'connected') return;
    let active = true;
    setCoreRead({deviceReadLease, available: false});
    void deviceReadLease.client.admin({type: 'daemonStatus'}).then(reply => {if (active) setCoreRead({deviceReadLease, available: reply.kind === 'daemonStatus' && coreUpdatable(reply.status.distribution?.kind)});}, () => {});
    return () => {active = false;};
  }, [deviceReadLease, searchOpen, snapshot?.host.kind, connectedVersion]);
  function leave(destination: Destination) {
    flushSync(() => setSearchOpen(false));
    navigate(() => {
      if (destination.page === 'account') {accountPage?.open(); community.close();}
      else {accountPage?.close(); community.leave({deviceId: device.id, destination});}
    });
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); setSearchOpen(true);}
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    const open = (event: Event) => {const destination = (event as CustomEvent<Destination | undefined>).detail; if (destination?.page) leave(destination);};
    window.addEventListener(OPEN_SETTING_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTING_EVENT, open);
  }, [device.id, navigate, community.leave, accountPage]);
  useEffect(() => shell?.onQuitRequested?.(() => navigate(() => {setQuitError(undefined); void shell.quit?.().catch(error => setQuitError(error instanceof Error ? error.message : '后台服务尚未确认停止，请稍后再试。')); })), [shell, navigate]);
  return <>
    <AppShell page="community" view="agents" title="社区"
      onNavigate={page => {if (page !== 'community') leave({page});}}
      onOpenList={view => leave({page: 'collaboration', view, selection: {kind: 'overview'}})}
      onSearch={() => setSearchOpen(true)} updateAction={<DesktopUpdateButton/>}
      deviceSwitcher={shell?.devices ? <DeviceSwitcher switchKeepsPage onManage={() => leave({page: 'devices'})} onAccount={() => leave({page: 'account'})}/> : undefined}>
      <div className="page-stack">{quitError && <InlineNotice title="退出未完成" tone="warning">{quitError}</InlineNotice>}<CommunityPage/></div>
    </AppShell>
    {searchOpen && <SearchDialog open entries={searchEntries(snapshot, {schedules, externalCoreAvailable, devices: Boolean(shell?.devices)})} onClose={() => setSearchOpen(false)} onSelect={entry => leave(entry.destination)}/>}
  </>;
}
