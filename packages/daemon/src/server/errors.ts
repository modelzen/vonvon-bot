import { AdminWriteError } from '../admin/ops';
import { NotWiredYetError } from '../admin/service';
import { GroupUpstreamError, InvalidGroupInput } from '../admin/groups';
import { SettingsInputError } from '../admin/settings-parse';
import { CodexSetupConflict } from '../provider/engines/codex/setup';

export class RpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function unsupported(): never {
  throw new RpcError('unsupported', '当前 daemon 不支持此操作。');
}

export function getRpcErrorCode(error: unknown): string {
  if (error instanceof RpcError) return error.code;
  if (error instanceof AdminWriteError || error instanceof CodexSetupConflict) return 'conflict';
  if (error instanceof GroupUpstreamError) return 'upstream';
  if (error instanceof InvalidGroupInput || error instanceof SettingsInputError || error instanceof URIError) return 'invalid_request';
  if (error instanceof NotWiredYetError) return 'unsupported';
  return 'operation_failed';
}
