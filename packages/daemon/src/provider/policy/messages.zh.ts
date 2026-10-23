import type { Refusal } from './enforcement';

/** The process host's admission refusal; it reads no provider, OS, or tier. */
export function ownedWorkUnverified(): Refusal {
  return { reason: 'owned-work-unverified', message: '上次运行留下的 agent 进程尚未确认退出，暂不能启动新的 agent。请运行 doctor 查看。', hint: '运行 doctor 查看未确认退出的进程记录，确认这些进程已结束后重试。' };
}
