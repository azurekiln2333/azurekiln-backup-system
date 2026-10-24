import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';

const toolRoot = path.resolve('.artifacts/tools');
const rcloneFolder = existsSync(toolRoot) && readdirSync(toolRoot).find(name => name.startsWith('rclone-') && !name.endsWith('.zip'));
const rcloneBinary = process.env.RCLONE_BINARY || (rcloneFolder ? path.join(toolRoot, rcloneFolder, 'rclone.exe') : 'rclone');
const sevenZipBinary = process.env.SEVEN_ZIP_BINARY || (existsSync(path.join(toolRoot, '7zip/x64/7za.exe')) ? path.join(toolRoot, '7zip/x64/7za.exe') : '7zz');
const browserPath = process.env.BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium');
assert.ok(existsSync('web/dist/index.html'), 'Run npm run build first');
assert.ok(existsSync(browserPath), 'Set BROWSER_EXECUTABLE to an installed Chromium browser');

const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-browser-'));
const screenshotDir = path.resolve('.artifacts/screenshots');
await mkdir(screenshotDir, { recursive: true });
const sourceRoot = path.join(root, 'sources');
const sourceA = path.join(sourceRoot, 'directory-a');
const vaultDir = path.join(sourceRoot, 'vaultwarden');
const pagedDir = path.join(sourceRoot, 'many-files');
const retryDir = path.join(sourceRoot, 'temporarily-missing');
const emptyDir = path.join(sourceRoot, 'empty-directory');
const remoteA = path.join(root, 'remote-a');
const remoteB = path.join(root, 'remote-b');
const databasesDir = path.join(sourceRoot, 'databases');
for (const directory of [sourceA, vaultDir, pagedDir, retryDir, emptyDir, remoteA, remoteB]) await mkdir(directory, { recursive: true });
for (const name of ['azurekiln_cn', 'bbs_azurekiln_cn', 'blog_azurekiln_cn']) await mkdir(path.join(databasesDir, name), { recursive: true });
await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(path.join(pagedDir, `file-${String(index).padStart(3, '0')}.txt`), 'pagination fixture')));
await mkdir(path.join(remoteA, 'backups'));
await writeFile(path.join(sourceA, 'important.txt'), 'Browser backup integration contents');
await writeFile(path.join(sourceA, 'skip.log'), 'Excluded contents');
await mkdir(path.join(vaultDir, 'attachments'));
await writeFile(path.join(vaultDir, 'attachments/document.txt'), 'Vaultwarden attachment');
const live = new DatabaseSync(path.join(vaultDir, 'db.sqlite3'));
live.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('live WAL record');");
const sourceConfig = path.join(root, 'rclone.conf');
await writeFile(sourceConfig, `[AB]\ntype = alias\nremote = ${remoteA}\n\n[BC]\ntype = alias\nremote = ${remoteB}\n`);

const messages = [];
const sockets = new Set();
const smtp = net.createServer(socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.write('220 fixture.local ESMTP\r\n');
  let buffer = '', data = false, message = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data) {
        if (line === '.') { data = false; messages.push(message); message = ''; socket.write('250 accepted\r\n'); }
        else message += `${line}\n`;
      } else if (/^EHLO|^HELO/.test(line)) socket.write('250-fixture.local\r\n250 8BITMIME\r\n');
      else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
      else if (line === 'QUIT') socket.end('221 goodbye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve));
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const config = loadConfig({ DATA_DIR: path.join(root, 'state'), SOURCE_ROOTS: sourceRoot, BACKUP_PORT: String(port), RCLONE_BINARY: rcloneBinary, SEVEN_ZIP_BINARY: sevenZipBinary }, root);
let runtime, server, browser, page;
const errors = [];
const httpErrors = [];
const evidence = [];
let expectedSourceMissing = false;
// Count of active intentional HTTP-failure injections. Their resource errors are
// asserted through the UI, so they must not also count as unexpected console errors.
let expectedHttpErrors = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function poll(action, predicate, description, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await action();
    if (predicate(result)) return result;
    await pause(200);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  runtime = await createApp({ config });
  server = await new Promise(resolve => { const listener = runtime.app.listen(port, '127.0.0.1', () => resolve(listener)); });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  context.setDefaultTimeout(10000);
  page = await context.newPage();
  await page.clock.install();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // The missing-directory regression deliberately produces one HTTP 404.
    if (expectedSourceMissing && /^Failed to load resource:.*\b404\b/.test(message.text())) return;
    if (expectedHttpErrors > 0 && /^Failed to load resource:.*\b(4\d\d|5\d\d)\b/.test(message.text())) return;
    errors.push(message.text());
  });
  page.on('response', response => { if (response.status() >= 400) httpErrors.push(response.text().then(body => ({ url: response.url(), status: response.status(), body }))); });
  const api = async route => {
    const response = await context.request.get(`${config.publicUrl}/api${route}`);
    assert.ok(response.ok(), `${route}: ${await response.text()}`);
    return response.json();
  };
  const navigate = async id => {
    await page.goto(`${config.publicUrl}/#${id}`);
    await page.locator('.main-content h1').waitFor();
  };
  const dialog = () => page.getByRole('dialog').last();
  const closeDialog = async () => { await dialog().getByRole('button', { name: '关闭', exact: true }).first().click(); };
  const screenshot = async name => {
    await page.evaluate(() => document.fonts.ready);
    await pause(350);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: page overflow`);
    // Persistent layout contract: the shell geometry, a single page title, no
    // legacy layout classes, and container radii within the 8px scale.
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.shell-header');
      const workspace = document.querySelector('.workspace');
      const pill = (el) => el.matches('.switch, .status, .count, .tag-chip, .avatar, .segmented, .segmented *');
      return {
        h1Count: document.querySelectorAll('.main-content h1').length,
        shellContext: document.querySelector('.shell-context')?.textContent?.trim() ?? null,
        headerHeight: Math.round(header?.getBoundingClientRect().height ?? 0),
        headerPosition: header ? getComputedStyle(header).position : null,
        workspaceRadius: parseFloat(workspace ? getComputedStyle(workspace).borderTopLeftRadius : '0'),
        legacy: ['.page-band', '.section-heading', '.metrics', '.overview-columns'].filter((s) => document.querySelector(s)),
        bigRadius: [...document.querySelectorAll('.workspace, .panel, .modal, .modal-header, .modal-body, .modal-footer, input, textarea, select, .button, .icon-button, .table-wrap, .tag-input')]
          .filter((el) => !pill(el))
          .map((el) => ({ cls: String(el.className || el.tagName), v: parseFloat(getComputedStyle(el).borderTopLeftRadius) }))
          .filter(({ v }) => Number.isFinite(v) && v > 8.01)
          .map(({ cls, v }) => `${cls}:${v}px`),
      };
    });
    assert.deepEqual(layout.legacy, [], `${name}: no legacy layout classes`);
    assert.deepEqual(layout.bigRadius, [], `${name}: container radius within the scale`);
    // The auth screens have no app shell yet, so the shell contract only applies afterwards.
    if (layout.headerPosition !== null) {
      assert.equal(layout.h1Count, 1, `${name}: exactly one h1`);
      assert.equal(layout.headerHeight, 48, `${name}: header height 48px`);
      assert.equal(layout.headerPosition, 'sticky', `${name}: header is sticky`);
      assert.ok(layout.workspaceRadius <= 8.01, `${name}: workspace radius <= 8px`);
      assert.equal(layout.shellContext, '管理控制台', `${name}: fixed shell context`);
    }
    const badControls = await page.locator('button:visible, input:visible, select:visible').evaluateAll(elements => elements.filter(element => {
      if (element.closest('.table-wrap, .log-view, .files-breadcrumbs')) return false;
      const box = element.getBoundingClientRect();
      if (element.closest('.sidebar:not(.open)') && box.right <= 0) return false;
      return box.left < -1 || box.right > innerWidth + 1;
    }).map(element => element.textContent || element.getAttribute('aria-label')));
    assert.deepEqual(badControls, [], `${name}: controls outside viewport`);
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
    evidence.push(name);
  };

  await page.goto(config.publicUrl);
  await page.getByRole('heading', { name: '设置管理员' }).waitFor();
  await screenshot('desktop-setup');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-admin-password');
  await page.getByLabel('确认密码', { exact: true }).fill('browser-admin-password');
  await page.getByRole('button', { name: '创建管理员' }).click();
  await page.locator('.main-content h1').waitFor();
  assert.equal((await api('/jobs')).filter(job => job.type !== 'system').length, 0);
  await screenshot('desktop-empty');

  // An explicit visit to the root chooser must beat an older initial response.
  let releaseRoots;
  const rootsGate = new Promise(resolve => { releaseRoots = resolve; });
  let rootsReceived = false;
  let rootsHandled = false;
  const holdInitialRoots = async route => {
    if (rootsReceived) return route.continue();
    rootsReceived = true;
    const response = await route.fetch();
    await rootsGate;
    await route.fulfill({ response });
    rootsHandled = true;
  };
  await page.route('**/api/sources', holdInitialRoots);
  try {
    await navigate('files');
    await poll(() => rootsReceived, received => received, 'initial root request', 10000);
    await page.locator('.files-breadcrumbs').getByRole('button', { name: '挂载目录', exact: true }).click();
    await page.getByRole('button', { name: 'sources', exact: true }).waitFor();
  } finally {
    releaseRoots();
    if (rootsReceived) await poll(() => rootsHandled, handled => handled, 'released root response', 10000);
    await page.unroute('**/api/sources', holdInitialRoots);
  }
  await pause(50);
  assert.equal(await page.locator('.files-location').count(), 0, 'stale initial roots cannot trigger automatic navigation');
  await page.getByRole('button', { name: 'sources', exact: true }).click();
  await page.getByRole('button', { name: 'directory-a', exact: true }).click();
  await page.getByText('important.txt', { exact: true }).waitFor();
  await screenshot('desktop-files');
  await page.locator('.files-actions').getByRole('button', { name: '备份此目录' }).click();
  assert.equal(await dialog().getByRole('textbox', { name: /源目录/ }).inputValue(), sourceA);
  await closeDialog();

  const fileSearch = page.getByRole('textbox', { name: '搜索当前目录' });
  await fileSearch.fill('IMPORTANT');
  await poll(() => page.locator('.files-table tbody tr').count(), count => count === 1, 'case-insensitive file search');
  assert.equal(await page.locator('.files-table tbody tr').innerText().then(text => text.includes('important.txt')), true);
  await fileSearch.fill('no-matching-file');
  await page.getByRole('heading', { name: '没有匹配的文件' }).waitFor();
  await screenshot('desktop-files-empty-search');
  await fileSearch.fill('');
  await page.getByText('skip.log', { exact: true }).waitFor();

  // Freeze the debounce clock so the old response certainly arrives before
  // the newer search request starts, rather than relying on network timing.
  let releaseSearch;
  const searchGate = new Promise(resolve => { releaseSearch = resolve; });
  let searchReceived = false;
  let searchHandled = false;
  const holdSearch = async route => {
    if (new URL(route.request().url()).searchParams.get('search') !== 'IMPORTANT') return route.continue();
    const response = await route.fetch();
    searchReceived = true;
    await searchGate;
    await route.fulfill({ response });
    searchHandled = true;
  };
  await page.route('**/api/sources?*', holdSearch);
  try {
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    await fileSearch.fill('IMPORTANT');
    await page.clock.runFor(250);
    await poll(() => searchReceived, received => received, 'held search response', 10000);
    await fileSearch.fill('skip');
    releaseSearch();
    await poll(() => searchHandled, handled => handled, 'released search response', 10000);
    await pause(50);
    assert.equal(await page.locator('.loading-line').isVisible(), true, 'stale response stays invalid during search debounce');
    assert.equal(await page.locator('.files-table').count(), 0, 'stale search results never appear');
    await page.clock.runFor(250);
    await page.getByText('skip.log', { exact: true }).waitFor();
    assert.equal(await page.locator('.files-table tbody tr').count(), 1);
  } finally {
    releaseSearch();
    await page.clock.resume();
    await page.unroute('**/api/sources?*', holdSearch);
  }
  await fileSearch.fill('');
  await page.getByText('important.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '上一级', exact: true }).click();
  await page.getByRole('button', { name: 'many-files', exact: true }).click();
  await poll(() => page.locator('.files-table tbody tr').count(), count => count === 100, 'file first page');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('file-100.txt', { exact: true }).waitFor();
  assert.equal(await page.locator('.files-table tbody tr').count(), 1);
  await screenshot('desktop-files-pagination');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByText('file-000.txt', { exact: true }).waitFor();
  await fileSearch.fill('FILE-100');
  await page.getByText('file-100.txt', { exact: true }).waitFor();
  assert.equal(await page.locator('.files-table tbody tr').count(), 1, 'search runs before pagination');
  await fileSearch.fill('');
  await page.getByText('file-000.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('file-100.txt', { exact: true }).waitFor();
  await rm(path.join(pagedDir, 'file-100.txt'));
  await page.getByRole('button', { name: '刷新文件列表', exact: true }).click();
  await page.getByText('file-000.txt', { exact: true }).waitFor();
  assert.equal(await page.locator('.files-table tbody tr').count(), 100, 'refresh clamps a removed last page');
  assert.equal(await page.locator('.pagination').count(), 0);

  await page.locator('.files-breadcrumbs').getByRole('button', { name: sourceRoot, exact: true }).click();
  await page.getByRole('button', { name: 'temporarily-missing', exact: true }).waitFor();
  assert.ok(retryDir.startsWith(`${root}${path.sep}`), 'temporary deletion stays in the fixture');
  await rm(retryDir, { recursive: true });
  expectedSourceMissing = true;
  const missingResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('path') === retryDir && response.status() === 404);
  await page.getByRole('button', { name: 'temporarily-missing', exact: true }).click();
  await missingResponse;
  await page.getByRole('heading', { name: '无法读取目录' }).waitFor();
  await screenshot('desktop-files-missing-directory');
  expectedSourceMissing = false;
  await mkdir(retryDir);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('heading', { name: '目录为空' }).waitFor();
  assert.equal(await page.locator('.files-location span').innerText(), retryDir, 'retry opens the failed target');
  await page.getByRole('button', { name: '上一级', exact: true }).click();
  await page.getByRole('button', { name: 'empty-directory', exact: true }).click();
  await page.getByRole('heading', { name: '目录为空' }).waitFor();
  await page.locator('.files-breadcrumbs').getByRole('button', { name: '挂载目录', exact: true }).click();
  await page.getByRole('button', { name: 'sources', exact: true }).click();
  await page.getByRole('button', { name: 'directory-a', exact: true }).waitFor();

  // Hold a real directory response until a newer navigation has completed.
  let releaseListing;
  const listingGate = new Promise(resolve => { releaseListing = resolve; });
  let listingReceived = false;
  let listingHandled = false;
  const sourceRoute = '**/api/sources?*';
  const holdListing = async route => {
    if (new URL(route.request().url()).searchParams.get('path') !== sourceA) return route.continue();
    const response = await route.fetch();
    listingReceived = true;
    await listingGate;
    await route.fulfill({ response });
    listingHandled = true;
  };
  await page.route(sourceRoute, holdListing);
  try {
    await page.getByRole('button', { name: 'directory-a', exact: true }).click();
    await poll(() => listingReceived, received => received, 'delayed source response', 10000);
    await page.locator('.files-breadcrumbs').getByRole('button', { name: '挂载目录', exact: true }).click();
    await page.getByRole('button', { name: 'sources', exact: true }).waitFor();
  } finally {
    releaseListing();
    if (listingReceived) await poll(() => listingHandled, handled => handled, 'released source response', 10000);
    await page.unroute(sourceRoute, holdListing);
  }
  await pause(350);
  assert.equal(await page.locator('.files-location').count(), 0, 'stale response cannot replace mounted roots');
  await page.getByRole('button', { name: 'sources', exact: true }).click();
  await page.getByRole('button', { name: '备份目录 directory-a', exact: true }).click();
  assert.equal(await dialog().getByRole('textbox', { name: /源目录/ }).inputValue(), sourceA);
  await closeDialog();

  const originalRoots = config.sourceRoots;
  try {
    config.sourceRoots = [sourceA, vaultDir];
    await navigate('overview');
    await navigate('files');
    await page.getByRole('button', { name: 'directory-a', exact: true }).waitFor();
    assert.equal(await page.locator('.files-location').count(), 0, 'multiple mounts start at the root chooser');
    assert.equal(await page.locator('.files-table tbody tr').count(), 2);
    await screenshot('desktop-files-multiple-mounts');
    await page.getByRole('button', { name: 'directory-a', exact: true }).click();
    await page.getByText('important.txt', { exact: true }).waitFor();
    await page.getByRole('button', { name: '上一级', exact: true }).click();
    await page.getByRole('button', { name: 'vaultwarden', exact: true }).waitFor();
    assert.equal(await page.locator('.files-location').count(), 0, 'parent at a mount returns to the chooser');
  } finally {
    config.sourceRoots = originalRoots;
  }

  await navigate('storage');
  await poll(() => page.getByRole('button', { name: '导入 rclone 配置', exact: true }).isEnabled(), enabled => enabled, 'rclone detection');
  await page.getByLabel('现有 rclone 配置文件路径').fill(sourceConfig);
  await page.getByRole('button', { name: '导入 rclone 配置', exact: true }).click();
  await page.locator('.remote-item').filter({ hasText: 'AB' }).waitFor();
  assert.deepEqual((await api('/rclone/remotes')).map(remote => remote.name), ['AB', 'BC']);
  await page.locator('.connection-form select').selectOption('AB');
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByRole('status').filter({ hasText: '连接正常' }).waitFor();
  await screenshot('desktop-storage');

  await navigate('settings');
  await page.getByText('正在读取设置…', { exact: true }).waitFor({ state: 'hidden' });
  const smtpSection = page.locator('.settings-form section').filter({ has: page.getByRole('heading', { name: '邮件通知', exact: true }) });
  await smtpSection.getByRole('checkbox').check();
  await page.getByLabel('SMTP 主机').fill('127.0.0.1');
  await page.getByLabel('端口', { exact: true }).fill(String(smtp.address().port));
  await page.getByLabel('传输安全').selectOption('none');
  await page.getByLabel('发件人').fill('backup@example.test');
  await page.getByLabel('收件人').fill('admin@example.test');
  await smtpSection.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  await page.getByRole('button', { name: '发送测试邮件' }).click();
  await page.getByRole('status').filter({ hasText: '测试邮件已发送' }).waitFor();
  assert.equal(messages.length, 1);
  await screenshot('desktop-mail');

  await navigate('jobs');
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await dialog().getByLabel('任务名称', { exact: true }).fill('Directory A');
  await dialog().getByRole('button', { name: '浏览源目录' }).click();
  await dialog().getByRole('button', { name: sourceRoot, exact: true }).click();
  await dialog().getByRole('button', { name: 'directory-a', exact: true }).click();
  await dialog().getByRole('button', { name: '选择此目录' }).click();
  await dialog().getByLabel('排除规则').fill('*.log');
  await dialog().getByRole('button', { name: '目标位置', exact: true }).click();
  await dialog().getByLabel('rclone 远端').selectOption('AB');
  await dialog().getByRole('button', { name: '浏览远端目录' }).click();
  await dialog().getByLabel('当前目录').fill('');
  await dialog().getByRole('button', { name: '刷新目录' }).click();
  await dialog().getByLabel('新目录名称').fill('browser-backups');
  await dialog().getByRole('button', { name: '创建', exact: true }).click();
  await dialog().getByRole('button', { name: 'browser-backups', exact: true }).click();
  await dialog().getByRole('button', { name: '选择此目录' }).click();
  await dialog().getByRole('button', { name: '压缩与保留', exact: true }).click();
  await dialog().getByLabel('AES-256 密码加密').check();
  await dialog().getByLabel('压缩包密码').fill('browser-archive-password');
  await dialog().getByRole('button', { name: '显示密码' }).click();
  assert.equal(await dialog().getByLabel('压缩包密码').getAttribute('type'), 'text');
  await dialog().getByRole('button', { name: '隐藏密码' }).click();
  await screenshot('desktop-encryption');
  await dialog().getByRole('button', { name: '计划与通知', exact: true }).click();
  await dialog().getByLabel('文件变化后自动备份').check();
  await dialog().getByLabel('变化合并时间（秒）').fill('1');
  await screenshot('desktop-file-watch');
  await dialog().getByLabel('定时执行').check();
  await dialog().getByLabel('Cron 表达式').fill('0 3 * * *');
  await dialog().getByLabel('时区').selectOption('Asia/Shanghai');
  await dialog().getByRole('button', { name: '保存任务' }).click();
  await poll(() => api('/jobs'), jobs => jobs.some(job => job.name === 'Directory A'), 'directory job persisted');
  assert.equal((await api('/jobs')).find(job => job.name === 'Directory A').watch.debounceSeconds, 1);
  assert.equal((await api('/overview')).watchStatus[(await api('/jobs')).find(job => job.name === 'Directory A').id].state, 'watching');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const directoryRow = () => page.locator('.jobs-table tbody tr').filter({ hasText: 'Directory A' });
  await directoryRow().waitFor();
  await directoryRow().getByRole('button', { name: '编辑任务' }).click();
  await dialog().getByRole('button', { name: '压缩与保留', exact: true }).click();
  assert.equal(await dialog().getByLabel('压缩包密码').inputValue(), '');
  await dialog().getByRole('button', { name: '保存任务' }).click();
  await poll(() => api('/jobs'), jobs => jobs.find(job => job.name === 'Directory A')?.archive.passwordSet, 'encrypted password retained');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await directoryRow().getByRole('button', { name: '立即备份' }).click();
  await dialog().waitFor();
  const directoryRun = await poll(() => api('/runs'), runs => runs.items[0]?.status === 'succeeded' && runs.items[0]?.notificationStatus === 'sent', 'directory run completed');
  assert.equal(directoryRun.items[0].cleanupStatus, 'cleaned');
  await dialog().getByRole('button', { name: '刷新记录' }).click();
  await screenshot('desktop-execution');
  const downloadPromise = page.waitForEvent('download');
  await dialog().getByRole('link', { name: '下载归档' }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().endsWith('.7z'));
  assert.ok((await readFile(await download.path())).length > 0);
  assert.equal(await download.failure(), null);
  await closeDialog();

  await navigate('settings');
  await page.getByRole('button', { name: '临时文件', exact: true }).click();
  await page.getByLabel('上传成功后的本地归档').selectOption('manual');
  await page.locator('.settings-form section:visible').getByRole('button', { name: '保存设置' }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  assert.equal((await api('/settings')).storage.successCleanupMode, 'manual');
  await navigate('jobs');

  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await dialog().getByLabel('任务名称', { exact: true }).fill('Vaultwarden B');
  await dialog().getByRole('button', { name: 'Vaultwarden', exact: true }).click();
  await dialog().getByLabel('Vaultwarden 数据目录').fill(vaultDir);
  await dialog().getByLabel('数据库类型').selectOption('postgresql');
  assert.equal(await dialog().getByLabel('端口', { exact: true }).inputValue(), '5432');
  await screenshot('desktop-vaultwarden-postgresql');
  await dialog().getByLabel('数据库类型').selectOption('mysql');
  assert.equal(await dialog().getByLabel('端口', { exact: true }).inputValue(), '3306');
  await dialog().getByLabel('数据库类型').selectOption('sqlite');
  await dialog().getByRole('button', { name: '目标位置', exact: true }).click();
  await dialog().getByLabel('rclone 远端').selectOption('BC');
  await dialog().getByLabel('保存目录').fill('browser-vaultwarden');
  await dialog().getByRole('button', { name: '压缩与保留', exact: true }).click();
  await dialog().getByLabel('AES-256 密码加密').check();
  await dialog().getByLabel('压缩格式').selectOption('zip');
  await dialog().getByLabel('压缩包密码').fill('browser-vaultwarden-password');
  await dialog().getByRole('button', { name: '保存任务' }).click();
  const jobs = await poll(() => api('/jobs'), jobs => jobs.some(job => job.name === 'Vaultwarden B'), 'vaultwarden job persisted');
  assert.equal(jobs.find(job => job.name === 'Directory A').destinations[0].remote, 'AB');
  assert.equal(jobs.find(job => job.name === 'Vaultwarden B').destinations[0].remote, 'BC');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const vaultRow = page.locator('.jobs-table tbody tr').filter({ hasText: 'Vaultwarden B' });
  await vaultRow.getByRole('button', { name: '立即备份' }).click();
  await poll(() => api('/runs'), runs => runs.items.length === 2 && runs.items.every(run => run.status === 'succeeded' && run.notificationStatus === 'sent'), 'vaultwarden run completed');
  await closeDialog();
  const retained = await api('/storage');
  assert.equal(retained.localArchives.length, 1);
  assert.ok(retained.retainedBytes > 0);
  await navigate('settings');
  await page.getByRole('button', { name: '临时文件', exact: true }).click();
  await page.locator('.local-archive-row').waitFor();
  await page.locator('.toast-message').waitFor({ state: 'hidden' });
  await screenshot('desktop-temp-storage-retained');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('mobile-temp-storage-retained');
  await page.setViewportSize({ width: 360, height: 800 });
  await screenshot('small-mobile-temp-storage-retained');
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.once('dialog', confirmation => confirmation.accept());
  await page.getByRole('button', { name: /清理本地归档/ }).click();
  await page.locator('.local-archive-row').waitFor({ state: 'hidden' });
  assert.equal((await api('/storage')).tempBytes, 0);
  await page.locator('.toast-message').waitFor({ state: 'hidden' });
  await screenshot('desktop-temp-storage-cleaned');
  await navigate('jobs');
  await screenshot('desktop-jobs');
  await page.locator('.jobs-table tbody tr').filter({ hasText: 'Directory A' }).locator('.job-primary').click();
  await dialog().getByText('监听中 · 整个目录', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: /备份版本/ }).click();
  await dialog().locator('.archive-row').waitFor();
  await screenshot('desktop-archives');
  await closeDialog();

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 768, height: 1024 }]) {
    await page.setViewportSize(viewport);
    await navigate('overview');
    await screenshot(`overview-${viewport.width}`);
    await navigate('jobs');
    await screenshot(`jobs-${viewport.width}`);
    await navigate('files');
    await page.getByRole('button', { name: 'directory-a', exact: true }).click();
    await page.getByText('important.txt', { exact: true }).waitFor();
    await screenshot(`files-${viewport.width}`);
    await navigate('jobs');
    await page.locator('.jobs-table tbody tr').filter({ hasText: 'Directory A' }).getByRole('button', { name: '编辑任务' }).click();
    await dialog().getByRole('button', { name: '计划与通知', exact: true }).click();
    await screenshot(`watch-editor-${viewport.width}`);
    await closeDialog();
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await dialog().getByRole('button', { name: 'Vaultwarden', exact: true }).click();
    await dialog().getByLabel('数据库类型').selectOption('mysql');
    await screenshot(`editor-${viewport.width}`);
    await closeDialog();
    await navigate('settings');
    await page.getByRole('button', { name: '授权登录', exact: true }).click();
    await screenshot(`oidc-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigate('runs');
  await page.getByLabel('按状态筛选').selectOption('succeeded');
  await page.getByText('2 条记录', { exact: true }).waitFor();
  await page.getByRole('button', { name: '深色主题' }).click();
  await screenshot('desktop-dark-history');
  await navigate('files');
  await page.getByRole('button', { name: 'directory-a', exact: true }).click();
  await page.getByText('important.txt', { exact: true }).waitFor();
  await screenshot('desktop-dark-files');
  await page.getByRole('button', { name: '账号菜单 admin' }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('heading', { name: '管理员登录' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('mobile-login-dark');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-admin-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.main-content h1').waitFor();
  await page.getByRole('button', { name: '打开导航' }).click();
  await screenshot('mobile-navigation');
  await page.getByRole('button', { name: '备份概览', exact: true }).click();
  await screenshot('mobile-overview-dark');
  await poll(() => runtime.backupService.storage(), storage => storage.tempBytes === 0, 'downloads and successful staging cleaned');
  await writeFile(path.join(sourceA, 'watched-change.txt'), 'File watch backup integration contents');
  const watched = await poll(() => api('/runs'), runs => runs.items.length === 3 && runs.items[0].trigger === 'watch' && runs.items[0].status === 'succeeded' && runs.items[0].notificationStatus === 'sent', 'file change created a verified backup');
  assert.equal(watched.items[0].targets[0].status, 'verified');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigate('jobs');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await dialog().getByLabel('批量添加：为父目录下的每个子目录各建一个任务').check();
  await dialog().getByLabel('任务名称模板').fill('MySQL · {folder}');
  await dialog().getByLabel('添加标签').fill('mysql');
  await dialog().getByLabel('添加标签').press('Enter');
  await dialog().getByRole('button', { name: '浏览源目录' }).click();
  await dialog().getByRole('button', { name: sourceRoot, exact: true }).click();
  await dialog().getByRole('button', { name: 'databases', exact: true }).click();
  await dialog().getByRole('button', { name: '选择此目录' }).click();
  await dialog().getByLabel('bbs_azurekiln_cn', { exact: true }).uncheck();
  await dialog().getByRole('button', { name: '目标位置', exact: true }).click();
  await dialog().getByLabel('rclone 远端').selectOption('AB');
  await dialog().getByLabel('保存目录').fill('mysql-backups');
  await dialog().getByText('AB:mysql-backups/azurekiln_cn').waitFor();
  await dialog().getByRole('button', { name: '基本信息', exact: true }).click();
  await screenshot('desktop-batch-editor');
  await dialog().getByRole('button', { name: '创建 2 个任务' }).click();
  const batchJobs = await poll(() => api('/jobs'), items => items.filter(job => job.tags?.includes('mysql')).length === 2, 'batch jobs persisted');
  assert.deepEqual(batchJobs.filter(job => job.tags.includes('mysql')).map(job => [job.name, job.destinations[0].path]).sort(), [['MySQL · azurekiln_cn', 'mysql-backups/azurekiln_cn'], ['MySQL · blog_azurekiln_cn', 'mysql-backups/blog_azurekiln_cn']]);
  await page.getByRole('status').filter({ hasText: '已创建 2 个任务' }).waitFor();
  await page.getByLabel('按标签筛选').selectOption('mysql');
  assert.equal(await page.locator('.jobs-table tbody tr').count(), 2);
  await screenshot('desktop-jobs-tag-filter');
  await page.locator('.jobs-table tbody tr').first().getByRole('button', { name: 'mysql', exact: true }).click();
  assert.ok(await page.locator('.jobs-table tbody tr').count() > 2, 'clicking the active tag clears the filter');

  // ---- Site inventory: real CRUD, many-to-many links, filtering and reverse detail ----
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigate('sites');
  await page.getByRole('heading', { name: '尚无站点' }).waitFor();
  await screenshot('desktop-sites-empty');

  const directoryA = (await api('/jobs')).find(job => job.name === 'Directory A');
  assert.ok(directoryA, 'the isolated Directory A task exists for the site fixture');
  const directoryATags = [...directoryA.tags];

  // Create a site through the real editor: name, two addresses, a tag and a linked task.
  await page.getByRole('button', { name: '新增站点', exact: true }).first().click();
  await dialog().getByLabel('站点名称', { exact: true }).fill('官网');
  await dialog().getByRole('button', { name: '添加地址' }).click();
  await dialog().getByLabel('访问地址 1').fill('example.com');
  await dialog().getByRole('button', { name: '添加地址' }).click();
  await dialog().getByLabel('访问地址 2').fill('https://portal.example.com/app');
  const siteTagInput = dialog().getByLabel('添加站点标签');
  await siteTagInput.fill('prod');
  await siteTagInput.press('Enter');
  await dialog().locator('.site-job-option').filter({ hasText: 'Directory A' }).getByRole('checkbox').check();
  await screenshot('desktop-site-editor');
  await dialog().getByRole('button', { name: '创建站点' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  let sites = await poll(() => api('/sites'), list => list.some(site => site.name === '官网'), 'site persisted');
  const siteOne = sites.find(site => site.name === '官网');
  assert.deepEqual(siteOne.backupJobIds, [directoryA.id], 'the saved site links the selected task');
  assert.deepEqual(siteOne.tags, ['prod'], 'site tags saved independently');
  assert.equal(siteOne.domains.length, 2, 'both addresses saved');
  const jobAfterSiteSave = (await api('/jobs')).find(job => job.id === directoryA.id);
  assert.deepEqual(jobAfterSiteSave.tags, directoryATags, 'site tags never copy into job tags');

  // The list must show the name, the domain and the actual linked task name at a glance.
  const siteRow = name => page.locator('.site-row').filter({ hasText: name }).first();
  await siteRow('官网').waitFor();
  assert.equal(await siteRow('官网').locator('.site-name').innerText(), '官网');
  assert.ok((await siteRow('官网').locator('.site-domain').allInnerTexts()).some(text => text.includes('example.com')), 'domain is visible in the row');
  assert.ok((await siteRow('官网').locator('.site-job-name').allInnerTexts()).includes('Directory A'), 'linked task name is visible in the row');
  await screenshot('desktop-sites');

  // A second site shares the same task (many-to-many, no ownership transfer).
  await page.getByRole('button', { name: '新增站点', exact: true }).first().click();
  await dialog().getByLabel('站点名称', { exact: true }).fill('共享站点');
  await dialog().locator('.site-job-option').filter({ hasText: 'Directory A' }).getByRole('checkbox').check();
  await dialog().getByRole('button', { name: '创建站点' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  sites = await poll(() => api('/sites'), list => list.filter(site => site.backupJobIds.includes(directoryA.id)).length === 2, 'shared task linked to two sites');

  // A failed GET /sites must show an explicit error + retry, never an empty-success list.
  expectedHttpErrors += 1;
  await page.route('**/api/sites', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '模拟读取失败' } }) });
  });
  await page.reload();
  await page.locator('.main-content h1').waitFor();
  const siteError = page.getByRole('alert').filter({ hasText: '模拟读取失败' });
  await siteError.waitFor();
  assert.equal(await page.getByRole('heading', { name: '尚无站点' }).count(), 0, 'a failed load never renders the empty-success state');
  assert.equal(await page.locator('.site-row').count(), 0, 'no stale rows pretend the failed load succeeded');
  await screenshot('desktop-sites-error');
  await page.unroute('**/api/sites');
  await siteError.getByRole('button', { name: '重新读取' }).click();
  await siteRow('官网').waitFor();
  assert.ok(await page.locator('.site-row').count() >= 2, 'retry recovers the authoritative site list');
  expectedHttpErrors -= 1;

  // Reverse mapping: the task detail shows every site currently linked to it.
  await navigate('jobs');
  await page.locator('.jobs-table tbody tr').filter({ hasText: 'Directory A' }).locator('.job-primary').click();
  await dialog().getByText('关联站点', { exact: true }).waitFor();
  const siteChips = new Set(await dialog().locator('.site-links .tag-chip').allInnerTexts());
  assert.deepEqual(siteChips, new Set(['官网', '共享站点']), 'job detail lists both linked sites');
  await screenshot('desktop-job-site-links');
  // Clicking a reverse site chip must navigate to the sites page and open that site's editor.
  await dialog().locator('.site-links .tag-chip').filter({ hasText: '官网' }).click();
  await page.getByRole('heading', { name: '编辑站点 · 官网' }).waitFor();
  assert.equal(new URL(page.url()).hash, '#sites', 'a reverse site chip navigates to the sites page');
  await screenshot('desktop-site-reverse-chip');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  // Forward mapping: clicking a linked task from the site row opens its detail.
  await siteRow('官网').locator('.site-job').filter({ hasText: 'Directory A' }).click();
  await dialog().getByText('关联站点', { exact: true }).waitFor();
  await closeDialog();

  // Search, no-match state and tag filtering run on authoritative data.
  const siteSearch = page.getByRole('textbox', { name: '搜索站点' });
  await siteSearch.fill('portal.example.com');
  await poll(() => page.locator('.site-row').count(), count => count === 1, 'domain search filters to one site');
  await siteSearch.fill('no-such-site');
  await page.getByRole('heading', { name: '没有匹配的站点' }).waitFor();
  await screenshot('desktop-sites-no-match');
  await siteSearch.fill('');
  await page.getByLabel('按站点标签筛选').selectOption('prod');
  await poll(() => page.locator('.site-row').count(), count => count === 1, 'tag filter shows only the tagged site');
  await page.getByLabel('按站点标签筛选').selectOption('');

  // A background polling refresh must not replace an open editor's unsaved draft.
  let siteGets = 0;
  const countSiteGets = request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/sites') siteGets += 1; };
  page.on('request', countSiteGets);
  await page.getByRole('button', { name: '新增站点', exact: true }).first().click();
  await dialog().getByLabel('站点名称', { exact: true }).fill('轮询草稿');
  await dialog().getByRole('button', { name: '添加地址' }).click();
  await dialog().getByLabel('访问地址 1').fill('draft.example.com');
  const beforePoll = siteGets;
  await poll(() => siteGets, count => count > beforePoll, 'background /sites poll', 15000);
  assert.equal(await dialog().getByLabel('站点名称', { exact: true }).inputValue(), '轮询草稿', 'polling refresh keeps the typed name');
  assert.equal(await dialog().getByLabel('访问地址 1').inputValue(), 'draft.example.com', 'polling refresh keeps the typed address');
  page.off('request', countSiteGets);
  await dialog().getByRole('button', { name: '取消' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  // A failed save keeps the entered values instead of wiping the draft.
  expectedHttpErrors += 1;
  await page.route('**/api/sites', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '模拟保存失败' } }) });
  });
  await page.getByRole('button', { name: '新增站点', exact: true }).first().click();
  await dialog().getByLabel('站点名称', { exact: true }).fill('保存失败站点');
  await dialog().getByRole('button', { name: '创建站点' }).click();
  await dialog().getByRole('alert').waitFor();
  assert.equal(await dialog().getByLabel('站点名称', { exact: true }).inputValue(), '保存失败站点', 'failed save preserves the entered name');
  await screenshot('desktop-site-save-failure');
  expectedHttpErrors -= 1;
  await page.unroute('**/api/sites');
  await dialog().getByRole('button', { name: '取消' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  // N1 regression: a failed /overview must never turn the site inventory into a
  // false empty state. Sites load independently of the overview/task fetches.
  const failOverview = url => url.pathname === '/api/overview';
  const failOverviewHandler = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '模拟概览失败' } }) });
  expectedHttpErrors += 1;
  await page.route(failOverview, failOverviewHandler);
  await page.reload();
  await page.locator('.main-content h1').waitFor();
  await siteRow('官网').waitFor();
  assert.ok(await page.locator('.site-row').count() >= 2, 'saved sites load even though the initial /overview request failed');
  assert.equal(await page.getByRole('heading', { name: '尚无站点' }).count(), 0, 'a failed /overview never renders the empty-success site state');
  assert.equal(await page.getByText('正在读取站点…').count(), 0, 'the site list leaves its loading line after a failed /overview');
  await screenshot('desktop-sites-overview-failure');
  // A manual refresh while /overview still fails must keep the already-loaded rows.
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await pause(400);
  await siteRow('官网').waitFor();
  assert.equal(await page.getByRole('heading', { name: '尚无站点' }).count(), 0, 'a failed refresh never replaces loaded sites with an empty state');
  await page.unroute(failOverview, failOverviewHandler);
  expectedHttpErrors -= 1;

  // N3 regression: /jobs fails while /sites succeeds. Existing associations must be
  // reported as pending (not 0, not deleted), and the editor must not silently drop them.
  const failJobs = url => url.pathname === '/api/jobs';
  const failJobsHandler = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '模拟任务失败' } }) });
  expectedHttpErrors += 1;
  await page.route(failJobs, failJobsHandler);
  await page.reload();
  await page.locator('.main-content h1').waitFor();
  await siteRow('官网').waitFor();
  assert.ok((await siteRow('官网').locator('.site-meta').innerText()).includes('1 个关联任务'), 'an unloadable task list never drops the stored link count to 0');
  const pendingLink = siteRow('官网').locator('.site-job.pending');
  await pendingLink.waitFor();
  assert.ok((await pendingLink.innerText()).includes('任务信息待加载'), 'the unresolved association is reported as pending, not missing');
  assert.equal(await siteRow('官网').getByText('未关联备份任务').count(), 0, 'a stored association is never shown as unlinked');
  assert.equal(await page.getByText('已被删除').count(), 0, 'an unknown association is never reported as deleted');
  await screenshot('desktop-sites-jobs-unavailable');
  // Opening the editor with an unloadable task list must keep the draft's link.
  await siteRow('官网').getByRole('button', { name: '编辑站点' }).click();
  await page.getByRole('heading', { name: '编辑站点 · 官网' }).waitFor();
  assert.equal(await dialog().getByText('已被删除').count(), 0, 'the editor does not claim an unresolved link was deleted');
  assert.ok((await dialog().innerText()).includes('任务列表尚未成功加载'), 'the editor reports the task list as unavailable');
  assert.ok((await dialog().innerText()).includes('已选 1 个'), 'the editor keeps the unresolved link selected in its draft');
  // Attempt a save: whatever the editor chooses, it must never silently clear the link.
  let siteWrite = null;
  const sitesRoute = url => url.pathname.startsWith('/api/sites');
  const sitesWriteHandler = route => { const request = route.request(); if (request.method() !== 'GET') siteWrite = request.postData(); return route.continue(); };
  await page.route(sitesRoute, sitesWriteHandler);
  await dialog().getByRole('button', { name: '保存站点' }).click();
  await pause(600);
  assert.ok(siteWrite === null || siteWrite.includes(directoryA.id), 'saving never silently drops an unresolved association');
  assert.ok((await api('/sites')).find(site => site.name === '官网').backupJobIds.includes(directoryA.id), 'the unresolved association survives an attempted save');
  if (await dialog().isVisible()) { await dialog().getByRole('button', { name: '取消' }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); }
  await page.unroute(sitesRoute, sitesWriteHandler);
  // Retrying: once /jobs recovers the real task name replaces the pending marker.
  await page.unroute(failJobs, failJobsHandler);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await siteRow('官网').locator('.site-job-name').filter({ hasText: 'Directory A' }).waitFor();
  assert.equal(await page.getByText('任务信息待加载').count(), 0, 'a successful task reload replaces the pending indicator');
  expectedHttpErrors -= 1;

  // Unbinding one site keeps the task and the other site's link; deleting a site
  // keeps the task, its credentials and the other site's links.
  await siteRow('官网').getByRole('button', { name: '编辑站点' }).click();
  await dialog().locator('.site-job-option').filter({ hasText: 'Directory A' }).getByRole('checkbox').uncheck();
  await dialog().getByRole('button', { name: '保存站点' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await poll(() => api('/sites'), list => list.find(site => site.name === '官网')?.backupJobIds.length === 0, 'site unlinked');
  assert.ok((await api('/jobs')).some(job => job.id === directoryA.id), 'unlinking never deletes the job');
  assert.deepEqual((await api('/sites')).find(site => site.name === '共享站点').backupJobIds, [directoryA.id], "unlinking one site preserves another site's link");

  await siteRow('共享站点').getByRole('button', { name: '删除站点' }).click();
  await dialog().getByRole('button', { name: '删除站点' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  sites = await poll(() => api('/sites'), list => !list.some(site => site.name === '共享站点'), 'site deleted');
  assert.ok((await api('/jobs')).some(job => job.id === directoryA.id), 'deleting a site never deletes its linked job');
  assert.equal((await api('/jobs')).find(job => job.id === directoryA.id).archive.passwordSet, true, 'job credentials survive site deletion');

  // The remaining site and its data persist across a full reload.
  await page.reload();
  await page.locator('.main-content h1').waitFor();
  await siteRow('官网').waitFor();
  assert.equal(await page.locator('.site-row').count(), 1, 'sites persist across a reload');
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 768, height: 1024 }]) {
    await page.setViewportSize(viewport);
    await navigate('sites');
    await siteRow('官网').waitFor();
    await screenshot(`sites-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  assert.deepEqual(errors, [], 'Browser errors');
  await writeFile(path.join(screenshotDir, 'verification.json'), JSON.stringify({ screenshots: evidence, browserErrors: errors, backups: 3, mailMessages: messages.length, checkedAt: new Date().toISOString() }, null, 2));
  console.log(`Browser check passed: ${evidence.length} screenshots, 3 real encrypted backups including a watched change, download, SMTP, login, responsive layouts. Artifacts: ${screenshotDir}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(screenshotDir, 'failure.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(-8000));
  }
  console.error('Browser errors:', errors);
  console.error('HTTP errors:', await Promise.all(httpErrors));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (runtime) await runtime.close();
  live.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => smtp.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
