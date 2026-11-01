// Release metadata and deployment-bundle contracts.
//
// These tests pin the decisions that both publishing lanes depend on: only a
// `v<package-version>` tag may publish, prereleases never move `latest`, an
// older-tag rerun cannot downgrade a newer stable, and the deployment archive
// contains the operator files (and nothing private) with a verifiable checksum.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUNDLE_FILES,
  FORBIDDEN_SEGMENTS,
  assertBundlePath,
  buildBundleArchive,
  buildReleaseMetadata,
  compareVersions,
  imageTagNames,
  parseReleaseTag,
  parseVersion,
  prepareRelease,
  readmeExcerpt,
  resolveChannel,
  resolveReleaseMeta,
  serializeMetadata,
  sha256Sidecar,
} from '../scripts/prepare-release.mjs';

const STABLE = parseReleaseTag('v1.4.0', '1.4.0');
const PRERELEASE = parseReleaseTag('v1.4.0-rc.1', '1.4.0-rc.1');

function channel(options) {
  return resolveChannel({ release: STABLE, ...options });
}

/** Extract the member list and gzip payload from a `.tar.gz` bundle. */
async function readBundleMembers(buffer) {
  const { gunzipSync } = await import('node:zlib');
  const tar = gunzipSync(buffer);
  const members = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8);
    if (!name || !Number.isFinite(size)) throw new Error(`unreadable tar header at ${offset}`);
    const start = offset + 512;
    members.push({ name, content: tar.subarray(start, start + size) });
    offset = start + size + ((512 - (size % 512)) % 512);
  }
  return members;
}

test('a release tag must be exactly v<package-version>', () => {
  assert.equal(parseReleaseTag('v1.4.0', '1.4.0').version, '1.4.0');
  assert.equal(parseReleaseTag('v0.1.0-rc.2', '0.1.0-rc.2').isPrerelease, true);
  assert.equal(parseReleaseTag('v1.4.0', '1.4.0').tag, 'v1.4.0');

  const rejected = [
    ['1.4.0', '1.4.0'],       // missing leading v
    ['v1.4.0', '1.4.1'],      // tag/package mismatch
    ['v1.4', '1.4'],          // not a full semantic version
    ['v01.4.0', '01.4.0'],    // no leading zeroes
    ['v1.4.0-', '1.4.0-'],    // empty prerelease
    ['v1.4.0+x', '1.4.0+y'],  // build metadata differs from the package
    ['v', '1.4.0'],
    ['', '1.4.0'],
    ['release-v1.4.0', '1.4.0'],
  ];
  for (const [tag, version] of rejected) {
    assert.throws(
      () => parseReleaseTag(tag, version),
      /release tag|package version/,
      `${tag} vs ${version}`,
    );
  }
  assert.equal(parseVersion('not-a-version'), null);
  assert.deepEqual(parseVersion('1.2.3-rc.1+build.7').build, ['build', '7']);
});

test('prereleases are detected and never claim the latest image tag', () => {
  assert.equal(PRERELEASE.isPrerelease, true);
  assert.equal(STABLE.isPrerelease, false);
  assert.deepEqual(imageTagNames(STABLE.version), ['1.4.0', 'latest']);
  assert.deepEqual(imageTagNames(PRERELEASE.version), ['1.4.0-rc.1']);
  assert.deepEqual(imageTagNames('1.4.0+build.5'), ['1.4.0+build.5', 'latest']);
});

test('semantic version precedence orders release over prerelease', () => {
  assert.ok(compareVersions('1.4.0', '1.3.9') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.4.0', '1.4.0-rc.1') > 0);
  assert.ok(compareVersions('1.4.0-rc.2', '1.4.0-rc.1') > 0);
  assert.ok(compareVersions('1.4.0-rc.10', '1.4.0-rc.9') > 0);
  assert.ok(compareVersions('1.4.0-rc.1', '1.4.0-beta.11') > 0);
  assert.ok(compareVersions('1.4.0-alpha', '1.4.0-alpha.1') < 0);
  assert.equal(compareVersions('1.4.0+build.1', '1.4.0+build.2'), 0);
  assert.throws(() => compareVersions('1.4.0', 'nope'), /invalid version/);
});

test('stable promotion requires a newer version than the current latest', () => {
  assert.deepEqual(channel({ currentLatest: null }), {
    latest: true, reason: 'stable channel is empty',
  });
  assert.equal(channel({ currentLatest: '1.3.9' }).latest, true);
  assert.equal(channel({ currentLatest: '1.4.0' }).latest, true, 're-promoting the same version is harmless');

  const older = channel({ currentLatest: '1.5.0' });
  assert.equal(older.latest, false);
  assert.match(older.reason, /older than stable 1\.5\.0/);

  const unparsable = channel({ currentLatest: 'nightly' });
  assert.equal(unparsable.latest, false);
  assert.match(unparsable.reason, /not a comparable version/);

  // An unreadable registry state must never be mistaken for an empty channel.
  const unknown = channel({ currentLatest: 'unknown' });
  assert.equal(unknown.latest, false);
  assert.match(unknown.reason, /could not be read/);
});

test('prerelease, queued runs and older-tag reruns cannot move latest', () => {
  const prerelease = resolveChannel({ release: PRERELEASE, currentLatest: '0.0.1' });
  assert.equal(prerelease.latest, false);
  assert.match(prerelease.reason, /prerelease/);

  const queued = channel({ currentLatest: '1.3.0', concurrency: 'queued' });
  assert.equal(queued.latest, false);
  assert.match(queued.reason, /serialized/);

  const pending = channel({ currentLatest: '1.3.0', concurrency: 'pending' });
  assert.equal(pending.latest, false);

  const rerunMarker = channel({
    currentLatest: '1.5.0',
    publishedVersionByCommit: new Map([['1.4.0', '*']]),
  });
  assert.equal(rerunMarker.latest, false);
  assert.match(rerunMarker.reason, /rerun of 1\.4\.0/);

  // An ordinary older tag that was never published from this commit stays the
  // plain "older" case rather than being mistaken for a rerun.
  const neverPublished = channel({
    currentLatest: '1.5.0',
    publishedVersionByCommit: new Map([['1.6.0', '*']]),
  });
  assert.equal(neverPublished.latest, false);
  assert.match(neverPublished.reason, /older than stable/);
});

test('image tag names never invent a channel for a prerelease', () => {
  const stable = resolveReleaseMeta({
    tag: 'v2.0.0', packageVersion: '2.0.0', currentLatest: '1.9.0',
  });
  assert.deepEqual(stable.imageTags, ['2.0.0', 'latest']);
  assert.equal(stable.channel.latest, true);

  const prerelease = resolveReleaseMeta({
    tag: 'v2.0.0-beta.1', packageVersion: '2.0.0-beta.1', currentLatest: '1.9.0',
  });
  assert.deepEqual(prerelease.imageTags, ['2.0.0-beta.1']);
  assert.equal(prerelease.channel.latest, false);

  assert.throws(
    () => resolveReleaseMeta({ tag: 'v2.0.0', packageVersion: '2.0.1' }),
    /does not match package version/,
  );
});

test('release metadata is deterministic for identical inputs', () => {
  const files = [
    { member: 'b/second.yaml', source: 'second.yaml', content: 'b: 2\n', bytes: 5, sha256: 'b'.repeat(64) },
    { member: 'a/first.yaml', source: 'first.yaml', content: 'a: 1\n', bytes: 5, sha256: 'a'.repeat(64) },
  ];
  const args = {
    release: STABLE,
    packageVersion: '1.4.0',
    packageName: 'azurekiln-backup-system',
    revision: 'c'.repeat(40),
    image: 'ghcr.io/example/app',
    imageTags: ['1.4.0', 'latest'],
    channel: { latest: true, reason: 'stable channel is empty' },
    sourceDateEpoch: 1700000000,
    files,
  };
  const first = serializeMetadata(buildReleaseMetadata(args));
  const second = serializeMetadata(buildReleaseMetadata({ ...args, files: [...files].reverse() }));
  assert.equal(first, second, 'file order must not change the serialized metadata');
  const parsed = JSON.parse(first);
  assert.equal(parsed.tag, 'v1.4.0');
  assert.equal(parsed.version, '1.4.0');
  assert.equal(parsed.publishedAt, new Date(1700000000 * 1000).toISOString());
  assert.deepEqual(parsed.files.map((file) => file.source), ['first.yaml', 'second.yaml']);
  assert.deepEqual(parsed.imageTags, ['1.4.0', 'latest']);
  assert.equal(parsed.isPrerelease, false);
  assert.equal(parsed.latestEligible, true);
  assert.deepEqual(Object.keys(parsed), [
    'schema', 'distribution', 'packageVersion', 'tag', 'version', 'isPrerelease',
    'prereleaseIdentifiers', 'buildMetadata', 'revision', 'repository', 'publishedAt',
    'image', 'imageTags', 'latestEligible', 'latestReason', 'files',
  ]);
});

test('deployment bundle paths reject absolute, escaping and private members', () => {
  for (const allowed of ['azurekiln-backup-system/compose.yaml', 'azurekiln-backup-system/.env.docker.example']) {
    assert.equal(assertBundlePath(allowed), allowed);
  }
  const rejected = [
    '/etc/passwd',
    'C:/Windows/system32',
    '../outside.yaml',
    'azurekiln-backup-system/../../escape.yaml',
    'azurekiln-backup-system//double.yaml',
    '',
  ];
  for (const member of rejected) {
    assert.throws(() => assertBundlePath(member), /relative|normalized|required/, member);
  }
  for (const segment of FORBIDDEN_SEGMENTS) {
    assert.throws(
      () => assertBundlePath(`azurekiln-backup-system/${segment}/leak.txt`),
      /local state/,
      segment,
    );
  }
  // `.env.docker.example` is a template, not the private `.env`.
  assert.ok(BUNDLE_FILES.includes('.env.docker.example'));
  assert.ok(!BUNDLE_FILES.includes('.env'));
});

test('readme excerpt keeps operator sections and drops the rest', () => {
  const text = [
    '# Title',
    'Intro paragraph about everything.',
    '## Docker deployment',
    'Run docker compose pull.',
    '## Backup behavior',
    'Unrelated product detail.',
    '## Image source',
    'Latest follows stable.',
  ].join('\n');
  const excerpt = readmeExcerpt(text);
  assert.match(excerpt, /## Docker deployment/);
  assert.match(excerpt, /## Image source/);
  assert.doesNotMatch(excerpt, /## Backup behavior/);
  assert.doesNotMatch(excerpt, /Intro paragraph/);
  assert.match(readmeExcerpt('no headings at all'), /\n$/);
});

test('sha256 sidecar matches the sha256sum output format', () => {
  const digest = 'd'.repeat(64);
  assert.equal(sha256Sidecar('app-1.0.0-deploy.tar.gz', digest), `${digest}  app-1.0.0-deploy.tar.gz\n`);
  assert.throws(() => sha256Sidecar('', digest), /archive name/);
  assert.throws(() => sha256Sidecar('app.tar.gz', 'nothex'), /64-character/);
});

test('a synthetic bundle archives exactly the declared members', async () => {
  const archive = buildBundleArchive(
    [
      { member: 'app/compose.yaml', content: 'services: {}\n' },
      { member: 'app/.env.docker.example', content: 'BACKUP_PORT=16323\n' },
    ],
    { sourceDateEpoch: 1700000000 },
  );
  const members = await readBundleMembers(archive);
  assert.deepEqual(members.map((member) => member.name), [
    'app/compose.yaml',
    'app/.env.docker.example',
  ]);
  assert.equal(members[0].content.toString('utf8'), 'services: {}\n');
  const again = buildBundleArchive(
    [
      { member: 'app/compose.yaml', content: 'services: {}\n' },
      { member: 'app/.env.docker.example', content: 'BACKUP_PORT=16323\n' },
    ],
    { sourceDateEpoch: 1700000000 },
  );
  assert.deepEqual(archive, again, 'identical inputs must produce identical archives');
});

test('prepareRelease packages the operator files and never local state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-release-'));
  try {
    for (const file of BUNDLE_FILES) {
      const body = file.startsWith('README')
        ? `# ${file}\n\n## Docker deployment\n\nUse the prebuilt image.\n`
        : `${file}: placeholder\n`;
      await writeFile(path.join(root, file), body, 'utf8');
    }
    // Private/local material that must never be archived.
    await writeFile(path.join(root, '.env'), 'ADMIN_PASSWORD=do-not-ship\n', 'utf8');
    await mkdir(path.join(root, '.data'), { recursive: true });
    await writeFile(path.join(root, '.data', 'db.sqlite3'), 'state', 'utf8');
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module', 'utf8');
    await mkdir(path.join(root, 'sources'), { recursive: true });
    await writeFile(path.join(root, 'sources', 'archive.zip'), 'user-archive', 'utf8');
    await mkdir(path.join(root, '.agents'), { recursive: true });
    await writeFile(path.join(root, '.agents', 'agent.json'), '{}', 'utf8');

    const outDir = path.join(root, 'dist');
    const result = await prepareRelease({
      rootDir: root,
      outDir,
      tag: 'v1.4.0',
      packageVersion: '1.4.0',
      packageName: 'azurekiln-backup-system',
      revision: 'e'.repeat(40),
      sourceDateEpoch: 1700000000,
    });

    assert.equal(result.release.version, '1.4.0');
    assert.deepEqual(result.imageTags, ['1.4.0', 'latest']);
    assert.equal(result.archiveName, 'azurekiln-backup-system-1.4.0-deploy.tar.gz');

    const archiveBytes = await readFile(result.archivePath);
    const members = await readBundleMembers(archiveBytes);
    const names = members.map((member) => member.name).sort();
    assert.deepEqual(names, BUNDLE_FILES.map((file) => `azurekiln-backup-system/${file}`).sort());

    const flat = members.map((member) => member.name).join('\n');
    assert.doesNotMatch(flat, /(^|\/)\.env$/m, 'the private .env must not be archived');
    assert.doesNotMatch(flat, /\.data\//, 'persistent state must not be archived');
    assert.doesNotMatch(flat, /node_modules\//, 'node_modules must not be archived');
    assert.doesNotMatch(flat, /sources\//, 'user archives must not be archived');
    assert.doesNotMatch(flat, /\.agents\//, 'local agent directories must not be archived');

    // The archive never contains a real credential value from the checkout.
    for (const member of members) {
      assert.doesNotMatch(member.content.toString('utf8'), /do-not-ship/);
    }

    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    assert.equal(digest, result.archiveDigest);
    const sidecar = await readFile(result.sidecarPath, 'utf8');
    assert.equal(sidecar, `${digest}  ${result.archiveName}\n`);

    const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8'));
    assert.equal(metadata.tag, 'v1.4.0');
    assert.equal(metadata.revision, 'e'.repeat(40));
    assert.equal(metadata.archive, result.archiveName);
    assert.equal(metadata.latestEligible, true);
    assert.equal(metadata.isPrerelease, false);
    assert.equal(metadata.files.length, BUNDLE_FILES.length);

    // Rerun with the same inputs produces the same bytes ("predictable rerun").
    const rerun = await prepareRelease({
      rootDir: root,
      outDir: path.join(root, 'dist-2'),
      tag: 'v1.4.0',
      packageVersion: '1.4.0',
      packageName: 'azurekiln-backup-system',
      revision: 'e'.repeat(40),
      sourceDateEpoch: 1700000000,
    });
    assert.equal(rerun.archiveDigest, result.archiveDigest);
    assert.deepEqual(await readdir(path.join(root, 'dist-2')), [
      result.archiveName, `${result.archiveName}.sha256`, 'release.json',
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepareRelease refuses a mismatched or missing deployment source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-release-bad-'));
  try {
    await writeFile(path.join(root, 'compose.yaml'), 'services: {}\n', 'utf8');
    await assert.rejects(
      () => prepareRelease({ rootDir: root, outDir: path.join(root, 'dist'), tag: 'v2.0.0', packageVersion: '1.4.0' }),
      /does not match package version/,
    );
    await assert.rejects(
      () => prepareRelease({ rootDir: root, outDir: path.join(root, 'dist'), tag: 'v1.4.0', packageVersion: '1.4.0' }),
      /deployment bundle source ".*" is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
