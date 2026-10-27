export interface BridgeServiceState {
  loaded: boolean;
  running: boolean;
  stopping: boolean;
}

/** launchctl bootout returns before the job has finished exiting. SIGTERMed still owns its processes. */
export function parseBridgeServiceState(result: {status: number; stdout: string; stderr: string}): BridgeServiceState | undefined {
  if (result.status === 113 || (result.status !== 0 && /Could not find service/i.test(result.stderr))) {
    return {loaded: false, running: false, stopping: false};
  }
  if (result.status !== 0) return;
  // Read the job's first state, not a later nested resource coalition's state.
  const state = /^\s*state = ([^\r\n]+?)\s*$/m.exec(result.stdout)?.[1];
  if (!state || !['running', 'not running', 'waiting', 'exited', 'SIGTERMed'].includes(state)) return;
  return {loaded: true, running: state === 'running', stopping: state === 'SIGTERMed'};
}
