import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bash = '/bin/bash';
const unavailable = process.platform === 'win32' ? 'Linux installer requires POSIX executable fixtures' : !existsSync(bash);
const shellPath = (value) => value.replaceAll('\\', '/');

async function fixture(architecture, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-rclone-installer-'));
  const bin = path.join(directory, 'bin');
  const destination = path.join(directory, 'installed');
  await mkdir(bin);
  await mkdir(destination);
  await writeFile(path.join(destination, 'rclone'), 'previous verified executable');
  const scripts = {
    uname: '#!/usr/bin/env bash\nprintf "%s\\n" "$FIXTURE_ARCH"\n',
    curl: '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$FIXTURE_REQUEST"\nwhile (( $# )); do\n  if [[ "$1" == "--output" ]]; then printf "corrupted archive" > "$2"; exit 0; fi\n  shift\ndone\nexit 2\n',
  };
  for (const [name, source] of Object.entries(scripts)) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  const requestFile = path.join(directory, 'request.txt');
  const result = spawnSync(bash, ['scripts/install-rclone.sh', shellPath(destination)], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: shellPath(directory),
      FIXTURE_ARCH: architecture, FIXTURE_REQUEST: shellPath(requestFile),
    },
  });
  try { await callback({ result, directory, destination, requestFile }); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('rclone installer rejects corrupt archives on both published architectures without replacing tools', { skip: unavailable }, async () => {
  for (const [architecture, packageArch] of [['x86_64', 'amd64'], ['aarch64', 'arm64']]) {
    await fixture(architecture, async ({ result, directory, destination, requestFile }) => {
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(await readFile(requestFile, 'utf8'), new RegExp(`/rclone-v1\\.75\\.1-linux-${packageArch}\\.zip`));
      assert.equal(await readFile(path.join(destination, 'rclone'), 'utf8'), 'previous verified executable');
      assert.equal((await readdir(directory)).some((name) => name.startsWith('azurekiln-rclone.')), false);
    });
  }
});

test('rclone installer rejects unsupported architectures before downloading', { skip: unavailable }, async () => {
  await fixture('unsupported-architecture', async ({ result, destination, requestFile }) => {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /Unsupported rclone installation architecture/);
    assert.equal(existsSync(requestFile), false);
    assert.equal(await readFile(path.join(destination, 'rclone'), 'utf8'), 'previous verified executable');
  });
});
