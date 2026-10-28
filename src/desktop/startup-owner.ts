import { BusyError, type OwnerLease } from '../cli/lock.ts';

export type BusyChoice = 'retry' | 'wait' | 'quit';
/** "Wait" blocks on the lock for this long, then asks again; quitting stays one click away. */
export const BUSY_WAIT_MS = 60_000;
const CHOICES: BusyChoice[] = ['retry', 'wait', 'quit'];

/** Native message-box options (Electron dialog.showMessageBox) for a profile owned by another yingliu process. */
export function busyDialogOptions(error: BusyError) {
  const holder = error.owner ? `占用者：pid ${error.owner.pid}（${error.owner.command}），开始于 ${error.owner.startedAt}` : '占用者未知（可能是旧版本进程或其他程序占用了锁端口）';
  return {
    type: 'warning' as const, title: '数据目录正在被使用', noLink: true, defaultId: 0, cancelId: 2,
    message: '另一个映流智能体进程（命令行、浏览器服务或另一个桌面窗口）正在使用这个数据目录。',
    detail: `${holder}\n数据目录：${error.path}\n\n为保护工程，不会接管正在使用的数据。可以等对方结束后重试，或等待其释放（最多 ${BUSY_WAIT_MS / 1000} 秒）。`,
    buttons: ['重试', `等待释放（最多 ${BUSY_WAIT_MS / 1000} 秒）`, '退出'],
  };
}
export const choiceFor = (response: number): BusyChoice => CHOICES[response] ?? 'quit';

/** Desktop startup: never exit silently on BUSY. Non-BUSY errors (CONFIG, I/O, abort) propagate unchanged. */
export async function acquireDesktopOwner(acquire: (timeoutMs: number) => Promise<OwnerLease>, ask: (error: BusyError) => Promise<BusyChoice>): Promise<OwnerLease | undefined> {
  let timeoutMs = 0;
  for (;;) {
    try { return await acquire(timeoutMs); }
    catch (error) {
      if (!(error instanceof BusyError)) throw error;
      const choice = await ask(error);
      if (choice === 'quit') return undefined;
      timeoutMs = choice === 'wait' ? BUSY_WAIT_MS : 0;
    }
  }
}
