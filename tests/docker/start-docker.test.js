import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise the real shell entrypoint without a database or a generated Next build.
// Initialization fixtures record the order; the server records its inherited env
// and PID so losing `exec` or continuing after an initialization error is visible.
function start(env = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'umami-start-docker-'));
  try {
    mkdirSync(path.join(cwd, 'scripts'));
    mkdirSync(path.join(cwd, 'node_modules', '.bin'), { recursive: true });
    copyFileSync(
      new URL('../../scripts/start-docker.sh', import.meta.url),
      path.join(cwd, 'start.sh'),
    );
    for (const stage of ['check-db', 'update-tracker']) {
      writeFileSync(
        path.join(cwd, 'scripts', `${stage}.js`),
        `console.log(JSON.stringify({ stage: '${stage}', path: process.env.PATH }));
         if (process.env.FAIL_STAGE === '${stage}') process.exit(23);`,
      );
    }
    writeFileSync(
      path.join(cwd, 'server.js'),
      `console.log(JSON.stringify({ stage: 'server', hostname: process.env.HOSTNAME,
        port: process.env.PORT, pid: process.pid }));`,
    );
    const cleanEnv = { ...process.env };
    for (const name of ['HOST', 'HOSTNAME', 'PORT', 'FAIL_STAGE']) delete cleanEnv[name];
    const result = spawnSync('sh', ['start.sh'], {
      cwd,
      env: { ...cleanEnv, ...env },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    const stages = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    return { ...result, stages, bin: path.join(cwd, 'node_modules', '.bin') };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('normalizes an injected pod/container hostname and preserves PORT', () => {
  const result = start({ HOSTNAME: hostname(), PORT: '4321' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stages[2].hostname, '0.0.0.0');
  assert.equal(result.stages[2].port, '4321');
});

for (const value of ['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost', 'custom.example']) {
  test(`preserves an explicit HOSTNAME=${value}`, () => {
    const result = start({ HOSTNAME: value });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stages[2].hostname, value);
  });
}

for (const value of ['127.0.0.1', '::1', hostname()]) {
  test(`HOST=${value} takes precedence over an injected HOSTNAME`, () => {
    const result = start({ HOST: value, HOSTNAME: hostname() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stages[2].hostname, value);
  });
}

test('an empty HOST preserves an explicit HOSTNAME', () => {
  const result = start({ HOST: '', HOSTNAME: '127.0.0.1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stages[2].hostname, '127.0.0.1');
});

test('uses the standalone server defaults when HOSTNAME/PORT are unset', () => {
  const result = start();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stages[2].hostname || '0.0.0.0', '0.0.0.0');
  assert.equal(result.stages[2].port, undefined);
});

test('initializes in order, extends PATH, and replaces the shell via exec', () => {
  const result = start();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stages.map(({ stage }) => stage),
    ['check-db', 'update-tracker', 'server'],
  );
  assert.equal(result.stages[0].path.split(path.delimiter)[0], result.bin);
  assert.equal(result.stages[2].pid, result.pid);
});

for (const [stage, expected] of [
  ['check-db', ['check-db']],
  ['update-tracker', ['check-db', 'update-tracker']],
]) {
  test(`stops after ${stage} fails`, () => {
    const result = start({ FAIL_STAGE: stage });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(
      result.stages.map(({ stage: name }) => name),
      expected,
    );
  });
}
