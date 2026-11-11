// loadRootDotenv: loads a .env without overriding the environment, and is a no-op when absent.
// Uses temp files only; never touches the real repo-root .env.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadRootDotenv } from '../migrate.mjs';

test('missing .env is a no-op', () => {
  assert.equal(loadRootDotenv(path.join(tmpdir(), 'holdfast-no-such-dir', '.env')), null);
});

test('.env fills unset vars and never overrides set ones', { skip: typeof process.loadEnvFile !== 'function' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'holdfast-env-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'HF002_TEST_PRESET=fromfile\nHF002_TEST_UNSET=fromfile\n');
  process.env.HF002_TEST_PRESET = 'preset';
  delete process.env.HF002_TEST_UNSET;
  try {
    assert.equal(loadRootDotenv(file), file);
    assert.equal(process.env.HF002_TEST_PRESET, 'preset');
    assert.equal(process.env.HF002_TEST_UNSET, 'fromfile');
  } finally {
    delete process.env.HF002_TEST_PRESET;
    delete process.env.HF002_TEST_UNSET;
    rmSync(dir, { recursive: true, force: true });
  }
});
