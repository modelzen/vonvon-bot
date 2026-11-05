/**
 * 写操作被校验拒绝（中文原因可直接上卡/上 HTTP body）。HTTP 层映射 409；
 * IPC 层凭 code 还原类型。单独成文件：Agent 的工具也认它，而 `./ops` 会把整个 Provider 层带进来。
 */
export class AdminWriteError extends Error {
  readonly code = 'ADMIN_WRITE_REJECTED';
  constructor(reason: string) {
    super(reason);
    this.name = 'AdminWriteError';
  }
}
