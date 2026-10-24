/** The entry point owns signal handling. Locks never exit the process or release before application teardown. */
export class CliInterruptedError extends Error {
  readonly exitCode: number;
  constructor(readonly signalName: 'SIGINT' | 'SIGTERM') {
    super(signalName === 'SIGINT' ? '命令已中断，正在停止本应用任务' : '命令已终止，正在停止本应用任务');
    this.exitCode = signalName === 'SIGINT' ? 130 : 143;
  }
}

export interface CliLifecycle {
  readonly signal: AbortSignal;
  readonly exitCode: number | undefined;
  throwIfInterrupted(): void;
  /** Call in the command's finally, including failed startup. No release occurs until dispose has settled. */
  shutdown(dispose: () => Promise<void>, release?: () => Promise<void>): Promise<void>;
}

/**
 * Handlers only request cancellation. The entry point checks signal in its wait/call loops and enters finally to drain.
 * In particular, a signal arriving during application startup must not release the owner while startup is still running.
 * Repeated signals do not bypass cleanup. No process.exit or unrelated process management occurs here.
 */
export function installCliLifecycle(): CliLifecycle {
  const controller = new AbortController();
  const interrupt = (name: 'SIGINT' | 'SIGTERM') => { if (!controller.signal.aborted) controller.abort(new CliInterruptedError(name)); };
  const int = () => interrupt('SIGINT'), term = () => interrupt('SIGTERM');
  process.on('SIGINT', int); process.on('SIGTERM', term);
  let shutdown: Promise<void> | undefined;
  return {
    signal: controller.signal,
    get exitCode() { return controller.signal.aborted ? (controller.signal.reason as CliInterruptedError).exitCode : undefined; },
    throwIfInterrupted() { controller.signal.throwIfAborted(); },
    shutdown(dispose, release) {
      return shutdown ??= (async () => {
        try { try { await dispose(); } finally { await release?.(); } }
        finally { process.removeListener('SIGINT', int); process.removeListener('SIGTERM', term); }
      })();
    },
  };
}
