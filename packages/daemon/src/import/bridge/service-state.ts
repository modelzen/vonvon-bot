export interface BridgeServiceState {
  loaded: boolean;
  running: boolean;
  stopping: boolean;
  starting: boolean;
}

/** launchctl bootout returns before the job has finished exiting. SIGTERMed still owns its processes. */
export function parseBridgeServiceState(result: {status: number; stdout: string; stderr: string}): BridgeServiceState | undefined {
  if (result.status === 113 || (result.status !== 0 && /Could not find service/i.test(result.stderr))) {
    return {loaded: false, running: false, stopping: false, starting: false};
  }
  if (result.status !== 0) return;
  // Job fields have one indentation level; resource coalition fields are nested deeper.
  const state = /^(?:\t| {4})?state = ([^\r\n]+?)[ \t]*\r?$/m.exec(result.stdout)?.[1];
  if (!state || !['running', 'not running', 'waiting', 'exited', 'SIGTERMed', 'xpcproxy'].includes(state)) return;
  return {loaded: true, running: state === 'running', stopping: state === 'SIGTERMed', starting: state === 'xpcproxy'};
}
