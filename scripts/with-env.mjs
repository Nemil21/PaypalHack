// Usage: node scripts/with-env.mjs <command> [args...]
// Loads the repo-root .env if present (variables already in the environment win), then runs the
// command. Works on Node 20 (no --env-file-if-exists). Never prints values.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from 'dotenv';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) config({ path: envFile, override: false, quiet: true });

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}
const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
