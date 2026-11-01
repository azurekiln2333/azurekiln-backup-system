// Structural guards for the CI entrypoints in scripts/.
//
// These are deliberately cheap: they parse shell text and assert the contracts
// the delivery pipelines depend on. They do not execute docker, build an image,
// or run the browser suites — scripts/ci-verify.sh and scripts/check-image.sh do
// that in the Linux pipeline. The failure mode this file prevents is a silent
// edit that re-introduces skipping, real-.env mounts, or socket exposure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const ciVerify = read('scripts/ci-verify.sh');
const checkImage = read('scripts/check-image.sh');

test('ci-verify accepts exactly the two documented modes', () => {
  assert.match(ciVerify, /verify\|verify-and-package\) ;;/);
  assert.match(ciVerify, /export RUN_BACKUP_INTEGRATION=1/);
  assert.match(ciVerify, /scripts\/prepare-release\.mjs/);
});

test('ci-verify exports absolute tool paths and proves execution', () => {
  for (const variable of ['RCLONE_BINARY', 'SEVEN_ZIP_BINARY', 'SQLITE_BINARY', 'PG_DUMP_BINARY', 'MYSQL_DUMP_BINARY']) {
    assert.match(ciVerify, new RegExp(`export ${variable}=`), `${variable} must be exported`);
  }
  // Every asserted tool must be run, not merely stat-ed.
  assert.match(ciVerify, /assert_tool rclone version/);
  assert.match(ciVerify, /assert_tool seven_zip i/);
  assert.match(ciVerify, /assert_tool tar --version/);
  assert.match(ciVerify, /assert_tool sqlite3 --version/);
  assert.match(ciVerify, /assert_tool pg_dump --version/);
  assert.match(ciVerify, /assert_tool mariadb_dump --version/);
  // `tar` is resolved through PATH because loadConfig has no tar override.
  assert.doesNotMatch(ciVerify, /export TAR_BINARY=/);
});

test('ci-verify runs browser and layout checks sequentially after the build', () => {
  const check = ciVerify.indexOf('run_step check npm run check');
  const testStep = ciVerify.indexOf('run_step test run_tests');
  const build = ciVerify.indexOf('run_step build npm run build');
  const browser = ciVerify.indexOf('run_step browser npm run check:browser');
  const layout = ciVerify.indexOf('run_step layout npm run check:layout');
  for (const index of [check, testStep, build, browser, layout]) assert.ok(index > 0, 'step must be present');
  assert.ok(check < testStep && testStep < build && build < browser && browser < layout, 'steps must stay in order');
  // TAP output is what the skip/required-case parsers read.
  assert.match(ciVerify, /npm test -- --test-reporter=tap/);
  assert.match(ciVerify, /BROWSER_EXECUTABLE/);
});

test('ci-verify fails on skipped real-tool cases instead of reporting green', () => {
  assert.match(ciVerify, /assert_skips_within_budget/);
  assert.match(ciVerify, /assert_required_cases_executed/);
  assert.match(ciVerify, /MAX_SKIPPED="\$\{CI_VERIFY_MAX_SKIPPED:-0\}"/);
  // `# skipped N` (the aggregate summary) must not be mistaken for a SKIP marker.
  assert.match(ciVerify, /# SKIP/);
  assert.doesNotMatch(ciVerify, /\|# skip'/);
});

test('check-image never touches production configuration or volumes', () => {
  assert.match(checkImage, /--env-file "\$env_file"/);
  // The env file is generated inside the throwaway directory, not in the repo.
  assert.match(checkImage, /env_file="\$workdir\/test\.env"/);
  assert.doesNotMatch(checkImage, /--env-file ["']?\.env/);
  assert.doesNotMatch(checkImage, /backup-data:\/data/);
  assert.doesNotMatch(checkImage, /-v "\$REPO_ROOT/);
  // The run command must never mount the Docker socket into the application image.
  const runStart = checkImage.indexOf('docker run -d');
  assert.ok(runStart > 0, 'the docker run invocation must be present');
  const runBlock = checkImage.slice(runStart, checkImage.indexOf('"$IMAGE_REF" >/dev/null', runStart));
  assert.ok(runBlock.includes('--env-file'), 'the run block must be the real docker run command');
  assert.doesNotMatch(runBlock, /docker\.sock/, 'the app container must not receive the Docker socket');
  // The guard assertions that prove the above at run time must exist.
  assert.match(checkImage, /grep -q 'backup-data'/);
  assert.match(checkImage, /\/var\/run\/docker\.sock/);
});

test('check-image asserts HTTP readiness and every runtime tool', () => {
  assert.match(checkImage, /curl -fsS --max-time 5 "\$base_url\/api\/auth\/status"/);
  assert.match(checkImage, /docker rm -f "\$container"/);
  for (const tool of ['rclone', '7zz', 'tar', 'sqlite3', 'pg_dump', 'mariadb-dump']) {
    assert.ok(checkImage.includes(`check_tool ${tool} `), `${tool} must be checked`);
  }
  assert.match(checkImage, /-p "127\.0\.0\.1::\$\{APP_PORT\}"/);
});

test('references to the release helper stay honest', () => {
  const helperPath = path.join(root, 'scripts/prepare-release.mjs');
  // The package mode must refuse to invent release metadata when the owning
  // lane has not delivered scripts/prepare-release.mjs yet.
  assert.match(ciVerify, /does not exist; the package mode cannot fabricate release metadata/);
  // If the helper exists, the package mode must not be a no-op path.
  if (existsSync(helperPath)) assert.match(ciVerify, /node "\$PREPARE_RELEASE"/);
});

test('both scripts avoid bash constructs that break on older runners', () => {
  for (const [name, source] of [['ci-verify.sh', ciVerify], ['check-image.sh', checkImage]]) {
    assert.ok(source.startsWith('#!/usr/bin/env bash'), `${name} needs a bash shebang`);
    assert.doesNotMatch(source, /\bsudo\b/, `${name} must not rely on sudo`);
  }
  // A variable name may not start with a digit for the ${NAME-default} form, so
  // only the explicit colon form is legal here. Guard against a regression to
  // the bare form, which is a parse error the moment the branch is expanded.
  assert.match(ciVerify, /\$\{7ZZ_BINARY:-\}/);
  assert.doesNotMatch(ciVerify, /\$\{7ZZ_BINARY-\}/);
});
