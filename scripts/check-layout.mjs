// Persistent layout acceptance for the newapi-style console shell.
//
// Every assertion here is a hard assert. This is the guard the earlier
// "44 screenshots but still the old layout" round was missing.
//
// Coverage: all 7 pages x {1440, 768, 390, 360} x {light, dark}, plus the
// collapsed rail, a 1920 centring check, and a genuinely scrolled settings page
// in a deliberately short viewport.
//
// Usage: npm run check:layout   (requires `npm run build` first)
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';

const browserPath = process.env.BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium');
assert.ok(existsSync('web/dist/index.html'), 'Run npm run build first');
assert.ok(existsSync(browserPath), 'Set BROWSER_EXECUTABLE to an installed Chromium browser');

const port = Number(process.env.LAYOUT_PORT || 16405);
const root = await mkdtemp(path.join(os.tmpdir(), 'azurekiln-layout-'));
const sourceRoot = path.join(root, 'sources');
await mkdir(path.join(sourceRoot, 'demo'), { recursive: true });
const screenshotDir = path.resolve('.artifacts/layout');
await mkdir(screenshotDir, { recursive: true });

const pages = [
  { id: 'overview', h1: '备份概览' },
  { id: 'jobs', h1: '备份任务' },
  { id: 'sites', h1: '站点管理' },
  { id: 'runs', h1: '执行记录' },
  { id: 'files', h1: '文件管理' },
  { id: 'storage', h1: '远端存储' },
  { id: 'settings', h1: '系统设置' },
];

const viewports = [
  { name: '1440', width: 1440, height: 900, desktop: true },
  { name: '768', width: 768, height: 1024, desktop: false },
  { name: '390', width: 390, height: 844, desktop: false },
  { name: '360', width: 360, height: 780, desktop: false },
];

// Content that is intentionally allowed to sit outside a .panel in .main-content.
// Anything else — a bare toolbar, a bare table, a bare form block — is unmigrated.
const ALLOWED_OUTSIDE_PANEL = new Set(['HEADER', 'STATS', 'CONTENT-GRID', 'NOTICE', 'LOADING-LINE', 'PAGINATION', 'NAV', 'TABS']);

const probe = (page) => page.evaluate(() => {
  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
  const css = (selector) => { const el = document.querySelector(selector); return el ? getComputedStyle(el) : null; };
  const main = document.querySelector('.main-content');
  const mainRect = rect('.main-content');
  const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

  // Switches/badges/avatars are the only elements allowed a pill radius.
  const pillAllowed = (el) => el.matches('.switch, .status, .count, .tag-chip, .avatar, .segmented, .segmented *');
  const containerSelectors = '.workspace, .panel, .panel-sub, .modal, .modal-dialog, .modal-header, .modal-body, .modal-footer, input, textarea, select, .button, .icon-button, .shell-header, .table-wrap, .tag-input, .property-grid > div, .active-run, .empty-symbol';
  const radiusViolations = [...document.querySelectorAll(containerSelectors)]
    .filter((el) => !pillAllowed(el))
    .map((el) => ({ cls: el.className || el.tagName, v: parseFloat(getComputedStyle(el).borderTopLeftRadius) }))
    .filter(({ v }) => Number.isFinite(v) && v > 8.01)
    .map(({ cls, v }) => `${cls}:${v}px`);

  // Classify each direct child of .main-content. Panels and the explicitly
  // allowed bands are fine; a bare block that still holds a table, toolbar or
  // form is exactly the regression we must catch.
  const classify = (el) => {
    if (el.classList.contains('panel')) return null;
    if (el.classList.contains('stats')) return null;
    if (el.classList.contains('content-grid')) return { tag: el.tagName, cls: el.className, reason: 'grid outside panel', ok: [...el.children].every((c) => c.classList.contains('panel')) };
    // the settings page shell: tab rail + a column whose contents must all be panels
    if (el.classList.contains('settings-layout')) {
      const column = el.querySelector('.settings-column') ?? el.children[1] ?? null;
      const ok = Boolean(column) && [...column.children].every((c) => c.classList.contains('panel') || c.tagName === 'TEMPLATE' || c.classList.contains('notice') || c.classList.contains('loading-line'));
      return { tag: el.tagName, cls: el.className, reason: 'settings column not panelised', ok };
    }
    if (el.classList.contains('notice')) return null;
    if (el.classList.contains('loading-line')) return null;
    if (el.classList.contains('pagination')) return null;
    if (el.tagName === 'HEADER') return null;
    if (el.tagName === 'NAV' || el.tagName === 'TABS') return null;
    if (el.tagName === 'TEMPLATE') return null;
    return { tag: el.tagName, cls: String(el.className || ''), reason: 'rendered outside any panel', ok: false };
  };
  const outsidePanel = [...(main?.children ?? [])].map(classify).filter(Boolean).filter((c) => !c.ok).map((c) => `${c.tag}.${c.cls.replace(/\s+/g, '.')} (${c.reason})`);

  // Any bare table / toolbar / form anywhere in main that is not inside a panel.
  const bareStructures = [...document.querySelectorAll('.main-content table, .main-content .list-toolbar, .main-content .files-toolbar, .main-content .group-toolbar, .main-content .form-grid')]
    .filter((el) => !el.closest('.panel') && !el.closest('.modal'))
    .map((el) => `${el.tagName}.${String(el.className || '').replace(/\s+/g, '.')}`);

  return {
    header: { height: rect('.shell-header')?.height ?? null, width: rect('.shell-header')?.width ?? null, position: css('.shell-header')?.position ?? null, background: css('.shell-header')?.backgroundColor ?? null },
    headerInsideWorkspace: Boolean(document.querySelector('.workspace .shell-header')),
    sidebarWidth: rect('.sidebar')?.width ?? null,
    sidebarTop: rect('.sidebar')?.top ?? null,
    workspace: { left: rect('.workspace')?.left ?? null, top: rect('.workspace')?.top ?? null, right: rect('.workspace')?.right ?? null, radius: css('.workspace')?.borderTopLeftRadius ?? null },
    main: { maxWidth: css('.main-content')?.maxWidth ?? null, padding: css('.main-content') ? [css('.main-content').paddingTop, css('.main-content').paddingRight, css('.main-content').paddingBottom, css('.main-content').paddingLeft].join(' ') : null, left: mainRect?.left ?? null, right: mainRect?.right ?? null, width: mainRect?.width ?? null },
    h1Count: document.querySelectorAll('.main-content h1').length,
    h1Text: main?.querySelector('h1')?.textContent?.trim() ?? null,
    shellContext: document.querySelector('.shell-context')?.textContent?.trim() ?? null,
    panelCount: document.querySelectorAll('.main-content .panel').length,
    panelBodies: document.querySelectorAll('.main-content .panel .panel-body').length,
    // Tables must sit in a panel body; table-wrap inside .panel counts.
    tablesOutsidePanelBody: [...document.querySelectorAll('.main-content table')].filter((t) => !t.closest('.panel') && !t.closest('.modal')).length,
    outsidePanel,
    bareStructures,
    legacyClasses: ['.page-band', '.section-heading', '.metrics', '.overview-columns'].filter((s) => document.querySelector(s)),
    radiusViolations,
    rootFont,
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    // Brand link must keep an accessible name even when the wordmark is hidden.
    brandAriaLabel: document.querySelector('.shell-brand .brand')?.getAttribute('aria-label') ?? null,
    // The overview task list must actually show its primary information: a row
    // that renders only the status chip and the run button is a regression.
    overviewRows: [...document.querySelectorAll('.overview-job')].map((row) => {
      const name = row.querySelector('.job-primary strong');
      const source = row.querySelector('.job-primary span.mono');
      const icon = row.querySelector('.job-symbol');
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0;
      };
      return {
        text: name?.textContent?.trim() ?? null,
        nameVisible: visible(name),
        nameWidth: name ? Math.round(name.getBoundingClientRect().width) : 0,
        sourceVisible: visible(source),
        iconVisible: visible(icon),
        rowWidth: Math.round(row.getBoundingClientRect().width),
      };
    }),
    // Site rows must expose their name, domains and *actual linked task names*
    // at every width/theme; a count hidden in a modal is not enough.
    siteRows: [...document.querySelectorAll('.main-content .site-row')].map((row) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0;
      };
      const name = row.querySelector('.site-name');
      const domains = [...row.querySelectorAll('.site-domain')];
      const jobs = [...row.querySelectorAll('.site-job .site-job-name')];
      return {
        name: name?.textContent?.trim() ?? null,
        nameVisible: visible(name),
        nameWidth: name ? Math.round(name.getBoundingClientRect().width) : 0,
        domains: domains.map((el) => el.textContent.trim()),
        domainsVisible: domains.length > 0 && domains.every(visible),
        jobs: jobs.map((el) => el.textContent.trim()),
        jobsVisible: jobs.length > 0 && jobs.every(visible),
        rowWidth: Math.round(row.getBoundingClientRect().width),
      };
    }),
    navGroupLabels: [...document.querySelectorAll('.nav-label')].map((n) => n.textContent.trim()),
    // Exactly one navigation toggle must be visible at any width.
    visibleNavToggles: [...document.querySelectorAll('.shell-header .sidebar-toggle, .shell-header .mobile-menu')]
      .filter((el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; })
      .map((el) => el.className.split(' ').find((c) => c === 'sidebar-toggle' || c === 'mobile-menu')),
    // The status chip must stay on one line and never be clipped mid-word.
    liveIndicator: (() => {
      const el = document.querySelector('.live-indicator');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 0;
      return { height: r.height, lineHeight, singleLine: !lineHeight || r.height <= lineHeight * 1.8, clipped: el.scrollWidth > el.clientWidth + 1 };
    })(),
    // Brand text must ellipsize, not hard-clip.
    brandText: (() => {
      const el = document.querySelector('.shell-brand .brand strong');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return { hidden: true, ellipsis: getComputedStyle(el).textOverflow };
      return { hidden: false, ellipsis: getComputedStyle(el).textOverflow, overflowX: getComputedStyle(el).overflowX };
    })(),
    // Every visible interactive control must stay inside the viewport, unless it
    // legitimately scrolls inside a horizontal scroller (.table-wrap). `.panel {
    // overflow: hidden }` can hide a toolbar overflow from scrollWidth, so measure
    // the controls themselves - but a table row inside its own scroller is fine.
    controlOverflow: (() => {
      const vw = window.innerWidth;
      return [...document.querySelectorAll('.main-content button, .main-content input, .main-content select, .main-content textarea, .main-content .segmented, .main-content .search-field')]
        .filter((el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; })
        .filter((el) => !el.closest('.table-wrap') && !el.closest('.files-breadcrumbs') && !el.closest('.scroller-x'))
        .map((el) => ({ r: el.getBoundingClientRect(), label: `${el.tagName}.${String(el.className || '').replace(/\s+/g, '.')}` }))
        .filter(({ r }) => r.left < -1 || r.right > vw + 1)
        .map(({ r, label }) => `${label} [${Math.round(r.left)}..${Math.round(r.right)}] vw=${vw}`);
    })(),
    // A horizontal scroller must be able to scroll: the table inside it may be
    // wider than the viewport, but the wrapper itself must fit.
    scrollerOverflow: [...document.querySelectorAll('.main-content .table-wrap, .main-content .files-breadcrumbs')]
      .map((el) => ({ r: el.getBoundingClientRect(), label: String(el.className || '').split(' ')[0] }))
      .filter(({ r }) => r.left < -1 || r.right > window.innerWidth + 1)
      .map(({ r, label }) => `${label} [${Math.round(r.left)}..${Math.round(r.right)}] vw=${window.innerWidth}`),
  };
});

/**
 * The single production site-visibility guard. The page matrix and the negative
 * controls below both call this exact function, so weakening a copy cannot let
 * a blank site page pass.
 */
function assertSiteVisibility(m, where) {
  assert.ok(m.siteRows.length >= 2, `${where}: populated site rows render (${m.siteRows.length})`);
  const populated = m.siteRows.find((row) => row.name === '总部门户');
  assert.ok(populated, `${where}: fixture site is listed by name`);
  assert.equal(populated.nameVisible, true, `${where}: site name is visible`);
  assert.ok(populated.nameWidth > 0, `${where}: site name has width (${populated.nameWidth})`);
  assert.ok(populated.domains.some((domain) => domain.includes('example.com')), `${where}: domain is displayed (${populated.domains.join(', ')})`);
  assert.equal(populated.domainsVisible, true, `${where}: every domain link is visible`);
  assert.ok(populated.jobs.includes('官网备份') && populated.jobs.includes('共享数据库'), `${where}: actual linked task names are displayed (${populated.jobs.join(', ')})`);
  assert.equal(populated.jobsVisible, true, `${where}: every linked task label is visible`);
  const shared = m.siteRows.find((row) => row.name === '共享站点');
  assert.ok(shared && shared.jobs.includes('共享数据库'), `${where}: a shared job appears under both sites`);
  assert.ok(populated.rowWidth > 0, `${where}: site row has layout width`);
}

const statsProbe = (page) => page.evaluate(() => [...document.querySelectorAll('.stat')].map((s) => {
  const c = getComputedStyle(s);
  const r = s.querySelector('svg')?.getBoundingClientRect();
  return { borders: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth], background: c.backgroundColor, padding: c.padding, icon: r ? [r.width, r.height] : null };
}));

let runtime, server, browser, context, page;
let checks = 0;
const overviewRowSummary = { rows: 0, named: 0, combos: 0, texts: new Set() };
try {
  runtime = await createApp({ config: loadConfig({ DATA_DIR: path.join(root, 'state'), SOURCE_ROOTS: sourceRoot, BACKUP_PORT: String(port) }, root) });
  server = await new Promise((resolve) => { const s = runtime.app.listen(port, '127.0.0.1', () => resolve(s)); });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });

  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading', { name: '设置管理员' }).waitFor();
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('layout-check-password');
  await page.getByLabel('确认密码', { exact: true }).fill('layout-check-password');
  await page.getByRole('button', { name: '创建管理员' }).click();
  await page.locator('.main-content h1').waitFor();
  await page.waitForTimeout(600);

  // Populated, isolated site fixture created through the real API so the page
  // matrix renders real name/domain/linked-task labels instead of an empty page.
  // `context.request` shares the browser context cookies, so the UI session
  // authenticates these writes; the shared CSRF token comes from auth status.
  const baseUrl = `http://127.0.0.1:${port}`;
  const readApi = async (route) => {
    const response = await context.request.get(`${baseUrl}/api${route}`);
    assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const writeApi = async (route, body) => {
    const response = await context.request.post(`${baseUrl}/api${route}`, { headers: { 'content-type': 'application/json', 'x-csrf-token': (await readApi('/auth/status')).csrfToken }, data: JSON.stringify(body) });
    assert.ok(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const fixtureJob = (name, folderPath) => ({ name, type: 'directory', sourcePath: folderPath, destinations: [{ remote: 'AB', path: `backups/${name}` }], archive: { format: '7z', encrypted: true, password: 'layout-site-password' } });
  const canonicalRoot = runtime.config.sourceRoots[0];
  const primaryJob = await writeApi('/jobs', fixtureJob('官网备份', path.join(canonicalRoot, 'demo')));
  const sharedJob = await writeApi('/jobs', fixtureJob('共享数据库', path.join(canonicalRoot, 'demo')));
  const primarySite = await writeApi('/sites', { name: '总部门户', domains: ['example.com', 'https://portal.example.com/app'], tags: ['prod', 'web'], backupJobIds: [primaryJob.id, sharedJob.id] });
  await writeApi('/sites', { name: '共享站点', domains: [], tags: ['prod'], backupJobIds: [sharedJob.id] });
  assert.equal(primarySite.name, '总部门户');

  const matrix = { pages: pages.length, viewports: viewports.length, themes: 2, screenshots: 0 };

  for (const theme of ['light', 'dark']) {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // A drawer left open by the previous breakpoint must not leak into this one.
      await page.goto(`http://127.0.0.1:${port}/#overview`);
      await page.locator('.main-content h1').waitFor();
      if (await page.locator('.sidebar.open, .nav-scrim').count()) {
        // The drawer closes by tapping the scrim (no Escape binding exists yet -
        // that is a known improvement, not a tested behaviour).
        await page.mouse.click(vp.width - 12, vp.height - 12);
        await page.waitForTimeout(350);
      }
      for (const target of pages) {
        // Set the theme once per viewport via the toggle, then navigate by hash.
        await page.goto(`http://127.0.0.1:${port}/#${target.id}`);
        await page.locator('.main-content h1').waitFor();
        if (theme === 'dark') {
          const toDark = page.getByRole('button', { name: '深色主题' });
          if (await toDark.count()) { await toDark.click(); await page.waitForTimeout(120); }
        }
        await page.waitForTimeout(220);
        if (target.id === 'sites') await page.locator('.main-content .site-row').first().waitFor();
        const m = await probe(page);
        const where = `${theme}/${vp.name}/${target.id}`;

        assert.equal(m.h1Text, target.h1, `${where}: h1`);
        assert.equal(m.h1Count, 1, `${where}: exactly one h1`);
        assert.equal(m.shellContext, '管理控制台', `${where}: fixed shell context`);
        assert.ok(m.panelCount >= 1, `${where}: at least one panel`);
        assert.deepEqual(m.outsidePanel, [], `${where}: nothing rendered outside a panel`);
        assert.deepEqual(m.bareStructures, [], `${where}: no bare table/toolbar/form`);
        assert.equal(m.tablesOutsidePanelBody, 0, `${where}: every table is inside a panel`);
        assert.deepEqual(m.legacyClasses, [], `${where}: no legacy layout classes`);
        assert.deepEqual(m.radiusViolations, [], `${where}: container radius <= 8px`);
        assert.deepEqual(m.controlOverflow, [], `${where}: no control overflows the viewport`);
        assert.equal(m.docScrollWidth, m.innerWidth, `${where}: no horizontal overflow`);
        assert.equal(m.header.position, 'sticky', `${where}: header sticky`);
        assert.equal(m.headerInsideWorkspace, false, `${where}: header outside .workspace`);
        assert.deepEqual(m.visibleNavToggles, [vp.desktop ? 'sidebar-toggle' : 'mobile-menu'], `${where}: exactly one nav toggle`);
        assert.ok(m.brandAriaLabel && m.brandAriaLabel.trim().length > 0, `${where}: brand link has an accessible name`);
        if (m.liveIndicator) assert.equal(m.liveIndicator.singleLine, true, `${where}: status stays on one line`);
        if (m.liveIndicator && !m.brandText?.hidden) assert.equal(m.liveIndicator.clipped, false, `${where}: status text not clipped`);
        if (m.brandText && !m.brandText.hidden) assert.equal(m.brandText.ellipsis, 'ellipsis', `${where}: brand ellipsizes`);

        if (target.id === 'sites') assertSiteVisibility(m, where);

        if (target.id === 'overview') {
          // The list must exist and must be fully readable at every width/theme:
          // silently skipping when zero rows render would hide a blank overview.
          assert.ok(m.overviewRows.length > 0, `${where}: overview renders task rows`);
          assert.ok(m.overviewRows.some((r) => r.text === '系统配置'), `${where}: built-in 系统配置 row is listed`);
          overviewRowSummary.rows += m.overviewRows.length;
          overviewRowSummary.combos += 1;
          for (const row of m.overviewRows) {
            if (row.nameVisible && row.nameWidth > 0) overviewRowSummary.named += 1;
            if (row.text) overviewRowSummary.texts.add(row.text);
            assert.equal(row.nameVisible, true, `${where}: row "${row.text}" shows its name`);
            assert.ok(row.nameWidth > 0, `${where}: row "${row.text}" name has width (${row.nameWidth})`);
            assert.equal(row.iconVisible, true, `${where}: row "${row.text}" shows its type icon`);
            assert.equal(row.sourceVisible, true, `${where}: row "${row.text}" shows its source`);
          }
        }

        if (vp.desktop) {
          assert.equal(m.header.height, 48, `${where}: header 48px`);
          assert.equal(m.header.width, vp.width, `${where}: header spans viewport`);
          assert.equal(m.sidebarWidth, 208, `${where}: rail 208px`);
          assert.equal(m.sidebarTop, 48, `${where}: rail below header`);
          assert.equal(m.workspace.left, 216, `${where}: workspace left`);
          assert.equal(m.workspace.top, 56, `${where}: workspace top`);
          assert.equal(m.workspace.radius, '8px', `${where}: workspace radius`);
          assert.equal(m.main.maxWidth, '1600px', `${where}: main max-width`);
          assert.equal(m.main.padding, '20px 24px 28px 24px', `${where}: desktop main padding`);
          if (target.id === 'overview') assert.deepEqual(m.navGroupLabels, ['工作区', '监控', '系统'], `${where}: nav groups`);
        } else {
          assert.equal(m.workspace.left, 8, `${where}: no phantom rail gutter`);
          const drawerOff = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
          assert.equal(drawerOff, true, `${where}: drawer off-canvas when closed`);
          if (target.id === 'overview') {
            // Both panels must fill the single-column grid, stacked with the 20px gap.
            const narrowGrid = await page.evaluate(() => {
              const g = document.querySelector('.content-grid');
              if (!g) return null;
              const gr = g.getBoundingClientRect();
              const kids = [...g.children].map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; });
              return { left: gr.left, width: gr.width, gap: parseFloat(getComputedStyle(g).gap), kids };
            });
            assert.ok(narrowGrid, `${where}: content-grid rendered`);
            assert.equal(narrowGrid.kids.length, 2, `${where}: two panels`);
            for (const [i, kid] of narrowGrid.kids.entries()) {
              assert.equal(kid.left, narrowGrid.left, `${where}: panel ${i} starts at grid left`);
              assert.ok(Math.abs(kid.width - narrowGrid.width) <= 1, `${where}: panel ${i} fills the grid width (${kid.width} vs ${narrowGrid.width})`);
            }
            const verticalGap = narrowGrid.kids[1].top - (narrowGrid.kids[0].top + narrowGrid.kids[0].height);
            assert.ok(Math.abs(verticalGap - narrowGrid.gap) <= 1, `${where}: stacked panels keep a ${narrowGrid.gap}px gap (got ${verticalGap})`);
          }
          // Below 620px the status chip is dot-only: no squeezed text.
          if (vp.width <= 620) {
            const liveFont = await page.evaluate(() => { const el = document.querySelector('.live-indicator'); return el ? parseFloat(getComputedStyle(el).fontSize) : null; });
            assert.equal(liveFont, 0, `${where}: status text hidden (font-size 0) on narrow screens`);
          }
        }

        await page.screenshot({ path: path.join(screenshotDir, `${theme}-${vp.name}-${target.id}.png`), fullPage: vp.desktop && theme === 'light' });
        matrix.screenshots += 1;
        checks += 1;
      }

      // Drawer behaviour at the two narrowest breakpoints.
      if (!vp.desktop && (vp.width <= 390)) {
        await page.goto(`http://127.0.0.1:${port}/#jobs`);
        await page.locator('.main-content h1').waitFor();
        await page.waitForTimeout(220);
        await page.locator('.shell-header .mobile-menu').click();
        await page.waitForTimeout(400);
        const open = await page.evaluate(() => {
          const sb = document.querySelector('.sidebar').getBoundingClientRect();
          const scrim = document.querySelector('.nav-scrim');
          return {
            left: sb.left, width: sb.width,
            scrimZ: scrim ? Number(getComputedStyle(scrim).zIndex) : null,
            sidebarZ: Number(getComputedStyle(document.querySelector('.sidebar')).zIndex),
            headerZ: Number(getComputedStyle(document.querySelector('.shell-header')).zIndex),
            scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
          };
        });
        const where = `${theme}/${vp.name}/drawer`;
        assert.equal(open.left, 0, `${where}: drawer slides in`);
        assert.equal(open.width, 272, `${where}: drawer width 272`);
        assert.ok(open.scrimZ > open.headerZ, `${where}: scrim above header`);
        assert.ok(open.sidebarZ > open.scrimZ, `${where}: drawer above scrim`);
        assert.equal(open.scrollWidth, open.innerWidth, `${where}: open drawer causes no overflow`);
        await page.screenshot({ path: path.join(screenshotDir, `${theme}-${vp.name}-drawer-open.png`) });
        matrix.screenshots += 1;
        // Close by a real pointer tap on the scrim (not a synthetic click), so the
        // hit target is actually verified.
        await page.mouse.click(vp.width - 12, vp.height - 12);
        await page.waitForTimeout(400);
        const closedAgain = await page.evaluate(() => ({
          drawerOff: document.querySelector('.sidebar').getBoundingClientRect().right <= 1,
          scrimGone: !document.querySelector('.nav-scrim'),
        }));
        assert.equal(closedAgain.drawerOff, true, `${where}: tapping the scrim closes the drawer`);
        assert.equal(closedAgain.scrimGone, true, `${where}: scrim is removed after closing`);
      }
    }
  }

  // ---- Prove the production site-visibility guard can actually fail ----
  // Each fault hides exactly one field, then runs the *same* assertSiteVisibility
  // guard through assert.throws, so a weakened copy cannot pass silently.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/#sites`);
  await page.locator('.main-content .site-row').first().waitFor();
  await page.waitForTimeout(200);
  const withTemporaryStyle = async (css, check) => {
    const tag = await page.addStyleTag({ content: css });
    try { await check(await probe(page)); } finally { await tag.evaluate((el) => el.remove()); }
  };
  await withTemporaryStyle('.site-name { display: none !important; }', (hidden) => {
    assert.throws(() => assertSiteVisibility(hidden, 'negative/name'), /site name is visible/, 'hiding the site name fails the production guard');
  });
  await withTemporaryStyle('.site-domain { display: none !important; }', (hidden) => {
    assert.throws(() => assertSiteVisibility(hidden, 'negative/domain'), /every domain link is visible/, 'hiding a domain link fails the production guard');
  });
  await withTemporaryStyle('.site-job-name { display: none !important; }', (hidden) => {
    assert.throws(() => assertSiteVisibility(hidden, 'negative/job'), /every linked task label is visible/, 'hiding a linked task label fails the production guard');
  });
  const restored = await probe(page);
  assert.doesNotThrow(() => assertSiteVisibility(restored, 'negative/restored'), 'the production guard passes again once every fault is removed');

  // ---- R4: transparent, borderless stats with the agreed metrics ----
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/#overview`);
  await page.locator('.stats .stat').first().waitFor();
  await page.waitForTimeout(300);

  // ---- content-grid columns share one top edge and keep the 1.6:1 ratio ----
  const grid = await page.evaluate(() => {
    const g = document.querySelector('.content-grid');
    if (!g) return null;
    const gr = g.getBoundingClientRect();
    const kids = [...g.children].map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; });
    return { width: gr.width, left: gr.left, gap: getComputedStyle(g).gap, columns: getComputedStyle(g).gridTemplateColumns, kids };
  });
  assert.equal(grid.kids.length, 2, 'overview content-grid has two panels');
  assert.equal(grid.kids[0].top, grid.kids[1].top, `desktop: content-grid panels align at the top (${grid.kids[0].top} vs ${grid.kids[1].top})`);
  assert.equal(grid.kids[0].left, grid.left, 'desktop: first panel starts at the grid edge');
  assert.ok(Math.abs(grid.kids[0].left + grid.kids[0].width + parseFloat(grid.gap) - grid.kids[1].left) <= 1, 'desktop: content-grid gap is honoured');
  const ratio = grid.kids[0].width / grid.kids[1].width;  assert.ok(Math.abs(ratio - 1.6) < 0.06, `desktop: content-grid columns are 1.6fr : 1fr (got ${ratio.toFixed(3)})`);
  const stats = await statsProbe(page);
  assert.equal(stats.length, 4, 'overview renders four stats');
  stats.forEach((s, i) => {
    assert.deepEqual(s.borders, ['0px', '0px', '0px', '0px'], `stat ${i}: no border on any side`);
    assert.equal(s.background, 'rgba(0, 0, 0, 0)', `stat ${i}: transparent background`);
    assert.equal(s.padding, '18px 20px', `stat ${i}: padding 18px 20px`);
    assert.deepEqual(s.icon, [24, 24], `stat ${i}: 24px icon`);
  });

  // ---- collapsed rail keeps every icon intact ----
  await page.locator('.shell-header .sidebar-toggle').click();
  await page.waitForTimeout(400);
  const collapsed = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar').getBoundingClientRect();
    const icons = [...document.querySelectorAll('.sidebar .main-nav button > svg')];
    return {
      width: sb.width, count: icons.length,
      clipped: icons.filter((svg) => { const r = svg.getBoundingClientRect(); return r.left < sb.left - 0.5 || r.right > sb.right + 0.5 || r.width < 14; }).length,
      workspaceLeft: document.querySelector('.workspace').getBoundingClientRect().left,
    };
  });
  assert.equal(collapsed.width, 44, 'collapsed rail 44px');
  assert.ok(collapsed.count >= 6, 'nav icons rendered when collapsed');
  assert.equal(collapsed.clipped, 0, 'no nav icon clipped when collapsed');
  assert.equal(collapsed.workspaceLeft, 52, 'workspace follows collapsed rail');
  await page.screenshot({ path: path.join(screenshotDir, 'light-1440-collapsed.png') });
  await page.locator('.shell-header .sidebar-toggle').click();
  await page.waitForTimeout(400);

  // ---- 1920: content is centred at 1600 ----
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`http://127.0.0.1:${port}/#overview`);
  await page.locator('.main-content h1').waitFor();
  await page.waitForTimeout(300);
  const wide = await probe(page);
  assert.equal(wide.main.width, 1600, '1920: main is 1600 wide');
  const gutterLeft = wide.main.left - wide.workspace.left;
  const gutterRight = wide.workspace.right - wide.main.right;
  assert.ok(gutterLeft > 0 && gutterRight > 0, `1920: main has gutters (${gutterLeft} / ${gutterRight})`);
  assert.ok(Math.abs(gutterLeft - gutterRight) <= 1, `1920: main is centred (${gutterLeft} vs ${gutterRight})`);
  assert.equal(wide.docScrollWidth, wide.innerWidth, '1920: no horizontal overflow');
  await page.screenshot({ path: path.join(screenshotDir, 'light-1920-overview.png') });

  // ---- genuine long-page scroll in a deliberately short viewport ----
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.goto(`http://127.0.0.1:${port}/#settings`);
  await page.locator('.main-content h1').waitFor();
  await page.waitForTimeout(400);
  const tall = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
  assert.ok(tall.scrollHeight > tall.innerHeight + 100, `settings page is scrollable at 1440x500 (${tall.scrollHeight} vs ${tall.innerHeight})`);
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(200);
  const scrolled = await page.evaluate(() => {
    const header = document.querySelector('.shell-header');
    const box = header.getBoundingClientRect();
    const top = document.elementFromPoint(window.innerWidth / 2, box.top + box.height / 2);
    return {
      scrollY: window.scrollY, top: box.top,
      background: getComputedStyle(header).backgroundColor,
      topmostIsHeader: Boolean(top?.closest('.shell-header')),
    };
  });
  assert.ok(scrolled.scrollY > 0, 'page really scrolled');
  assert.equal(scrolled.top, 0, 'sticky header pinned while scrolled');
  assert.doesNotMatch(scrolled.background, /rgba\(.*,\s*0\)$/, 'sticky header is opaque');
  assert.equal(scrolled.topmostIsHeader, true, 'header paints above scrolled content');
  await page.screenshot({ path: path.join(screenshotDir, 'light-1440x500-settings-scrolled.png') });

  // ---- PRD R3: table headers stick, table-wrap contains inline overscroll ----
  // The empty fixture has no runs, so assert the contract on a page that really
  // renders a table: the files listing always shows the mount root.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/#files`);
  await page.locator('.main-content h1').waitFor();
  await page.waitForTimeout(400);
  const tableRules = await page.evaluate(() => {
    const wrap = document.querySelector('.main-content .table-wrap');
    const th = document.querySelector('.main-content table th');
    return {
      hasWrap: Boolean(wrap),
      overscroll: wrap ? getComputedStyle(wrap).overscrollBehaviorInline : null,
      thPosition: th ? getComputedStyle(th).position : null,
      thTop: th ? getComputedStyle(th).top : null,
    };
  });
  assert.equal(tableRules.hasWrap, true, 'R3: files page renders a table-wrap');
  assert.equal(tableRules.overscroll, 'contain', 'R3: table-wrap contains inline overscroll');

  // A full-width table sitting directly in a panel must be inset by the panel
  // padding, not glued to the panel border; a table inside .panel-body must not
  // get that padding twice.
  const cellInset = await page.evaluate(() => {
    const table = document.querySelector('.main-content .panel table');
    if (!table) return null;
    const panel = table.closest('.panel');
    const th = table.querySelector('thead tr th:first-child');
    if (!panel || !th) return null;
    const panelRect = panel.getBoundingClientRect();
    const thRect = th.getBoundingClientRect();
    return {
      inPanelBody: Boolean(table.closest('.panel-body')),
      gapFromBorder: thRect.left - panelRect.left - 1,
    };
  });
  if (cellInset && !cellInset.inPanelBody) {
    assert.ok(cellInset.gapFromBorder >= 19, `R3: flush table first cell is inset from the panel border (${cellInset.gapFromBorder}px)`);
  }
  if (tableRules.thPosition !== null) {
    assert.equal(tableRules.thPosition, 'sticky', 'R3: table headers stick');
    assert.equal(tableRules.thTop, '0px', 'R3: sticky headers pin to the top');
  } else {
    // No rows loaded: fall back to asserting the rule exists in the stylesheet.
    const rule = await page.evaluate(() => [...document.styleSheets]
      .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .map((r) => r.selectorText === 'th' ? r.style.position : null)
      .filter(Boolean));
    assert.ok(rule.includes('sticky'), 'R3: th has a sticky rule even with an empty table');
  }

  assert.deepEqual(consoleErrors, [], 'no browser console errors');
  // Overview task rows must have been checked in every viewport x theme combination.
  const expectedCombos = viewports.length * 2;
  assert.equal(overviewRowSummary.combos, expectedCombos, `overview rows checked in all ${expectedCombos} viewport/theme combinations (got ${overviewRowSummary.combos})`);
  assert.equal(overviewRowSummary.named, overviewRowSummary.rows, `every overview row render shows a visible name (${overviewRowSummary.named}/${overviewRowSummary.rows})`);
  console.log(`Layout check passed: ${matrix.pages} pages x ${matrix.viewports} viewports x ${matrix.themes} themes (${matrix.screenshots} screenshots, ${checks} page renders asserted).`);
  console.log(`Overview task rows: ${overviewRowSummary.combos}/${expectedCombos} combinations, ${overviewRowSummary.rows} row renders, ${overviewRowSummary.named} with a visible name (${[...overviewRowSummary.texts].join(', ')}).`);
  console.log(`Sites matrix: populated rows checked in ${viewports.length * 2} viewport/theme combinations, including the failing negative control.`);
  console.log(`Screenshots: ${screenshotDir}`);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (runtime) await runtime.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
