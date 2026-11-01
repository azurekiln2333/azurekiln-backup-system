#!/usr/bin/env node
// Shared release metadata and deployment-asset packaging.
//
// Both publishing lanes (GitHub Actions and CNB) call this file so that tag
// validation, prerelease detection, channel eligibility and the deployment
// bundle can never disagree between platforms.
//
//   1. Import the pure helpers from build metadata code or tests.
//   2. Call `resolveReleaseMeta()` before any write operation; it throws for an
//      invalid tag instead of publishing something ambiguous.
//   3. Call `prepareRelease()` to write the deployment archive + SHA-256 sidecar.
//
// Usage:
//   node scripts/prepare-release.mjs                 # package the deployment bundle (default)
//   node scripts/prepare-release.mjs --check-tag v0.1.0
//   node scripts/prepare-release.mjs --bundle --out-dir dist [--tag v0.1.0] [--source-date-epoch N]
//
// A bare invocation packages the bundle from the current checkout for
// `v<package-version>`. `scripts/ci-verify.sh verify-and-package` relies on that
// default; the publishing lanes pass `--check-tag` to validate before writing.
//
// Exit codes: 0 = success, 1 = unexpected failure, 2 = invalid input/tag.
import { createHash } from 'node:crypto';
import { open, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** SemVer 2.0.0-ish grammar used by npm: release/prerelease core plus optional build metadata. */
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Files copied into the deployment archive, in archive order. */
export const BUNDLE_FILES = [
  'compose.yaml',
  'compose.build.yaml',
  '.env.docker.example',
  'README.md',
  'README.en.md',
  'README.zh-TW.md',
];

/** Extra per-file cap so a runaway README cannot bloat the operator download. */
export const README_EXCERPT_BYTES = 64 * 1024;

/**
 * Path segments that must never appear in the deployment archive. This is a
 * belt-and-braces guard on top of the explicit `BUNDLE_FILES` allowlist: a
 * future edit that adds a whole-directory copy still cannot leak local state.
 */
export const FORBIDDEN_SEGMENTS = [
  '.env',
  '.data',
  'sources',
  '.artifacts',
  'node_modules',
  '.agent',
  '.agents',
  '.claude',
  '.codebuddy',
  '.codex',
  '.cursor',
  '.dsh',
  '.kimi-code',
  '.opencode',
  '.pi',
  '.trae',
  '.zcode',
  '.trellis',
  '.tmp',
  'dist',
  'web/dist',
  'coverage',
];

/** Archive member name for a bundled source file. */
const memberName = (file) => `azurekiln-backup-system/${file}`;

/** Parse `1.2.3-rc.1+build` into its parts, or return null. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease, build] = match;
  return {
    version: value.trim(),
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
    build: build ? build.split('.') : [],
    isPrerelease: Boolean(prerelease),
  };
}

/** Numeric comparison for SemVer prerelease identifiers (numeric sorts before alphanumeric). */
function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Compare two release versions by SemVer precedence. Build metadata is ignored
 * on purpose: `0.1.0+build.7` has the same precedence as `0.1.0`.
 * Returns a negative number, zero or a positive number.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new Error(`cannot compare invalid version: ${!a ? left : right}`);
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.isPrerelease && !b.isPrerelease) return 0;
  // A release outranks any of its prereleases.
  if (!a.isPrerelease) return 1;
  if (!b.isPrerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    // A shorter prerelease list has lower precedence when all shared parts match.
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const result = compareIdentifiers(leftPart, rightPart);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * Strictly parse a release tag. Only `v<package-version>` is accepted, and the
 * version part must equal the package version byte for byte.
 */
export function parseReleaseTag(tag, packageVersion) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('release tag is required');
  }
  if (!tag.startsWith('v')) {
    throw new Error(`release tag "${tag}" must start with "v"`);
  }
  const parsed = parseVersion(tag.slice(1));
  if (!parsed) {
    throw new Error(`release tag "${tag}" is not a valid semantic version`);
  }
  const expected = packageVersion;
  const expectedParsed = parseVersion(expected);
  if (!expectedParsed) {
    throw new Error(`package version "${expected}" is not a valid semantic version`);
  }
  if (parsed.version !== expectedParsed.version) {
    throw new Error(`release tag "${tag}" does not match package version "${expected}"`);
  }
  return { ...parsed, tag };
}

/** Every docker tag the publishing run may write for a version. */
export function imageTagNames(version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (!parsed) throw new Error(`invalid version: ${version}`);
  return parsed.isPrerelease ? [parsed.version] : [parsed.version, 'latest'];
}

/**
 * Decide whether a publishing run may move the stable `latest` channel.
 *
 * @param {object} options
 * @param {object} options.release  Parsed release from `parseReleaseTag`.
 * @param {string|null} options.currentLatest  Version that `latest` currently
 *   points at. `null`/`''` means the channel is genuinely empty; `'unknown'`
 *   means the current state could not be read and promotion must fail closed.
 * @param {Map<string,string>|null} options.publishedVersionByCommit  Versions
 *   versions mapped to the commit they were published from; a marker value of
 *   `'*'` means "this version was published from an unknown commit". Used to tell
 *   a same-commit rerun apart from an older-tag rerun.
 * @param {string|null} options.concurrency  `queued`/`pending` means another
 *   run is waiting; promotion must not race with it.
 */
export function resolveChannel({
  release,
  currentLatest = null,
  publishedVersionByCommit = null,
  concurrency = null,
} = {}) {
  if (!release) throw new Error('release metadata is required');
  if (release.isPrerelease) {
    return {
      latest: false,
      reason: `prerelease ${release.version} never advances the stable channel`,
    };
  }
  const queued = concurrency === 'queued' || concurrency === 'pending';
  if (queued) {
    return {
      latest: false,
      reason: `another publishing run is ${concurrency}; stable promotion is serialized`,
    };
  }
  if (currentLatest === 'unknown') {
    return {
      latest: false,
      reason: 'current latest could not be read; refusing to advance an unknown channel',
    };
  }
  if (!currentLatest) {
    return { latest: true, reason: 'stable channel is empty' };
  }
  let comparison;
  try {
    comparison = compareVersions(release.version, currentLatest);
  } catch {
    return {
      latest: false,
      reason: `current latest "${currentLatest}" is not a comparable version`,
    };
  }
  if (comparison > 0) {
    return { latest: true, reason: `${release.version} is newer than ${currentLatest}` };
  }
  if (comparison === 0) {
    return { latest: true, reason: `${release.version} already is the stable channel` };
  }
  if (publishedVersionByCommit?.has(release.version)) {
    return {
      latest: false,
      reason: `rerun of ${release.version} from its original commit cannot downgrade ${currentLatest}`,
    };
  }
  return {
    latest: false,
    reason: `${release.version} is older than stable ${currentLatest}`,
  };
}

/** Deterministic, sorted metadata payload written next to the deployment archive. */
export function buildReleaseMetadata({
  release,
  packageVersion,
  packageName,
  repository = null,
  revision = null,
  image = null,
  imageTags = null,
  channel = null,
  sourceDateEpoch = null,
  files = [],
}) {
  const publishedAt = Number.isFinite(sourceDateEpoch)
    ? new Date(sourceDateEpoch * 1000).toISOString()
    : null;
  return {
    schema: 1,
    distribution: packageName ?? null,
    packageVersion: packageVersion ?? release.version,
    tag: release.tag,
    version: release.version,
    isPrerelease: release.isPrerelease,
    prereleaseIdentifiers: [...release.prerelease],
    buildMetadata: [...release.build],
    revision: revision ?? null,
    repository: repository ?? null,
    publishedAt,
    image: image ?? null,
    imageTags: imageTags ? [...imageTags].sort() : [],
    latestEligible: channel ? Boolean(channel.latest) : null,
    latestReason: channel ? channel.reason : null,
    files: files
      .map((file) => ({
        path: file.member,
        source: file.source,
        bytes: file.bytes,
        sha256: file.sha256,
        truncated: Boolean(file.truncated),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

/** Serialize metadata with stable key order and a trailing newline. */
export function serializeMetadata(metadata) {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

/**
 * Reject any archive member that is absolute, escapes the archive root, or
 * matches a forbidden local-state segment.
 */
export function assertBundlePath(member) {
  if (typeof member !== 'string' || member.length === 0) {
    throw new Error('bundle member name is required');
  }
  if (member.startsWith('/') || member.startsWith('\\') || /^[A-Za-z]:/.test(member)) {
    throw new Error(`bundle member "${member}" must be relative`);
  }
  const segments = member.split('/');
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    throw new Error(`bundle member "${member}" is not a normalized relative path`);
  }
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.includes(segment)) {
      throw new Error(`bundle member "${member}" exposes local state "${segment}"`);
    }
  }
  return member;
}

/** Reduce a README to its operator deployment sections. */
export function readmeExcerpt(text) {
  if (typeof text !== 'string') throw new Error('README content must be a string');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const keyword = /镜像|Image|image|Docker|docker|部署|Deploy/;
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      current = { level: heading[1].length, title: heading[2], lines: [line] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  const selected = sections.filter((section) => keyword.test(section.title));
  const excerpt = selected.map((section) => section.lines.join('\n').trim()).join('\n\n');
  return `${excerpt}\n`;
}

/** Minimal deterministic POSIX ustar writer (no gzip), enough for a flat file bundle. */
function tarHeader({ name, size, mode, mtimeSeconds }) {
  const header = Buffer.alloc(512, 0);
  const write = (value, offset, length) => {
    header.write(value, offset, length, 'utf8');
  };
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;
  const shortName = Buffer.byteLength(name, 'utf8');
  if (shortName > 100) throw new Error(`bundle member "${name}" exceeds the tar name limit`);
  write(name, 0, shortName);
  write(octal(mode, 8), 100, 8);
  write(octal(0, 8), 108, 8); // uid
  write(octal(0, 8), 116, 8); // gid
  write(octal(size, 12), 124, 12);
  write(octal(mtimeSeconds, 12), 136, 12);
  write('        ', 148, 8); // checksum placeholder
  write('0', 156, 1); // regular file
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

/**
 * Build a deterministic, gzipped tar from `files`. Every mtime is the same so
 * two builds from identical inputs produce identical bytes and hashes.
 */
export function buildBundleArchive(files, { sourceDateEpoch } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('bundle archive needs at least one file');
  }
  const mtimeSeconds = Number.isFinite(sourceDateEpoch) ? Math.floor(sourceDateEpoch) : 0;
  const chunks = [];
  for (const file of files) {
    assertBundlePath(file.member);
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content ?? '', 'utf8');
    chunks.push(tarHeader({ name: file.member, size: content.length, mode: 0o644, mtimeSeconds }));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** `sha256sum`-compatible sidecar line for the archive. */
export function sha256Sidecar(archiveName, digest) {
  if (!archiveName || !/^[0-9a-f]{64}$/.test(digest || '')) {
    throw new Error('sha256 sidecar needs an archive name and a 64-character hex digest');
  }
  return `${digest}  ${archiveName}\n`;
}

/** Read at most `limit` bytes of a file without loading the whole thing twice. */
async function readCapped(filePath, limit) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Collect the exact bundle members from a source checkout. Throws when a
 * required deployment file is missing so a release cannot silently ship a
 * partial installation.
 */
export async function collectBundleFiles(rootDir = process.cwd()) {
  const files = [];
  for (const file of BUNDLE_FILES) {
    const absolute = path.join(rootDir, file);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new Error(`deployment bundle source "${file}" is missing`);
    }
    if (!info.isFile()) throw new Error(`deployment bundle source "${file}" is not a file`);
    const isReadme = file.startsWith('README');
    const limit = isReadme ? README_EXCERPT_BYTES : info.size + 1;
    const raw = await readCapped(absolute, limit);
    let content = isReadme ? Buffer.from(readmeExcerpt(raw.toString('utf8')), 'utf8') : raw;
    const member = memberName(file);
    assertBundlePath(member);
    files.push({
      source: file,
      member,
      content,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      truncated: isReadme ? raw.length > limit : false,
    });
  }
  return files;
}

/**
 * Full metadata resolution used by both publishing lanes. Throws with a clear
 * message for any tag/version mismatch; a caller must not publish on a throw.
 */
export function resolveReleaseMeta({
  tag,
  packageVersion,
  packageName = null,
  repository = null,
  revision = null,
  image = null,
  currentLatest = null,
  publishedVersionByCommit = null,
  concurrency = null,
} = {}) {
  const parsed = parseReleaseTag(tag, packageVersion);
  const release = { ...parsed };
  const channel = resolveChannel({ release, currentLatest, publishedVersionByCommit, concurrency });
  const imageTags = imageTagNames(release);
  return { release, channel, imageTags, image };
}

/** Write `<outDir>/<archive>` and `<archive>.sha256`. Returns the produced paths and digest. */
export async function prepareRelease({
  rootDir = process.cwd(),
  outDir = path.join(rootDir, 'dist'),
  tag = null,
  packageVersion,
  packageName = null,
  repository = null,
  revision = null,
  image = null,
  currentLatest = null,
  publishedVersionByCommit = null,
  concurrency = null,
  sourceDateEpoch = null,
} = {}) {
  if (!packageVersion) throw new Error('packageVersion is required');
  const effectiveTag = tag ?? `v${packageVersion}`;
  const resolved = resolveReleaseMeta({
    tag: effectiveTag,
    packageVersion,
    packageName,
    repository,
    revision,
    image,
    currentLatest,
    publishedVersionByCommit,
    concurrency,
  });
  const files = await collectBundleFiles(rootDir);
  const archiveName = `azurekiln-backup-system-${resolved.release.version}-deploy.tar.gz`;
  const metadataName = 'release.json';
  const archive = buildBundleArchive(files, { sourceDateEpoch });
  const metadata = buildReleaseMetadata({
    release: resolved.release,
    packageVersion,
    packageName,
    repository,
    revision,
    image,
    imageTags: resolved.imageTags,
    channel: resolved.channel,
    sourceDateEpoch,
    files,
  });
  const metadataBuffer = Buffer.from(
    serializeMetadata({ ...metadata, archive: archiveName }),
    'utf8',
  );
  const archiveDigest = createHash('sha256').update(archive).digest('hex');

  await mkdir(outDir, { recursive: true });
  const archivePath = path.join(outDir, archiveName);
  const sidecarPath = `${archivePath}.sha256`;
  const metadataPath = path.join(outDir, metadataName);
  await writeFile(archivePath, archive);
  await writeFile(sidecarPath, sha256Sidecar(archiveName, archiveDigest));
  await writeFile(metadataPath, metadataBuffer);

  return {
    ...resolved,
    archiveName,
    archivePath,
    sidecarPath,
    metadataPath,
    archiveDigest,
    archiveBytes: archive.length,
    files: metadata.files,
  };
}

/** Read `name` and `version` out of a package.json-shaped file. */
export async function readPackageInfo(rootDir = process.cwd()) {
  const manifest = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  if (!manifest?.version || !parseVersion(manifest.version)) {
    throw new Error('package.json version is not a valid semantic version');
  }
  return { name: manifest.name ?? null, version: manifest.version };
}

function parseArgs(argv) {
  const options = { checkTag: null, bundle: false, outDir: null, tag: null, sourceDateEpoch: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bundle') {
      options.bundle = true;
    } else if (arg === '--check-tag') {
      options.checkTag = argv[index + 1];
      index += 1;
    } else if (arg === '--tag') {
      options.tag = argv[index + 1];
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = argv[index + 1];
      index += 1;
    } else if (arg === '--source-date-epoch') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value)) throw new Error('--source-date-epoch must be a number');
      options.sourceDateEpoch = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

const HELP = `Usage:
  node scripts/prepare-release.mjs                              package the deployment bundle
  node scripts/prepare-release.mjs --check-tag <tag>            validate a release tag only
  node scripts/prepare-release.mjs --bundle --out-dir <dir> [--tag <tag>] [--source-date-epoch <n>]
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const rootDir = process.cwd();
  const { name, version } = await readPackageInfo(rootDir);

  if (options.checkTag) {
    const resolved = resolveReleaseMeta({
      tag: options.checkTag,
      packageVersion: version,
      packageName: name,
      revision: process.env.GITHUB_SHA ?? null,
    });
    process.stdout.write(`${JSON.stringify({
      tag: resolved.release.tag,
      version: resolved.release.version,
      isPrerelease: resolved.release.isPrerelease,
      imageTags: resolved.imageTags,
      latestEligible: resolved.channel.latest,
    })}\n`);
    return 0;
  }

  if (!options.bundle && !options.tag) options.bundle = true;

  const result = await prepareRelease({
    rootDir,
    outDir: options.outDir ? path.resolve(rootDir, options.outDir) : path.join(rootDir, 'dist'),
    tag: options.tag,
    packageVersion: version,
    packageName: name,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    revision: process.env.GITHUB_SHA ?? null,
    sourceDateEpoch: options.sourceDateEpoch,
  });
  process.stdout.write(`${JSON.stringify({
    archive: result.archiveName,
    archivePath: result.archivePath,
    sidecarPath: result.sidecarPath,
    metadataPath: result.metadataPath,
    digest: result.archiveDigest,
    bytes: result.archiveBytes,
    version: result.release.version,
    tag: result.release.tag,
    isPrerelease: result.release.isPrerelease,
    imageTags: result.imageTags,
  })}\n`);
  // Plain, unescaped path on its own line, with no prefix. `scripts/ci-verify.sh`
  // greps stdout for an archive path and stats it, so a JSON-escaped Windows
  // path (or any other encoding) must not be the only thing printed. Callers
  // that want the structured contract parse the JSON line above.
  process.stdout.write(`${result.archivePath}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    const invalid = /tag|version|argument|bundle source/.test(error.message ?? '');
    process.stderr.write(`prepare-release: ${error.message}\n`);
    process.exitCode = invalid ? 2 : 1;
  }
}
