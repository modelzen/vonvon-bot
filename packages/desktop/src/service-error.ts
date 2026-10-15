import { SERVICE_BUSY_MESSAGE } from '@vonvon/protocol';

const messages = {
  unsupported: '这台电脑上不能设置登录时启动。',
  unpackaged: '要用打包的 Vonvon Bot 才能设置登录时启动。',
  distribution: 'app 里的 daemon 不完整，请重新安装 Vonvon Bot。',
  busy: SERVICE_BUSY_MESSAGE,
  timeout: '后台服务操作 3 分钟还没结束。稍后到「应用与启动」看状态，详情在 daemon.log。',
  exit: '后台服务操作没做完就退出了，详情在 daemon.log。',
  reattach: '后台服务已经改好，但窗口没能重新连上 daemon。重新打开 Vonvon Bot。',
};

export type ServiceActionReason = keyof typeof messages | 'report';

/** A login-item failure the window may show as is; `report` carries the helper's own report text (serviceActionMessage). */
export class ServiceActionError extends Error {
  readonly reason: ServiceActionReason;
  readonly #message: string;

  constructor(reason: keyof typeof messages);
  constructor(reason: 'report', message: string);
  constructor(reason: ServiceActionReason, message?: string) {
    const text = reason === 'report' ? message ?? '' : messages[reason];
    super(text);
    this.reason = reason;
    this.#message = text;
  }

  get safeMessage(): string { return this.#message; }
}
