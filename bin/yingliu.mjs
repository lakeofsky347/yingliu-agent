#!/usr/bin/env node
// yingliu CLI entry (npx yingliu / node bin/yingliu.mjs). Requires `npm run build` (dist/cli.mjs).
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const built = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.mjs');
if (!existsSync(built)) { process.stderr.write('yingliu: 未找到 dist/cli.mjs，请先在仓库根目录运行 npm run build（或 scripts/setup-cli.sh）\n'); process.exit(6); }
await import(pathToFileURL(built).href);
