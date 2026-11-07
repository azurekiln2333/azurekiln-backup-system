// Node path-mapping contracts.
//
// A node is another instance of this application with a different filesystem
// layout. Before a task definition is pushed, every path it references has to be
// translated or the job has to be skipped. These tests pin the rules that the
// sync lane depends on: longest prefix wins, `from` decides case sensitivity and
// separator style, a per-job override replaces the node rules, and an unmapped
// absolute path is reported so the caller skips the job instead of pushing a path
// the node cannot resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_PATH_MAX_LENGTH,
  NODE_PATH_RULE_LIMIT,
  isWindowsStyle,
  joinPath,
  mapPath,
  normalizeRule,
  normalizeRules,
  splitPath,
} from '../server/node-paths.mjs';

test('the longest matching prefix wins', () => {
  const rules = [
    { from: '/srv', to: '/mnt/srv' },
    { from: '/srv/vaultwarden', to: '/data/vaultwarden' },
    { from: '/srv/vaultwarden/db', to: '/db' },
  ];
  assert.equal(mapPath('/srv/vaultwarden/db/main.sqlite', rules).path, '/db/main.sqlite');
  assert.equal(mapPath('/srv/vaultwarden/rsa_key.pem', rules).path, '/data/vaultwarden/rsa_key.pem');
  assert.equal(mapPath('/srv/websites', rules).path, '/mnt/srv/websites');
  // Order in the rule list must not decide the result: the longest prefix does.
  assert.equal(mapPath('/srv/vaultwarden/rsa_key.pem', [...rules].reverse()).path, '/data/vaultwarden/rsa_key.pem');
});

test('a prefix matches whole segments, not string prefixes', () => {
  const rules = [{ from: '/srv', to: '/mnt' }];
  // `/srv-old` is not inside `/srv`; mapping it would silently retarget a source.
  assert.deepEqual(
    { path: mapPath('/srv-old/data', rules).path, mapped: mapPath('/srv-old/data', rules).mapped },
    { path: '/srv-old/data', mapped: false },
  );
  assert.equal(mapPath('/srv-old/data', rules).needsMapping, true);
  assert.equal(mapPath('/srv2', rules).mapped, false);
});

test('an exact match maps with no remainder', () => {
  const result = mapPath('/srv', [{ from: '/srv', to: '/data' }]);
  assert.equal(result.path, '/data');
  assert.equal(result.mapped, true);
  assert.equal(result.needsMapping, false);
});

test('the target keeps its own separator style', () => {
  const toWindows = mapPath('/srv/vaultwarden', [{ from: '/srv', to: 'C:\\apps' }]);
  assert.equal(toWindows.path, 'C:\\apps\\vaultwarden');
  const toPosix = mapPath('C:\\srv\\vaultwarden', [{ from: 'C:\\srv', to: '/data' }]);
  assert.equal(toPosix.path, '/data/vaultwarden');
});

test('a Windows-style from matches case-insensitively, a POSIX from does not', () => {
  const windowsRules = [{ from: 'C:\\Data\\Source', to: 'C:\\Mapped' }];
  assert.equal(mapPath('c:\\data\\source\\sub', windowsRules).path, 'C:\\Mapped\\sub');
  assert.equal(mapPath('C:/Data/Source/sub', windowsRules).path, 'C:\\Mapped\\sub');

  const posixRules = [{ from: '/srv/Source', to: '/data' }];
  assert.equal(mapPath('/srv/Source/sub', posixRules).mapped, true);
  // POSIX filesystems are case-sensitive, so a different case is a different path.
  const mismatched = mapPath('/srv/source/sub', posixRules);
  assert.equal(mismatched.mapped, false);
  assert.equal(mismatched.needsMapping, true);
});

test('repeated, mixed and trailing separators never defeat a match', () => {
  const rules = [{ from: '/srv/data/', to: '/mapped' }];
  for (const input of ['/srv//data/x', '/srv/data\\x', '/srv/data/x/', '/srv/./data/x']) {
    const result = mapPath(input, rules);
    assert.equal(result.mapped, true, input);
    assert.equal(result.path, '/mapped/x', input);
  }
});

test('an unmapped absolute path needs mapping and is not rewritten', () => {
  const result = mapPath('/opt/unrelated', [{ from: '/srv', to: '/data' }]);
  assert.equal(result.needsMapping, true);
  assert.equal(result.mapped, false);
  // The original path is returned unchanged so a caller can log it accurately.
  assert.equal(result.path, '/opt/unrelated');
});

test('an unmapped relative path does not need mapping', () => {
  // A relative path already means the same thing on the node, so it is usable.
  const result = mapPath('relative/dir', [{ from: '/srv', to: '/data' }]);
  assert.equal(result.mapped, false);
  assert.equal(result.needsMapping, false);
  assert.equal(result.path, 'relative/dir');
});

test('an empty or missing path is inert rather than an error', () => {
  for (const input of ['', '   ', undefined, null, 42]) {
    const result = mapPath(input, [{ from: '/srv', to: '/data' }]);
    assert.equal(result.path, '');
    assert.equal(result.mapped, false);
    assert.equal(result.needsMapping, false);
  }
});

test('with no rules every absolute path needs mapping', () => {
  const result = mapPath('/srv/x', []);
  assert.equal(result.needsMapping, true);
  assert.equal(mapPath('/srv/x').needsMapping, true);
});

test('a job override replaces the node rules instead of merging with them', () => {
  const nodeRules = [{ from: '/srv', to: '/data' }, { from: '/srv/special', to: '/wrong' }];
  const override = { sources: [{ from: '/srv/special', to: '/right' }] };
  const mapped = mapPath('/srv/special/x', nodeRules, override);
  assert.equal(mapped.path, '/right/x');
  assert.equal(mapped.rule.source, 'override');

  // The node rule that would otherwise match is not used once an override exists.
  const outside = mapPath('/srv/other', nodeRules, override);
  assert.equal(outside.mapped, false);
  assert.equal(outside.needsMapping, true);

  // An empty override list is still an explicit override: nothing maps.
  assert.equal(mapPath('/srv/other', nodeRules, { sources: [] }).needsMapping, true);
  // A job without an override entry uses the node rules.
  assert.equal(mapPath('/srv/other', nodeRules, null).path, '/data/other');
  assert.equal(mapPath('/srv/other', nodeRules, {}).path, '/data/other');
});

test('two nodes map the same task to different paths', () => {
  const job = { sourcePath: '/srv/vaultwarden', destinations: [{ remote: 'backup', path: '/remote/vaultwarden' }] };
  const nodeA = [{ from: '/srv', to: '/data/srv' }];
  const nodeB = [{ from: '/srv/vaultwarden', to: 'E:\\apps\\vaultwarden' }];

  assert.equal(mapPath(job.sourcePath, nodeA).path, '/data/srv/vaultwarden');
  assert.equal(mapPath(job.sourcePath, nodeB).path, 'E:\\apps\\vaultwarden');
  // A resolved local destination path is mapped by the same rule.
  assert.equal(mapPath('/srv/websites/dump', nodeA).path, '/data/srv/websites/dump');
  // A destination path outside the mapped root is reported, not silently rewritten.
  const remote = mapPath(job.destinations[0].path, nodeA);
  assert.equal(remote.mapped, false);
  assert.equal(remote.needsMapping, true);
});

test('normalizeRules rejects unusable and ambiguous rules', () => {
  assert.deepEqual(normalizeRules(undefined), []);
  assert.deepEqual(normalizeRules(null), []);
  assert.deepEqual(normalizeRules([{ from: ' /srv ', to: ' /data ' }]), [{ from: '/srv', to: '/data' }]);

  assert.throws(() => normalizeRules('nope'), /必须是数组/);
  assert.throws(() => normalizeRule(null), /必须是对象/);
  assert.throws(() => normalizeRule({ from: '', to: '/x' }), /不能为空/);
  assert.throws(() => normalizeRule({ from: 'relative', to: '/x' }), /必须是绝对路径/);
  assert.throws(() => normalizeRule({ from: '/a\0b', to: '/x' }), /空字符/);
  assert.throws(
    () => normalizeRule({ from: '/x', to: 'a'.repeat(NODE_PATH_MAX_LENGTH + 1) }),
    /最多/,
  );
  // The same source twice makes the outcome arbitrary, so it is rejected.
  assert.throws(() => normalizeRules([{ from: '/a', to: '/b' }, { from: '/a', to: '/c' }]), /重复/);
  // A Windows duplicate is caught case-insensitively, matching how it would match.
  assert.throws(() => normalizeRules([{ from: 'C:\\A', to: '/x' }, { from: 'c:\\a', to: '/y' }]), /重复/);
  // Distinct sources that only differ in case on POSIX are separate rules.
  assert.equal(normalizeRules([{ from: '/A', to: '/x' }, { from: '/a', to: '/y' }]).length, 2);
  assert.throws(
    () => normalizeRules(Array.from({ length: NODE_PATH_RULE_LIMIT + 1 }, (_, i) => ({ from: `/src${i}`, to: '/x' }))),
    /最多/,
  );
});

test('a rule needs an absolute source and target', () => {
  // An empty or relative target would resolve unpredictably on the node, so both
  // ends are required to be absolute, matching the shared node schema.
  assert.throws(() => normalizeRule({ from: '/srv', to: '' }), /目标路径不能为空/);
  assert.throws(() => normalizeRule({ from: '/srv', to: 'relative' }), /目标路径必须是绝对路径/);
  assert.deepEqual(normalizeRule({ from: '/srv', to: '/data' }), { from: '/srv', to: '/data' });
});

test('splitPath and joinPath never silently walk upward with ..', () => {
  assert.deepEqual(splitPath('/a/../b').segments, ['a', '..', 'b']);
  // `..` survives as a segment, so it is part of the rebuilt path and stays visible.
  assert.equal(mapPath('/srv/../etc/passwd', [{ from: '/srv', to: '/data' }]).path, '/data/../etc/passwd');
});

test('Windows volumes and UNC prefixes are recognised', () => {
  assert.equal(isWindowsStyle('C:\\x'), true);
  assert.equal(isWindowsStyle('a\\b'), true);
  assert.equal(isWindowsStyle('/a/b'), false);

  const drive = splitPath('C:\\Users\\data');
  assert.equal(drive.volume, 'C:');
  assert.deepEqual(drive.segments, ['Users', 'data']);
  assert.equal(drive.absolute, true);

  const unc = splitPath('\\\\host\\share\\dir\\file');
  assert.equal(unc.volume, '//host/share');
  assert.deepEqual(unc.segments, ['dir', 'file']);
  assert.equal(unc.absolute, true);

  assert.equal(joinPath('C:', ['a'], '\\'), 'C:\\a');
  assert.equal(joinPath('//host/share', ['a'], '/'), '//host/share/a');
  assert.equal(joinPath('', ['a', 'b'], '/'), '/a/b');
});

test('a drive-relative path is not treated as an absolute mapped root', () => {
  // `C:foo` has a volume but no root; it must not map onto a different machine's C:.
  const rules = [{ from: 'C:\\data', to: 'D:\\mapped' }];
  const result = mapPath('C:data\\x', rules);
  assert.equal(result.mapped, false);
  assert.equal(result.path, 'C:data\\x');
  // Nor may such a path be used as a rule source, where it would be ambiguous.
  assert.throws(() => normalizeRule({ from: 'C:data', to: '/x' }), /必须是绝对路径/);
  assert.equal(splitPath('C:data').absolute, false);
  assert.equal(splitPath('C:\\data').absolute, true);
});
