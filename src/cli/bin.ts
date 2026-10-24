import { runCli } from './main.ts';
// C07: even an unexpected failure outside runCli produces a single JSON error line (with --json) and a stable code.
try { process.exitCode = await runCli(process.argv.slice(2)); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error: { code: 'STARTUP', message: '启动失败：' + message } }) + '\n');
  else process.stderr.write('错误：启动失败：' + message + '\n');
  process.exitCode = 11;
}
