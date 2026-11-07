// Focused site deployment-note acceptance against the built UI and real HTTP/SQLite.
// Usage: npm run build, then node scripts/check-site-deployment.mjs
// Optional: BROWSER_EXECUTABLE points to an installed Chromium browser.
// Execution/deployment adapters are inert and record unexpected calls; no live
// registry, Docker service, user state or existing deployment is used.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';

const browserPath = process.env.BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium');
assert.ok(existsSync('web/dist/index.html'), 'Run npm run build first');
assert.ok(existsSync(browserPath), 'Set BROWSER_EXECUTABLE to an installed Chromium browser');
const tempRoot = path.resolve(os.tmpdir());
const root = await mkdtemp(path.join(tempRoot, 'azurekiln-site-deployment-'));
assert.equal(path.dirname(root), tempRoot);
const screenshotDir = path.resolve('.artifacts/site-deployment');
const watchtowerLabel = '该站点通过 Watchtower 自动拉取更新';
const effects = [], externalRequests = [], errors = [], mutations = [], expectedFailures = [], evidence = [];
const originalFetch = globalThis.fetch;
let runtime, store, server, browser;

try {
  await mkdir(screenshotDir, { recursive: true });
  const sourceRoot = path.join(root, 'sources');
  await mkdir(path.join(sourceRoot, 'site'), { recursive: true });
  const envPath = path.join(root, 'deployment.env');
  const composePath = path.join(root, 'docker-compose.yml');
  await writeFile(envPath, 'BACKUP_PORT=16323\n');
  await writeFile(composePath, 'services: {}\n');
  const config = loadConfig({ DATA_DIR: path.join(root, 'state'), SOURCE_ROOTS: sourceRoot, SYSTEM_ENV_FILE: envPath, SYSTEM_COMPOSE_FILE: composePath }, root);
  await writeFile(config.rcloneConfigPath, '[fixture]\ntype = alias\nremote = /fixture\n');
  store = createStore(config);
  const job = store.saveJob({ name: 'Site deployment fixture', sourcePath: path.join(sourceRoot, 'site'), enabled: true, destinations: [{ remote: 'fixture', path: 'backups/site-deployment' }], schedule: { enabled: true, cron: '0 0 * * *' } });
  const run = store.createRun(job);
  store.updateRun(run.id, { status: 'succeeded', finishedAt: new Date().toISOString(), cleanupStatus: 'cleaned', notificationStatus: 'skipped' });
  store.saveWatchBaseline(job.id, job.sourcePath, { 'unchanged.txt': [42, 123] });
  const unexpected = (name) => { effects.push(name); throw new Error(`Unexpected operational action: ${name}`); };
  runtime = await createApp({
    config, store,
    scheduler: { start() {}, stop() {}, refresh() { unexpected('scheduler.refresh'); } },
    watcher: { start() {}, stop() {}, refresh() { unexpected('watcher.refresh'); }, status() { return {}; } },
    rclone: {
      async status() { return { available: true, configured: true, version: 'fixture', configPath: config.rcloneConfigPath }; },
      async listRemotes() { return [{ name: 'fixture', type: 'alias' }]; },
      async importConfig() { unexpected('rclone.importConfig'); },
      async mkdir() { unexpected('rclone.mkdir'); },
      async testConnection() { unexpected('rclone.testConnection'); },
    },
    backupService: {
      isJobActive() { return false; }, enqueue() { unexpected('backup.enqueue'); }, async cancel() { unexpected('backup.cancel'); },
      async shutdown() {}, async getArchives() { return []; },
      async health() { return { rclone: { available: true, version: 'fixture' }, sqlite: { available: true, version: 'native' } }; },
      async storage() { return { tempBytes: 0, retainedBytes: 0, localArchives: [], ...store.getSettings().storage }; },
    },
  });
  server = await new Promise((resolve) => { const listener = runtime.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = origin;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin) { externalRequests.push(url.href); throw new Error('Unexpected outbound request'); }
    return originalFetch(input, options);
  };
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  const setup = await context.request.post(`${origin}/api/auth/setup`, { data: { username: 'admin', password: 'site-deployment-test-password' } });
  assert.equal(setup.status(), 201, await setup.text());
  const statePath = path.join(config.dataDir, 'state.sqlite');
  const otherState = () => {
    const db = new DatabaseSync(statePath, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sites','site_jobs') ORDER BY name").all();
      return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
    } finally { db.close(); }
  };
  const priorState = otherState();
  const deploymentFiles = [envPath, composePath, config.rcloneConfigPath];
  const priorFiles = await Promise.all(deploymentFiles.map((file) => readFile(file)));
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource:.*\b503\b/.test(message.text()) && expectedFailures.some(({ url }) => message.location().url === url)) return;
    errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !(response.status() === 503 && expectedFailures.some(({ url }) => response.url() === url))) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  const dialog = () => page.getByRole('dialog');
  const images = () => dialog().getByRole('textbox', { name: /^云端镜像 \d+$/ });
  const checkbox = () => dialog().getByRole('checkbox', { name: watchtowerLabel, exact: true });
  const image = (index) => dialog().getByRole('textbox', { name: `云端镜像 ${index}`, exact: true });
  const addImage = async (value) => {
    await dialog().getByRole('button', { name: '添加镜像', exact: true }).click();
    await images().last().fill(value);
  };
  const open = async (id) => {
    await page.locator(`[data-site-id="${id}"]`).getByRole('button', { name: '编辑站点', exact: true }).click();
    await dialog().waitFor();
  };
  const save = async (id) => {
    const endpoint = `${origin}/api/sites${id ? `/${id}` : ''}`;
    const refreshed = page.waitForResponse((entry) => entry.url() === `${origin}/api/sites` && entry.request().method() === 'GET');
    const response = page.waitForResponse((entry) => entry.url() === endpoint && entry.request().method() === (id ? 'PATCH' : 'POST'));
    await dialog().getByRole('button', { name: id ? '保存站点' : '创建站点', exact: true }).click();
    const result = await response;
    assert.equal(result.status(), id ? 200 : 201, await result.text());
    const site = await result.json();
    await (await refreshed).finished();
    await dialog().waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('.sites-panel .group-summary')?.textContent.includes('正在刷新'));
    await page.locator(`[data-site-id="${site.id}"]`).waitFor();
    return site;
  };
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.goto(`${origin}/#sites`);
      await page.evaluate((value) => localStorage.setItem('backup-theme', value), theme);
      await page.reload();
      await page.getByRole('heading', { name: '站点管理', exact: true }).waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      await page.getByRole('button', { name: '新增站点', exact: true }).first().click();
      assert.equal(await images().count(), 0);
      assert.equal(await checkbox().isChecked(), false);
      const name = `Deployment ${viewport.width} ${theme}`;
      await dialog().getByRole('textbox', { name: '站点名称', exact: true }).fill(name);
      await dialog().getByRole('textbox', { name: '站点备注', exact: true }).fill('Deployment note draft');
      const first = 'ghcr.io/Owner/App:Release';
      const digest = `registry.example.invalid/team/worker@sha256:${'a'.repeat(64)}`;
      await addImage(`  ${first}  `);
      await addImage('registry.example.invalid/remove:me');
      await addImage(digest);
      await dialog().getByRole('button', { name: '删除镜像 2', exact: true }).click();
      assert.equal(await image(2).inputValue(), digest, 'removing an image row retains its successor');
      await addImage(first);
      assert.equal(await image(1).getAttribute('maxlength'), '1024');
      await dialog().getByRole('checkbox', { name: /Site deployment fixture/ }).check();
      const writesBeforeToggle = mutations.length;
      await checkbox().check();
      assert.equal(mutations.length, writesBeforeToggle, 'the checkbox changes only the local editor draft');
      assert.match(await dialog().locator('#site-watchtower-hint').textContent(), /仅记录.*不会配置 Watchtower/);

      await image(1).fill('registry/app:bad tag');
      await dialog().getByRole('button', { name: '创建站点', exact: true }).click();
      await dialog().getByRole('alert').waitFor();
      assert.match(await dialog().getByRole('alert').textContent(), /空白/);
      assert.equal(mutations.length, writesBeforeToggle, 'shared validation rejects an invalid image without an HTTP write');
      assert.equal(await image(1).inputValue(), 'registry/app:bad tag');
      assert.equal(await checkbox().isChecked(), true, 'a validation failure retains the checkbox draft');
      await image(1).fill(`  ${first}  `);

      const failure = { url: `${origin}/api/sites`, hits: 0 };
      expectedFailures.push(failure);
      const rejectSave = async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        failure.hits += 1;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FIXTURE_SAVE_FAILURE', message: 'Injected site save failure' } }) });
      };
      await page.route(failure.url, rejectSave);
      const failedResponse = page.waitForResponse((entry) => entry.url() === failure.url && entry.status() === 503);
      await dialog().getByRole('button', { name: '创建站点', exact: true }).click();
      await failedResponse;
      await dialog().getByRole('button', { name: '创建站点', exact: true }).waitFor();
      await dialog().getByRole('alert').waitFor();
      assert.equal(failure.hits, 1);
      assert.equal(await image(1).inputValue(), `  ${first}  `, 'a failed save retains the exact unsaved image text');
      assert.equal(await images().count(), 3, 'a failed save retains all draft rows');
      assert.equal(await checkbox().isChecked(), true);
      assert.equal(await dialog().getByRole('textbox', { name: '站点名称', exact: true }).inputValue(), name);
      assert.equal(await dialog().getByRole('textbox', { name: '站点备注', exact: true }).inputValue(), 'Deployment note draft');
      await page.unroute(failure.url, rejectSave);
      const saved = await save();
      assert.deepEqual(saved.cloudImages, [first, digest]);
      assert.equal(saved.watchtowerAutoUpdate, true);
      assert.deepEqual(saved.backupJobIds, [job.id]);
      await open(saved.id);
      assert.equal(await images().count(), 2);
      assert.equal(await image(1).inputValue(), first);
      assert.equal(await image(2).inputValue(), digest);
      assert.equal(await checkbox().isChecked(), true, 'saved deployment notes reopen from the authoritative response');
      await checkbox().scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const layout = await dialog().evaluate((element) => {
        const modal = element.getBoundingClientRect();
        const footer = element.querySelector('.modal-footer').getBoundingClientRect();
        return {
          documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
          modalFits: modal.left >= 0 && modal.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1,
          footerFits: footer.top >= 0 && footer.bottom <= innerHeight,
          controlsFit: [...element.querySelectorAll('input, textarea, button')].every((control) => { const rect = control.getBoundingClientRect(); return rect.width > 0 && rect.left >= modal.left && rect.right <= modal.right + 1; }),
        };
      });
      for (const [guard, passed] of Object.entries(layout)) assert.equal(passed, true, `${viewport.width}/${theme}: ${guard}`);
      const screenshot = `site-deployment-${viewport.width}-${theme}.png`;
      await page.screenshot({ path: path.join(screenshotDir, screenshot) });

      await checkbox().uncheck();
      const unchecked = await save(saved.id);
      assert.equal(unchecked.watchtowerAutoUpdate, false);
      assert.deepEqual(unchecked.cloudImages, saved.cloudImages, 'a checkbox-only save preserves the image list');
      await open(saved.id);
      assert.equal(await checkbox().isChecked(), false);
      while (await images().count()) await dialog().getByRole('button', { name: '删除镜像 1', exact: true }).click();
      const cleared = await save(saved.id);
      assert.deepEqual(cleared.cloudImages, []);
      assert.equal(cleared.watchtowerAutoUpdate, false);
      assert.deepEqual(cleared.backupJobIds, [job.id]);
      await open(saved.id);
      assert.equal(await images().count(), 0, 'cleared images remain empty after reopening');
      assert.equal(await checkbox().isChecked(), false);
      await dialog().getByRole('button', { name: '取消', exact: true }).click();
      evidence.push({ viewport, theme, screenshot, savedSiteId: saved.id, validationDraft: 'passed', failedSaveDraft: 'passed', clearAndReopen: 'passed', layout });
    }
  }
  assert.deepEqual(effects, [], 'the note never refreshes execution adapters or starts a backup');
  assert.deepEqual(externalRequests, [], 'no browser or backend registry requests occur');
  assert.deepEqual(otherState(), priorState, 'all non-site database tables, jobs, schedules, watcher baselines and history stay byte-for-byte unchanged');
  assert.deepEqual(await Promise.all(deploymentFiles.map((file) => readFile(file))), priorFiles, 'deployment and rclone files are unchanged');
  assert.equal(mutations.length, evidence.length * 4, 'each scenario only attempts one failed create and three ordinary site saves');
  for (const mutation of mutations) assert.match(`${mutation.method} ${mutation.path}`, /^(?:POST \/api\/sites|PATCH \/api\/sites\/[^/]+)$/);
  assert.deepEqual(errors, [], 'no unexpected browser or HTTP errors');
  await writeFile(path.join(screenshotDir, 'results.json'), `${JSON.stringify({ evidence, mutations, operationalActions: effects, externalRequests }, null, 2)}\n`);
  console.log(`Site deployment checks passed: ${evidence.length} viewport/theme cases; screenshots and evidence in ${screenshotDir}`);
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close();
  await runtime?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  store?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
