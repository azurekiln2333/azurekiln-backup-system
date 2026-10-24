import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newJob } from '../shared/contracts.mjs';
import {
  UNGROUPED_KEY, dirname, groupJobs, readCollapsed, readGroupMode, totalFailed, writeCollapsed, writeGroupMode,
} from '../web/src/jobGroups.ts';

let sequence = 0;
function job(overrides = {}) {
  sequence += 1;
  return {
    ...structuredClone(newJob(overrides.type ?? 'directory')),
    id: `job-${sequence}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Minimal in-memory Storage that records writes so persistence can be asserted. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

test('ungrouped mode keeps every job in a single ordered group', () => {
  const jobs = [job({ name: 'B' }), job({ name: 'A', tags: ['mysql'] }), job({ name: 'C', type: 'system' })];
  const groups = groupJobs(jobs, { mode: 'none' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'all');
  assert.deepEqual(groups[0].jobs.map((item) => item.name), ['B', 'A', 'C'], 'ungrouped mode preserves the server order');
});

test('tag mode buckets by the first tag and isolates untagged jobs last', () => {
  const jobs = [
    job({ name: 'a1', tags: ['mysql', 'prod'] }),
    job({ name: 'b1', tags: ['redis'] }),
    job({ name: 'a2', tags: ['mysql'] }),
    job({ name: 'plain', tags: [] }),
  ];
  const groups = groupJobs(jobs, { mode: 'tag' });
  assert.deepEqual(groups.map((group) => group.label), ['mysql', 'redis', '未分组']);
  assert.equal(groups.at(-1).key, UNGROUPED_KEY);
  assert.deepEqual(groups[0].jobs.map((item) => item.name), ['a1', 'a2']);
});

test('type mode keeps directory, vaultwarden, system order regardless of label sorting', () => {
  const jobs = [job({ name: 'sys', type: 'system' }), job({ name: 'vw', type: 'vaultwarden' }), job({ name: 'dir' })];
  const groups = groupJobs(jobs, { mode: 'type' });
  assert.deepEqual(groups.map((group) => group.label), ['目录备份', 'Vaultwarden', '系统配置']);
});

test('source mode groups directory jobs by their parent folder', () => {
  const jobs = [
    job({ name: 'a', sourcePath: '/sources/mysql/a' }),
    job({ name: 'b', sourcePath: '/sources/mysql/b' }),
    job({ name: 'c', sourcePath: '/sources/crontab_backup/c' }),
    job({ name: 'sys', type: 'system' }),
  ];
  const groups = groupJobs(jobs, { mode: 'source' });
  assert.deepEqual(groups.map((group) => group.label).sort(), ['/sources/crontab_backup', '/sources/mysql', '本系统配置'].sort());
  assert.equal(groups.find((group) => group.label === '/sources/mysql').jobs.length, 2);
  assert.equal(groups.find((group) => group.label === '本系统配置').jobs.length, 1);
});

test('filters and grouping compose: counts follow the filtered set, not the full list', () => {
  const jobs = [
    job({ name: 'enabled-mysql', tags: ['mysql'], enabled: true }),
    job({ name: 'disabled-mysql', tags: ['mysql'], enabled: false }),
    job({ name: 'enabled-redis', tags: ['redis'], enabled: true }),
  ];
  const groups = groupJobs(jobs, { mode: 'tag', match: (item) => item.enabled });
  assert.deepEqual(groups.map((group) => [group.label, group.jobs.length]), [['mysql', 1], ['redis', 1]]);
  assert.equal(groupJobs(jobs, { mode: 'tag', match: () => false }).length, 0);
});

test('failed counts come from the latest run and totalFailed sums them', () => {
  const jobs = [
    job({ name: 'a', tags: ['mysql'], lastRun: { status: 'failed' } }),
    job({ name: 'b', tags: ['mysql'], lastRun: { status: 'succeeded' } }),
    job({ name: 'c', tags: ['mysql'], lastRun: null }),
    job({ name: 'd', tags: ['redis'], lastRun: { status: 'failed' } }),
  ];
  const groups = groupJobs(jobs, { mode: 'tag' });
  assert.equal(groups.find((group) => group.label === 'mysql').failed, 1);
  assert.equal(groups.find((group) => group.label === 'redis').failed, 1);
  assert.equal(totalFailed(groups), 2);
});

test('a 100+ task list never loses or duplicates a job across groups', () => {
  const modes = ['none', 'tag', 'type', 'source'];
  const tags = ['mysql', 'redis', 'postgres', 'mongodb'];
  const jobs = Array.from({ length: 137 }, (_, index) => job({
    name: `task-${index}`,
    tags: index % 5 === 0 ? [] : [tags[index % tags.length]],
    sourcePath: `/sources/mysql/db-${String(index).padStart(3, '0')}`,
    lastRun: index % 11 === 0 ? { status: 'failed' } : { status: 'succeeded' },
  }));
  for (const mode of modes) {
    for (const filter of [() => true, (item) => item.enabled]) {
      const groups = groupJobs(jobs, { mode, match: filter });
      const flat = groups.flatMap((group) => group.jobs);
      assert.equal(flat.length, jobs.filter(filter).length, `${mode} keeps every matching job`);
      assert.equal(new Set(flat.map((item) => item.id)).size, flat.length, `${mode} emits no duplicate rows`);
      assert.equal(totalFailed(groups), flat.filter((item) => item.lastRun?.status === 'failed').length, `${mode} failure counts stay consistent`);
    }
  }
  // Tag mode stays readable with 137 tasks: one group per tag plus the untagged bucket.
  assert.equal(groupJobs(jobs, { mode: 'tag' }).length, tags.length + 1);
});

test('collapse state round-trips per mode and never throws on hostile storage', () => {
  const storage = memoryStorage();
  writeCollapsed(storage, 'tag', ['tag:mysql', 'tag:redis']);
  assert.deepEqual([...readCollapsed(storage, 'tag')].sort(), ['tag:mysql', 'tag:redis']);
  assert.equal(readCollapsed(storage, 'type').size, 0, 'each mode has its own key');
  writeCollapsed(storage, 'tag', ['tag:mysql']);
  assert.deepEqual([...readCollapsed(storage, 'tag')], ['tag:mysql'], 'writes replace the previous set');

  const corrupt = memoryStorage({ 'backup-job-groups:tag': '{not json' });
  assert.equal(readCollapsed(corrupt, 'tag').size, 0);

  const wrongShape = memoryStorage({ 'backup-job-groups:tag': '{"a":1}' });
  assert.equal(readCollapsed(wrongShape, 'tag').size, 0, 'non-array payloads degrade to empty');

  const partiallyInvalid = memoryStorage({ 'backup-job-groups:tag': '["tag:a",5,null]' });
  assert.deepEqual([...readCollapsed(partiallyInvalid, 'tag')], ['tag:a'], 'non-string entries are dropped');

  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readCollapsed(throwing, 'tag').size, 0);
  assert.doesNotThrow(() => writeCollapsed(throwing, 'tag', ['tag:a']));
  assert.doesNotThrow(() => writeCollapsed(undefined, 'tag', ['tag:a']));
  assert.equal(readCollapsed(undefined, 'tag').size, 0, 'missing storage means nothing is collapsed');
  assert.equal(readCollapsed(memoryStorage(), 'none').size, 0, 'ungrouped mode has no collapse state');
});

test('group mode preference falls back to none for missing or unknown values', () => {
  const storage = memoryStorage();
  assert.equal(readGroupMode(storage), 'none');
  writeGroupMode(storage, 'source');
  assert.equal(readGroupMode(storage), 'source');
  assert.equal(readGroupMode(memoryStorage({ 'backup-jobs-group-mode': 'bogus' })), 'none');
  assert.equal(readGroupMode(memoryStorage({ 'backup-jobs-group-mode': 'union' })), 'none');
  assert.equal(readGroupMode(undefined), 'none');
  assert.doesNotThrow(() => writeGroupMode(undefined, 'tag'));
  assert.doesNotThrow(() => writeGroupMode({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 'tag'));
});

test('dirname handles trailing separators, roots and empty values', () => {
  assert.equal(dirname('/sources/mysql/a'), '/sources/mysql');
  assert.equal(dirname('/sources/mysql/a/'), '/sources/mysql');
  assert.equal(dirname('/sources'), '/');
  assert.equal(dirname('relative/folder'), 'relative');
  assert.equal(dirname('single'), '');
  assert.equal(dirname(''), '');
  // Windows drive-root files must keep the root separator: `D:` alone is a
  // drive-relative path, which the source picker rejects as not absolute.
  assert.equal(dirname(String.raw`D:\report.pdf`), 'D:\\', 'a Windows drive-root file keeps the backslash root');
  assert.equal(dirname('D:/report.pdf'), 'D:/', 'a Windows drive-root file keeps the forward-slash root');
  assert.equal(dirname(String.raw`D:\nested\report.pdf`), 'D:\\nested', 'a nested Windows path drops only the file name');
  assert.equal(dirname('/report.pdf'), '/', 'a POSIX root file keeps the leading slash');
});
