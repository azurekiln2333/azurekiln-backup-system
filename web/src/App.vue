<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Activity, Archive as ArchiveIcon, ArrowRight, Check, CheckCircle2, ChevronRight, CircleAlert, Clock3, Copy,
  Database, Download, FileArchive, Folder, Globe, HardDrive, KeyRound, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Play,
  Plus, RefreshCw, Settings2, ShieldCheck, Sun, Trash2, Pencil, X,
} from 'lucide-vue-next';
import { api, ApiError, errorMessage, setCsrfToken, uploadArchive, write } from './api';
import { friendlyError, rawError } from './errors';
import { bytes, dateTime, duration, phaseLabels, progress, shortTime, statusLabels } from './format';
import { isPage, navSections, pageTitle, type Page } from './nav';
import type { Archive, AuthStatus, Job, Overview, Run, Site, SiteInput, ToolStatus } from './types';
import AccountMenu from './components/AccountMenu.vue';
import JobEditor from './components/JobEditor.vue';
import JobsView from './components/JobsView.vue';
import FileManagerView from './components/FileManagerView.vue';
import Modal from './components/Modal.vue';
import RunDetail from './components/RunDetail.vue';
import SettingsView from './components/SettingsView.vue';
import StorageView from './components/StorageView.vue';
import SiteRow from './components/SiteRow.vue';
import SitesView from './components/SitesView.vue';
import SiteEditor from './components/SiteEditor.vue';

/** Hash router: the registry is the only place a page is declared. */
function currentPage(): Page { const hash = window.location.hash.slice(1); return isPage(hash) ? hash : 'overview'; }
const page = ref<Page>(currentPage());
const title = computed(() => pageTitle(page.value));
const SIDEBAR_KEY = 'backup-sidebar-collapsed';
function readCollapsed() { try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; } }
const collapsed = ref(readCollapsed());
const mobileNav = ref(false);
const theme = ref(localStorage.getItem('backup-theme') ?? 'light');
const auth = ref<AuthStatus>();
const authLoading = ref(true);
const authBusy = ref(false);
const authError = ref(new URLSearchParams(location.search).get('error') ?? '');
const username = ref('admin');
const password = ref('');
const confirmPassword = ref('');
const setupToken = ref('');
const error = ref('');
const refreshing = ref(false);
const loaded = ref(false);
/** Set when the newest /overview read failed while last-good data is still shown. */
const overviewStale = ref(false);
const overview = ref<Overview>();
const jobs = ref<Job[]>([]);
/**
 * True only after the most recent /jobs read succeeded. Site views use this so
 * an unattempted or failed task list is never shown as "no tasks"/"deleted".
 */
const jobsLoaded = ref(false);
/** True only while the current /jobs read is in flight; loading is never inferred from `!jobsLoaded`. */
const jobsLoading = ref(false);
/** Localized message of the newest failed /jobs read; the last good list is retained. */
const jobsError = ref('');
const sites = ref<Site[]>([]);
const sitesLoading = ref(false);
const sitesLoaded = ref(false);
const sitesError = ref('');
/** Raw low-level text for tooltips only; user-facing copy goes through friendlyError. */
const sitesErrorDetail = ref('');
const editingSite = ref<Site>();
const siteEditorOpen = ref(false);
const deletingSite = ref<Site>();
const siteBusyId = ref('');
let sitesRequest = 0;
const runs = ref<Run[]>([]);
const runsTotal = ref(0);
const runsPage = ref(0);
const runFilter = ref('');
const runStatusFilter = ref('');
const editing = ref(false);
const editJob = ref<Job>();
const initialType = ref<'directory' | 'file' | 'vaultwarden' | 'newapi'>('directory');
const initialSourcePath = ref('');
const selectedJob = ref<Job>();
const jobDetailTab = ref('summary');
const archives = ref<Archive[]>([]);
const archivesLoading = ref(false);
const archiveError = ref('');
const selectedRun = ref('');
const deleting = ref<Job>();
const systemImportOpen = ref(false);
const systemImportFile = ref<File>();
const systemImportPassword = ref('');
const systemImportBusy = ref(false);
const systemImportError = ref('');
const systemImportDone = ref('');
const busyId = ref('');
const toast = ref('');
let toastTimer: number;
let pollTimer: number;
let runsRequest = 0;
let jobsRequest = 0;
const filteredRuns = computed(() => runs.value);
const recentRuns = computed(() => overview.value?.recentRuns.slice(0, 6) ?? []);
/**
 * Active runs come from the successful overview payload, which is authoritative
 * about the task list. `/jobs` is only a fallback for the first paint, and a
 * failed or never-completed /jobs read must never look like an idle queue.
 */
const activeRuns = computed(() => (overview.value?.jobs ?? (jobsLoaded.value ? jobs.value : [])).flatMap(job => job.lastRun && ['queued', 'running'].includes(job.lastRun.status)
  ? [{ ...job.lastRun, jobId: job.id, jobName: job.name, type: job.type }] : []));
/**
 * True only while the current page's own first read is still in flight.
 * Sites and tasks load independently, so their data renders immediately instead
 * of waiting behind /overview (which may fail or be slow).
 */
/**
 * True while /overview is genuinely still being read. A failed read leaves
 * `loaded` false forever, so "pending" must key off the in-flight refresh and
 * the absence of an error, never off `loaded`.
 */
const overviewPending = computed(() => !overview.value && refreshing.value && !error.value);
const dataPending = computed(() => {
  if (error.value) return false;
  if (page.value === 'overview') return !overview.value && !sitesLoaded.value && !jobsLoaded.value;
  // Loading is tied to an in-flight read, never to a failed one: a failed poll keeps
  // the last good list on screen instead of hiding it behind an endless loading line.
  if (page.value === 'jobs') return jobsLoading.value && !jobs.value.length;
  if (page.value === 'runs') return !loaded.value && !runs.value.length;
  return false;
});
const tools = computed(() => {
  const value = overview.value?.tools ?? {};
  const labels: Record<string, string> = { rclone: 'rclone', sevenZip: '7-Zip', tar: 'tar', sqlite: 'SQLite', pgDump: 'PostgreSQL', mysqlDump: 'MariaDB' };
  return (Array.isArray(value) ? value.map((tool, index) => [tool.name ?? String(index), tool] as const) : Object.entries(value))
    .map(([key, tool]) => ({ key, label: labels[key] ?? key, ...(typeof tool === 'boolean' ? { available: tool } : tool as ToolStatus) }));
});
const sourcePath = (job: Job) => job.type === 'system' ? '本系统配置' : job.type === 'vaultwarden' ? job.vaultwarden.dataDir : job.type === 'newapi' ? job.newapi.dataDir : job.sourcePath;
const typeLabel = (type: Job['type']) => type === 'system' ? '系统配置' : type === 'file' ? '单文件备份' : type === 'vaultwarden' ? 'Vaultwarden' : type === 'newapi' ? 'NewAPI' : '目录备份';
const selectedJobSites = computed(() => selectedJob.value ? sites.value.filter(site => site.backupJobIds.includes(selectedJob.value!.id)) : []);
const activeJob = (id: string) => activeRuns.value.some(run => run.jobId === id);
const canRunJob = (job: Job) => job.type !== 'system' || (job.destinations.length > 0 && Boolean(job.archive.passwordSet));
function liveProgress(run: Pick<Run, 'phase' | 'progress'>) {
  if (run.phase !== 'preparing' && run.phase !== 'archiving') return '';
  const percent = progress(run);
  if (percent !== null) return `${Math.floor(percent)}%`;
  const value = run.progress;
  return run.phase === 'archiving' && value && typeof value === 'object' && value.bytes !== undefined ? `已写入 ${bytes(value.bytes)}` : '';
}
const availableTargets = (archive: Archive) => (archive.targets ?? []).filter(target => target.status === 'verified' && !('prunedAt' in target && target.prunedAt));

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 4500);
}
function navigate(id: string) { page.value = id as Page; window.location.hash = id; mobileNav.value = false; }
function hashChange() { page.value = currentPage(); }
function toggleCollapsed() { collapsed.value = !collapsed.value; }
watch(collapsed, value => { try { localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0'); } catch { /* private mode: ignore */ } });
function toggleTheme() { theme.value = theme.value === 'dark' ? 'light' : 'dark'; }
watch(theme, value => { document.documentElement.dataset.theme = value; localStorage.setItem('backup-theme', value); }, { immediate: true });
async function refreshAuth() {
  auth.value = await api<AuthStatus>('/auth/status'); setCsrfToken(auth.value.csrfToken);
  // Authentication unlocks the shell independently of slower dashboard resources.
  if (auth.value.authenticated) void refresh();
}
async function settingsSaved() {
  try { await refreshAuth(); }
  catch (cause) { error.value = errorMessage(cause); }
}
async function init() {
  authLoading.value = true;
  try { await refreshAuth(); }
  catch (cause) { authError.value = errorMessage(cause); }
  finally { authLoading.value = false; }
}
async function authenticate() {
  authError.value = '';
  if (!auth.value?.initialized && password.value !== confirmPassword.value) { authError.value = '两次输入的密码不一致'; return; }
  authBusy.value = true;
  try {
    await write(auth.value?.initialized ? '/auth/login' : '/auth/setup', { username: username.value, password: password.value, ...(!auth.value?.initialized ? { setupToken: setupToken.value } : {}) });
    password.value = ''; confirmPassword.value = ''; setupToken.value = ''; await refreshAuth();
  } catch (cause) { authError.value = errorMessage(cause); }
  finally { authBusy.value = false; }
}
async function logout() {
  try { await write('/auth/logout'); auth.value = await api('/auth/status'); setCsrfToken(''); jobs.value = []; jobsLoaded.value = false; jobsRequest += 1; jobsLoading.value = false; jobsError.value = ''; runs.value = []; overview.value = undefined; loaded.value = false; overviewStale.value = false; selectedJob.value = undefined; selectedRun.value = ''; sitesRequest += 1; sites.value = []; sitesLoaded.value = false; sitesLoading.value = false; sitesError.value = ''; sitesErrorDetail.value = ''; editingSite.value = undefined; siteEditorOpen.value = false; deletingSite.value = undefined; }
  catch (cause) { error.value = errorMessage(cause); }
}
async function loadRuns() {
  const request = ++runsRequest;
  const data = await api<{ items: Run[]; total: number }>(`/runs?limit=30&offset=${runsPage.value * 30}${runFilter.value ? `&jobId=${encodeURIComponent(runFilter.value)}` : ''}${runStatusFilter.value ? `&status=${encodeURIComponent(runStatusFilter.value)}` : ''}`);
  if (request === runsRequest) { runs.value = data.items; runsTotal.value = data.total; }
}
/**
 * Site inventory has its own loading/error state so a site failure never
 * discards valid jobs/overview data. Stale responses are dropped and a mounted
 * editor's draft is never replaced or closed by a background refresh.
 */
async function loadSites(foreground = false): Promise<boolean> {
  const request = ++sitesRequest;
  if (foreground || !sitesLoaded.value) sitesLoading.value = true;
  if (foreground) { sitesError.value = ''; sitesErrorDetail.value = ''; }
  try {
    const list = await api<Site[]>('/sites');
    // Superseded by a newer request: that request owns the outcome.
    if (request !== sitesRequest) return true;
    sites.value = list;
    sitesError.value = '';
    sitesErrorDetail.value = '';
    sitesLoaded.value = true;
    // Only a delete confirmation is closed when its site disappears; an open
    // editor keeps its unsaved draft and surfaces the missing site itself.
    if (deletingSite.value && !list.some(site => site.id === deletingSite.value?.id)) deletingSite.value = undefined;
    return true;
  } catch (cause) {
    if (request !== sitesRequest) return true;
    sitesError.value = friendlyError(cause, '无法读取站点，请稍后重试');
    sitesErrorDetail.value = rawError(cause);
    return false;
  } finally {
    if (request === sitesRequest) sitesLoading.value = false;
  }
}
async function refresh(silent = false) {
  if (refreshing.value) return;
  refreshing.value = true;
  // Site inventory and the task list load independently: a failure in one must
  // never hide the other, and never leave the page looking genuinely empty.
  const sitesPromise = loadSites();
  const jobsPromise = loadJobs(silent);
  let failed = false;
  try {
    const [summary] = await Promise.all([api<Overview>('/overview'), loadRuns()]);
    overview.value = summary; loaded.value = true; overviewStale.value = false;
  } catch (cause) {
    failed = true;
    // A silent poll failure keeps the last-good overview, so it must be flagged:
    // stale metrics must never be presented as a fresh reading.
    overviewStale.value = true;
    if (!handleUnauthorized(cause) && !silent) error.value = errorMessage(cause);
  }
  try {
    // Wait for the independent loads before releasing the guard, so a slow
    // /jobs read cannot overlap the next poll/foreground refresh.
    const [jobsOk, sitesOk] = await Promise.all([jobsPromise, sitesPromise]);
    if (!jobsOk || !sitesOk) failed = true;
    // Only a fully clean refresh clears the notice: a /jobs failure raised by
    // loadJobs must not be erased by an unrelated /overview success above.
    if (!failed) error.value = '';
  } finally {
    refreshing.value = false;
  }
}
/** A 401 clears the session once, whoever noticed it. */
function handleUnauthorized(cause: unknown) {
  if (!(cause instanceof ApiError && cause.status === 401)) return false;
  auth.value = { initialized: true, authenticated: false, user: null, oidcEnabled: auth.value?.oidcEnabled ?? false, setupTokenRequired: false };
  setCsrfToken('');
  jobsLoaded.value = false;
  return true;
}
/**
 * Task list with its own loading/error state. `jobs` keeps the last good list,
 * `jobsLoaded` records whether the newest read succeeded, and `jobsLoading` is
 * true only while a read is in flight, so a failed poll never looks like loading.
 * A superseded response is dropped rather than overwriting the newer outcome.
 */
async function loadJobs(silent = false): Promise<boolean> {
  const request = ++jobsRequest;
  jobsLoading.value = true;
  try {
    const list = await api<Job[]>('/jobs');
    // Superseded by a newer read: that read owns the outcome.
    if (request !== jobsRequest) return true;
    jobs.value = list;
    jobsLoaded.value = true;
    jobsError.value = '';
    jobsLoading.value = false;
    if (selectedJob.value) selectedJob.value = list.find(job => job.id === selectedJob.value?.id);
    return true;
  } catch (cause) {
    if (request !== jobsRequest) return true;
    jobsLoaded.value = false;
    // Retain the last good list, but keep the failure visible: a failed read must
    // never be presented as a loading state, an idle queue or an empty task list.
    const unauthorized = handleUnauthorized(cause);
    if (!unauthorized) jobsError.value = errorMessage(cause);
    jobsLoading.value = false;
    if (unauthorized) return false;
    if (!handleUnauthorized(cause) && !silent) error.value = errorMessage(cause);
    return false;
  }
}
watch([runFilter, runStatusFilter], () => { runsPage.value = 0; if (auth.value?.authenticated) void loadRuns().catch(cause => { error.value = errorMessage(cause); }); });
watch(runsPage, () => { if (auth.value?.authenticated) void loadRuns().catch(cause => { error.value = errorMessage(cause); }); });
function createJob(type: 'directory' | 'file' | 'vaultwarden' | 'newapi' = 'directory', source = '') { editJob.value = undefined; initialType.value = type; initialSourcePath.value = source; editing.value = true; }
function edit(job: Job) { editJob.value = job; initialSourcePath.value = ''; editing.value = true; }
async function batchSaved(created: Job[]) { editing.value = false; editJob.value = undefined; notify(`已创建 ${created.length} 个任务`); await refresh(); }
async function saved(job: Job) { editing.value = false; editJob.value = undefined; notify('任务已保存'); await refresh(); if (selectedJob.value?.id === job.id) selectedJob.value = job; }
async function runJob(job: Job) {
  busyId.value = job.id;
  try { const run = await write<Run>(`/jobs/${job.id}/run`); selectedRun.value = run.id; await refresh(); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { busyId.value = ''; }
}
async function toggleJob(job: Job) {
  busyId.value = job.id;
  try { await write(`/jobs/${job.id}`, { enabled: !job.enabled }, 'PATCH'); await refresh(); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { busyId.value = ''; }
}
async function toggleWatch(job: Job) {
  busyId.value = job.id;
  try {
    const enabled = !job.watch?.enabled;
    await write(`/jobs/${job.id}`, { watch: { enabled } }, 'PATCH');
    notify(enabled ? `已开启「${job.name}」的文件监听` : `已关闭「${job.name}」的文件监听`);
    await refresh();
  } catch (cause) { error.value = errorMessage(cause); }
  finally { busyId.value = ''; }
}
/**
 * Clone an ordinary task server-side.
 *
 * The copy is paused, so it opens in the editor instead of being run; jobs and
 * site links are refreshed first so the new task already exists behind the
 * dialog. The system task is never offered/cloned, and a failed request leaves
 * no phantom row because the refresh only happens on success.
 */
async function cloneJob(job: Job) {
  if (busyId.value) return;
  busyId.value = job.id;
  try {
    const created = await write<Job>(`/jobs/${job.id}/clone`, {});
    notify(`已复制为「${created.name}」，默认暂停`);
    await refresh();
    editJob.value = created;
    initialSourcePath.value = '';
    editing.value = true;
  } catch (cause) {
    error.value = cause instanceof ApiError && cause.code === 'SYSTEM_JOB_CLONE_FORBIDDEN'
      ? '系统配置任务不能复制。'
      : errorMessage(cause);
  } finally { busyId.value = ''; }
}
function watchLabel(job: Job) {
  if (job.type !== 'directory' || !job.watch?.enabled) return '';
  const status = overview.value?.watchStatus?.[job.id];
  const mode = job.watch.mode === 'incremental' ? '增量' : '整目录';
  if (!job.enabled) return `${mode} · 任务已暂停`;
  if (!status) return mode;
  return `${mode} · ${status.state === 'error' ? '监听错误' : status.capturing ? '建立基线' : status.pending ? '等待备份' : '监听中'}`;
}
async function deleteJob() {
  if (!deleting.value) return;
  busyId.value = deleting.value.id;
  try { await write(`/jobs/${deleting.value.id}`, undefined, 'DELETE'); if (selectedJob.value?.id === deleting.value.id) selectedJob.value = undefined; deleting.value = undefined; notify('任务已删除'); await refresh(); await loadSites(true); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { busyId.value = ''; }
}
function createSite() { editingSite.value = undefined; siteEditorOpen.value = true; }
function editSite(site: Site) { editingSite.value = site; siteEditorOpen.value = true; }
function closeSiteEditor() { siteEditorOpen.value = false; editingSite.value = undefined; }
/** App owns the site HTTP write; the editor awaits it to keep its draft on failure. */
const saveSite = (id: string | undefined, input: SiteInput) => id ? write<Site>(`/sites/${id}`, input, 'PATCH') : write<Site>('/sites', input);
async function siteSaved(site: Site) {
  closeSiteEditor();
  notify(site.name ? `已保存站点「${site.name}」` : '站点已保存');
  await loadSites(true);
}
async function deleteSite() {
  if (!deletingSite.value) return;
  siteBusyId.value = deletingSite.value.id;
  try {
    await write(`/sites/${deletingSite.value.id}`, undefined, 'DELETE');
    deletingSite.value = undefined;
    notify('站点已删除，备份任务、历史版本和归档保持不变');
    await loadSites(true);
  } catch (cause) { error.value = friendlyError(cause, '删除站点失败，备份任务未受影响'); }
  finally { siteBusyId.value = ''; }
}
/** Reverse navigation: a linked task opens its site in the dedicated page. */
function openSite(site: Site) { selectedJob.value = undefined; navigate('sites'); editSite(site); }
function openSystemImport() {
  systemImportFile.value = undefined;
  systemImportPassword.value = '';
  systemImportError.value = '';
  systemImportDone.value = '';
  systemImportOpen.value = true;
}
function selectSystemImportFile(event: Event) {
  systemImportFile.value = (event.target as HTMLInputElement).files?.[0];
}
async function importSystemConfiguration() {
  systemImportError.value = '';
  if (!systemImportFile.value || !systemImportPassword.value) { systemImportError.value = '请选择归档并输入压缩包密码'; return; }
  systemImportBusy.value = true;
  try {
    const result = await uploadArchive<{ pendingRestart: boolean; hasDeploymentEnv: boolean; hasDeploymentCompose: boolean; environmentKeyMismatch: boolean }>('/system/import', systemImportFile.value, systemImportPassword.value);
    systemImportDone.value = result.environmentKeyMismatch
      ? '归档已暂存。先将对应的 BACKUP_MASTER_KEY 应用到部署环境，再重启服务。'
      : result.hasDeploymentEnv || result.hasDeploymentCompose ? '导入已校验，重启服务后生效。部署文件恢复副本保存在 /data。' : '导入已校验，重启服务后生效。';
    systemImportPassword.value = '';
  } catch (cause) { systemImportError.value = errorMessage(cause); }
  finally { systemImportBusy.value = false; }
}
async function openJob(job: Job) {
  selectedJob.value = job; jobDetailTab.value = 'summary'; archives.value = []; archiveError.value = ''; archivesLoading.value = true;
  try { archives.value = await api(`/jobs/${job.id}/archives`); }
  catch (cause) { archiveError.value = errorMessage(cause); }
  finally { archivesLoading.value = false; }
}
onMounted(() => {
  void init();
  window.addEventListener('hashchange', hashChange);
  pollTimer = window.setInterval(() => { if (auth.value?.authenticated && !document.hidden) void refresh(true); }, 5000);
});
onBeforeUnmount(() => { window.clearInterval(pollTimer); window.clearTimeout(toastTimer); window.removeEventListener('hashchange', hashChange); });
</script>

<template>
  <div v-if="authLoading" class="boot-screen"><img src="/brand.svg" alt="AzureKiln" width="44" height="44" /><span>AzureKiln Backup</span><RefreshCw :size="20" class="spinning" /></div>
  <main v-else-if="!auth?.authenticated" class="auth-screen">
    <button class="icon-button auth-theme" :title="theme === 'dark' ? '浅色主题' : '深色主题'" :aria-label="theme === 'dark' ? '浅色主题' : '深色主题'" @click="toggleTheme"><Sun v-if="theme === 'dark'" :size="20" /><Moon v-else :size="20" /></button>
    <section class="auth-content">
      <div class="auth-brand"><img src="/brand.svg" alt="" width="46" height="46" /><div><strong>AzureKiln Backup</strong><span>备份管理</span></div></div>
      <div class="auth-title"><h1>{{ auth?.initialized ? '管理员登录' : '设置管理员' }}</h1><ShieldCheck :size="23" /></div>
      <form @submit.prevent="authenticate">
        <div v-if="authError" class="notice error" role="alert">{{ authError }}</div>
        <label class="field">用户名<input v-model="username" required autocomplete="username" maxlength="100" /></label>
        <label class="field">密码<input v-model="password" required type="password" :minlength="auth?.initialized ? undefined : 12" :autocomplete="auth?.initialized ? 'current-password' : 'new-password'" :placeholder="auth?.initialized ? '管理员密码' : '至少 12 个字符'" /></label>
        <label v-if="!auth?.initialized" class="field">确认密码<input v-model="confirmPassword" required type="password" minlength="12" autocomplete="new-password" /></label>
        <label v-if="!auth?.initialized && auth?.setupTokenRequired" class="field">初始化令牌<input v-model="setupToken" required type="password" autocomplete="off" /></label>
        <button class="button primary auth-submit" :disabled="authBusy || !auth">{{ authBusy ? '处理中…' : auth?.initialized ? '登录' : '创建管理员' }}<ArrowRight :size="17" /></button>
      </form>
      <template v-if="auth?.oidcEnabled && auth.initialized"><div class="auth-divider"><span>授权登录</span></div><a class="button secondary oidc-button" href="/api/auth/oidc/start"><ShieldCheck :size="19" />AzureKiln OAuth2</a></template>
      <button v-if="!auth" class="button secondary auth-submit" @click="init"><RefreshCw :size="16" />重新连接</button>
    </section>
    <div class="auth-footer">AzureKiln <span>·</span> Backup System</div>
  </main>
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': collapsed }">
    <div v-if="mobileNav" class="nav-scrim" @click="mobileNav = false" />
    <header class="shell-header">
      <div class="shell-brand"><button class="icon-button sidebar-toggle" type="button" :title="collapsed ? '展开导航' : '收起导航'" :aria-label="collapsed ? '展开导航' : '收起导航'" @click="toggleCollapsed"><PanelLeftOpen v-if="collapsed" :size="18" /><PanelLeftClose v-else :size="18" /></button><button class="icon-button mobile-menu" type="button" title="打开导航" aria-label="打开导航" @click="mobileNav = !mobileNav"><Menu :size="20" /></button><a class="brand" href="#overview" aria-label="AzureKiln Backup 首页" @click="navigate('overview')"><img src="/brand.svg" alt="" width="24" height="24" /><strong class="brand-text">AzureKiln Backup</strong></a><span class="shell-context">管理控制台</span></div>
      <div class="topbar-actions"><span class="live-indicator"><i />{{ activeRuns.length ? `${activeRuns.length} 个执行中` : '系统在线' }}</span><button class="icon-button" :title="theme === 'dark' ? '浅色主题' : '深色主题'" :aria-label="theme === 'dark' ? '浅色主题' : '深色主题'" @click="toggleTheme"><Sun v-if="theme === 'dark'" :size="19" /><Moon v-else :size="19" /></button><AccountMenu :username="auth.user?.username" :theme="theme" @toggle-theme="toggleTheme" @logout="logout" /></div>
    </header>
    <aside class="sidebar" :class="{ open: mobileNav, collapsed }">
      <nav class="main-nav" aria-label="主导航"><template v-for="section in navSections" :key="section.label"><div class="nav-group"><div class="nav-label">{{ section.label }}</div><button v-for="item in section.items" :key="item.id" :class="{ active: page === item.id }" :title="collapsed ? item.label : undefined" @click="navigate(item.id)"><component :is="item.icon" :size="16" /><span>{{ item.label }}</span><span v-if="item.badge === 'jobs' && jobs.length" class="nav-count">{{ jobs.length }}</span></button></div></template></nav>
    </aside>
    <div class="workspace">
      <main class="main-content">
        <header class="page-heading"><h1>{{ title }}</h1><div class="heading-actions"><button v-if="['overview','jobs','sites','runs'].includes(page)" class="icon-button bordered" title="刷新" aria-label="刷新" :disabled="refreshing" @click="refresh()"><RefreshCw :size="18" :class="{ spinning: refreshing }" /></button><button v-if="page === 'sites'" class="button primary" @click="createSite()"><Plus :size="17" />新增站点</button><button v-else-if="page === 'overview' || page === 'jobs'" class="button primary" @click="createJob()"><Plus :size="17" />新建任务</button></div></header>
        <div v-if="error" class="notice error" role="alert">{{ error }}<button class="icon-button" title="关闭错误提示" aria-label="关闭错误提示" @click="error = ''"><X :size="16" /></button></div>
        <!-- A failed jobs refresh keeps the last good list; this keeps the failure visible above it. -->
        <div v-if="page === 'jobs' && jobsError && jobs.length && !error" class="notice error" role="alert"><span>{{ jobsError }}</span><button type="button" class="text-button" @click="refresh()"><RefreshCw :size="14" />重新读取</button></div>
        <div v-if="dataPending" class="loading-line">正在读取备份数据…</div>
        <template v-else-if="page === 'overview'">
          <div v-if="overview && overviewStale" class="notice warning" role="status"><span>概览刷新失败，以下指标与运行环境可能仍是上次成功读取的结果。</span><button type="button" class="text-button" @click="refresh()"><RefreshCw :size="14" />重新读取</button></div>
          <section class="stats" aria-label="备份统计"><div class="stat"><div><span>备份任务</span><Folder :size="24" /></div><strong>{{ overview ? overview.totalJobs : '—' }}<small v-if="overview">个</small></strong><p>{{ overview ? `${overview.enabledJobs} 个已启用` : overviewPending ? '正在读取概览…' : '概览数据暂时不可用' }}</p></div><div class="stat"><div><span>正在执行</span><Activity :size="24" /></div><strong>{{ overview ? activeRuns.length : '—' }}<small v-if="overview">个</small></strong><p>{{ overview ? (activeRuns.length ? '备份进行中' : '队列空闲') : overviewPending ? '正在读取概览…' : '概览数据暂时不可用' }}</p></div><div class="stat"><div><span>最近成功</span><CheckCircle2 :size="24" /></div><strong class="date-value">{{ overview && overview.lastSuccessAt ? shortTime(overview.lastSuccessAt) : '—' }}</strong><p>{{ overview ? (overview.lastSuccessAt ? '最近一次成功备份' : '暂无成功记录') : overviewPending ? '正在读取概览…' : '概览数据暂时不可用' }}</p></div><div class="stat"><div><span>临时空间</span><FileArchive :size="24" /></div><strong>{{ overview ? bytes(overview.storage.tempBytes) : '—' }}</strong><p>{{ overview ? (overview.storage.maxTempBytes ? `上限 ${bytes(overview.storage.maxTempBytes)}` : '—') : overviewPending ? '正在读取概览…' : '概览数据暂时不可用' }}</p></div></section>
          <section v-if="activeRuns.length" class="panel"><div class="panel-heading"><h2>当前执行</h2><span class="status running"><i />{{ activeRuns.length }} 个任务</span></div><div class="panel-body flush"><button v-for="run in activeRuns" :key="run.id" class="active-run" @click="selectedRun = run.id"><div class="run-symbol"><RefreshCw :size="20" class="spinning" /></div><div><strong>{{ run.jobName }}</strong><span>{{ phaseLabels[run.phase] || run.phase }}<template v-if="liveProgress(run)"> · {{ liveProgress(run) }}</template></span></div><ChevronRight :size="19" /></button></div></section>
          <div class="content-grid"><section class="panel"><div class="panel-heading"><h2>站点列表 <span class="count">{{ sites.length }}</span></h2><button class="text-button" @click="navigate('sites')">全部站点<ArrowRight :size="15" /></button></div><div v-if="sitesError" class="panel-body"><div class="notice error" role="alert"><span :title="sitesErrorDetail || undefined">{{ sitesError }}</span><button type="button" class="text-button" @click="loadSites(true)">重新读取</button></div></div><div v-if="!sitesLoaded && !sitesError" class="loading-line">正在读取站点…</div><div v-else-if="sitesLoaded && !sites.length && !sitesError" class="empty-state compact"><div class="empty-symbol"><Globe :size="29" /></div><h3>尚无站点</h3><div class="empty-actions"><button class="button secondary" @click="createSite()"><Plus :size="16" />新增站点</button><button class="button secondary" @click="navigate('jobs')"><Folder :size="16" />全部任务</button></div></div><div v-else-if="sites.length" class="site-list overview-site-list"><SiteRow v-for="site in sites.slice(0, 6)" :key="site.id" :site="site" :jobs="jobs" :jobs-loaded="jobsLoaded" :show-actions="false" :filterable="false" @open-job="openJob" /></div></section><section class="panel"><div class="panel-heading"><h2>运行环境</h2><button class="text-button" @click="navigate('storage')">存储<ArrowRight :size="15" /></button></div><div class="panel-body"><div v-if="!overview && overviewPending" class="muted">正在读取运行环境…</div><div v-else-if="!overview" class="muted">运行环境暂时不可用，稍后会自动重试。</div><div v-for="tool in tools" :key="tool.key" class="tool-row"><span>{{ tool.label }}</span><span :class="tool.available ? 'text-success' : 'muted'"><Check v-if="tool.available" :size="14" /><CircleAlert v-else :size="14" />{{ tool.available ? '可用' : '未安装' }}</span></div></div></section></div>
          <section class="panel"><div class="panel-heading"><h2>最近执行</h2><button class="text-button" @click="navigate('runs')">全部记录<ArrowRight :size="15" /></button></div><div v-if="!overview && overviewPending" class="empty-state compact"><Clock3 :size="28" /><h3>正在读取最近执行…</h3></div><div v-else-if="!overview" class="empty-state compact"><Clock3 :size="28" /><h3>概览数据暂时不可用</h3></div><div v-else-if="!recentRuns.length" class="empty-state compact"><Clock3 :size="28" /><h3>暂无执行记录</h3></div><div v-else class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>执行时间</th><th>归档大小</th><th>耗时</th><th class="action-column"></th></tr></thead><tbody><tr v-for="run in recentRuns" :key="run.id"><td><button class="table-link" @click="selectedRun = run.id">{{ run.jobName }}</button></td><td><span class="status" :class="run.status"><i />{{ statusLabels[run.status] }}</span></td><td class="nowrap">{{ shortTime(run.createdAt) }}</td><td>{{ bytes(run.archiveBytes) }}</td><td class="nowrap">{{ duration(run) }}</td><td><button class="icon-button" title="查看执行详情" aria-label="查看执行详情" @click="selectedRun = run.id"><ChevronRight :size="17" /></button></td></tr></tbody></table></div></section>
        </template>
        <JobsView v-else-if="page === 'jobs' && (jobsLoaded || jobs.length)" :jobs="jobs" :overview="overview" :busy-id="busyId" :active-job="activeJob" :can-run-job="canRunJob" @create="createJob()" @open="openJob" @run="runJob" @edit="edit" @remove="deleting = $event" @toggle="toggleJob" @toggle-watch="toggleWatch" @clone="cloneJob" />
        <!-- A jobs read that never succeeded must not render as an empty task list. -->
        <section v-else-if="page === 'jobs'" class="panel"><div class="panel-body"><div class="notice error" role="alert"><span>任务列表尚未成功加载，无法显示任务。</span><button type="button" class="text-button" @click="refresh()"><RefreshCw :size="14" />重新读取</button></div></div></section>
        <SitesView v-else-if="page === 'sites'" :sites="sites" :jobs="jobs" :loaded="sitesLoaded" :jobs-loaded="jobsLoaded" :loading="sitesLoading" :error="sitesError" :error-detail="sitesErrorDetail" :busy-id="siteBusyId" @create="createSite()" @edit="editSite" @remove="deletingSite = $event" @open-job="openJob" @reload="loadSites(true)" />
        <template v-else-if="page === 'runs'">
          <section class="panel runs-panel"><div class="panel-heading runs-toolbar"><div class="filter-group"><select v-model="runFilter" aria-label="按任务筛选"><option value="">全部任务</option><option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.name }}</option></select><select v-model="runStatusFilter" aria-label="按状态筛选"><option value="">全部状态</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="running">执行中</option><option value="queued">排队中</option><option value="cancelled">已取消</option><option value="interrupted">已中断</option></select></div><span class="muted record-count">{{ runsTotal }} 条记录</span></div>
          <div class="panel-body runs-body">
          <div v-if="!filteredRuns.length" class="empty-state tall"><div class="empty-symbol"><Activity :size="31" /></div><h3>{{ runs.length ? '没有匹配的执行记录' : '暂无执行记录' }}</h3></div>
          <div v-else class="table-wrap"><table><thead><tr><th>任务</th><th>状态 / 阶段</th><th>执行时间</th><th>归档大小</th><th>耗时</th><th>触发</th><th class="action-column"></th></tr></thead><tbody><tr v-for="run in filteredRuns" :key="run.id"><td><button class="table-link" @click="selectedRun = run.id">{{ run.jobName }}</button><small class="table-secondary">{{ typeLabel(run.type) }}</small></td><td><span class="status" :class="run.status"><i />{{ statusLabels[run.status] }}</span><small class="table-secondary">{{ phaseLabels[run.phase] || run.phase }}<template v-if="run.status === 'running' && liveProgress(run)"> · {{ liveProgress(run) }}</template></small></td><td class="nowrap">{{ dateTime(run.createdAt) }}</td><td>{{ bytes(run.archiveBytes) }}</td><td class="nowrap">{{ duration(run) }}</td><td>{{ run.trigger === 'manual' ? '手动' : run.trigger === 'schedule' ? '计划' : run.trigger === 'watch' ? (run.backupKind === 'incremental' ? '监听 · 增量' : '监听') : run.trigger }}</td><td><button class="icon-button" title="查看执行详情" aria-label="查看执行详情" @click="selectedRun = run.id"><ChevronRight :size="17" /></button></td></tr></tbody></table></div>
          </div>
          <div v-if="runsTotal > 30" class="pagination"><button class="button secondary small" :disabled="runsPage === 0" @click="runsPage--">上一页</button><span>{{ runsPage + 1 }} / {{ Math.ceil(runsTotal / 30) }}</span><button class="button secondary small" :disabled="(runsPage + 1) * 30 >= runsTotal" @click="runsPage++">下一页</button></div>
          </section>
        </template>
        <FileManagerView v-else-if="page === 'files'" @create-job="(path, kind) => createJob(kind, path)" />
        <StorageView v-else-if="page === 'storage'" @message="notify" />
        <SettingsView v-else-if="page === 'settings'" @message="notify" @saved="settingsSaved" />
      </main>
    </div>
  </div>
  <JobEditor v-if="editing" :job="editJob" :jobs="jobs" :initial-type="initialType" :initial-source-path="initialSourcePath" @close="editing = false" @saved="saved" @batch-saved="batchSaved" />
  <SiteEditor v-if="siteEditorOpen" :site="editingSite" :jobs="jobs" :jobs-loaded="jobsLoaded" :sites="sites" :save="saveSite" @close="closeSiteEditor" @saved="siteSaved" />
  <RunDetail v-if="selectedRun" :id="selectedRun" @close="selectedRun = ''" @changed="refresh()" />
  <Modal v-if="selectedJob" :title="selectedJob.name" wide @close="selectedJob = undefined">
    <nav class="dialog-tabs"><button :class="{ active: jobDetailTab === 'summary' }" @click="jobDetailTab = 'summary'">任务信息</button><button :class="{ active: jobDetailTab === 'archives' }" @click="jobDetailTab = 'archives'">备份版本 <span class="count">{{ archives.length }}</span></button></nav>
    <div class="modal-body job-detail">
      <template v-if="jobDetailTab === 'summary'"><div class="property-grid"><div><span>类型</span><strong>{{ typeLabel(selectedJob.type) }}</strong></div><div><span>状态</span><strong>{{ selectedJob.enabled ? '已启用' : '已暂停' }}</strong></div><div v-if="selectedJob.description" class="full"><span>描述</span><strong>{{ selectedJob.description }}</strong></div><div v-if="selectedJob.tags?.length" class="full"><span>标签</span><strong>{{ selectedJob.tags.join('、') }}</strong></div><div class="full"><span>关联站点</span><div v-if="selectedJobSites.length" class="site-links"><button v-for="site in selectedJobSites" :key="site.id" type="button" class="tag-chip" :title="`编辑站点 ${site.name}`" @click="openSite(site)">{{ site.name }}</button></div><strong v-else class="muted">未关联站点</strong></div><div class="full"><span>{{ selectedJob.type === 'system' ? '来源' : '源目录' }}</span><strong class="mono">{{ sourcePath(selectedJob) }}</strong></div><div><span>压缩格式</span><strong>{{ selectedJob.archive.format }}{{ selectedJob.archive.encrypted ? ' · AES-256' : '' }}</strong></div><div><span>保留策略</span><strong>{{ selectedJob.retention.days }} 天 · 至少 {{ selectedJob.retention.keepLast }} 份</strong></div><div v-if="selectedJob.type === 'directory'"><span>文件监听</span><strong>{{ !selectedJob.watch?.enabled ? '未启用' : !selectedJob.enabled ? '任务已暂停' : overview?.watchStatus?.[selectedJob.id]?.state === 'error' ? '监听错误' : !overview?.watchStatus?.[selectedJob.id] ? '状态待确认' : overview.watchStatus[selectedJob.id]?.capturing ? '正在建立基线' : overview.watchStatus[selectedJob.id]?.pending ? '等待备份' : '监听中' }}{{ selectedJob.watch?.enabled ? (selectedJob.watch.mode === 'incremental' ? ' · 仅变化文件' : ' · 整个目录') : '' }}</strong></div><div v-if="selectedJob.watch?.enabled && overview?.watchStatus?.[selectedJob.id]?.error" class="full"><span>监听错误</span><strong>{{ overview.watchStatus[selectedJob.id]?.error }}</strong></div><div><span>执行计划</span><strong class="mono">{{ selectedJob.schedule.enabled ? selectedJob.schedule.cron : '手动执行' }}</strong></div><div><span>下次执行</span><strong>{{ dateTime(selectedJob.nextRunAt) }}</strong></div><div v-if="selectedJob.type === 'vaultwarden'"><span>数据库</span><strong>{{ selectedJob.vaultwarden.dbType }}</strong></div></div><h3 class="form-heading separated">同步目标</h3><div v-for="(destination, index) in selectedJob.destinations" :key="index" class="target-row"><HardDrive :size="17" /><strong class="mono">{{ destination.remote }}:{{ destination.path }}</strong></div><span v-if="!selectedJob.destinations.length" class="muted">未配置</span><h3 class="form-heading separated">最近执行</h3><button v-if="selectedJob.lastRun" class="last-run-button" @click="selectedRun = selectedJob.lastRun.id"><span class="status" :class="selectedJob.lastRun.status">{{ statusLabels[selectedJob.lastRun.status] }}</span><span>{{ dateTime(selectedJob.lastRun.createdAt) }}</span><ChevronRight :size="17" /></button><span v-else class="muted">尚未执行</span></template>
      <template v-else><div v-if="archiveError" class="notice error">{{ archiveError }}</div><div v-if="archivesLoading" class="loading-line">正在读取备份版本…</div><div v-else-if="!archives.length" class="empty-state compact"><ArchiveIcon :size="29" /><h3>暂无备份版本</h3></div><div v-else class="archive-list"><article v-for="archive in archives" :key="archive.runId ?? archive.id" class="archive-row"><FileArchive :size="21" /><div class="archive-meta"><strong>{{ archive.archiveName ?? archive.name }}</strong><span>{{ dateTime(archive.createdAt ?? archive.finishedAt) }} · {{ bytes(archive.archiveBytes ?? archive.size) }}</span><span v-if="archive.sha256" class="mono checksum">SHA-256 {{ archive.sha256 }}</span><div class="archive-targets"><a v-for="(target, index) in availableTargets(archive)" :key="index" class="button secondary small" :href="`/api/jobs/${selectedJob.id}/archives/${archive.runId ?? archive.id}/download?destinationId=${encodeURIComponent(target.destinationId ?? '')}`"><Download :size="14" />{{ selectedJob.type === 'system' ? `导出 · ${target.remote}` : target.remote }}</a><span v-if="!availableTargets(archive).length" class="muted">远端版本已清理</span></div></div></article></div></template>
    </div>
    <footer class="modal-footer"><button v-if="selectedJob.type === 'system'" class="button secondary" @click="openSystemImport"><ArchiveIcon :size="16" />导入配置</button><button v-if="selectedJob.type !== 'system'" class="button secondary" :disabled="busyId === selectedJob.id" @click="cloneJob(selectedJob)"><Copy :size="16" />复制任务</button><button class="button secondary" @click="edit(selectedJob)"><Pencil :size="16" />编辑任务</button><button class="button primary" :disabled="busyId === selectedJob.id || activeJob(selectedJob.id) || !canRunJob(selectedJob)" @click="runJob(selectedJob)"><Play :size="16" />立即备份</button></footer>
  </Modal>
  <Modal v-if="systemImportOpen" title="导入系统配置" @close="systemImportOpen = false">
    <form @submit.prevent="importSystemConfiguration">
      <div class="modal-body"><div v-if="systemImportError" class="notice error" role="alert">{{ systemImportError }}</div><div v-if="systemImportDone" class="notice success" role="status">{{ systemImportDone }}</div><div v-else class="notice warning">重启服务后将替换当前任务、设置、登录账号和远端配置。</div><div class="form-grid"><label class="field full">系统配置归档<input type="file" accept=".7z,application/x-7z-compressed" @change="selectSystemImportFile" /></label><label class="field full">压缩包密码<input v-model="systemImportPassword" type="password" maxlength="1024" autocomplete="off" /></label></div></div>
      <footer class="modal-footer"><button class="button secondary" type="button" @click="systemImportOpen = false">关闭</button><button v-if="!systemImportDone" class="button primary" :disabled="systemImportBusy || !systemImportFile || !systemImportPassword"><ArchiveIcon :size="16" />{{ systemImportBusy ? '校验中…' : '导入配置' }}</button></footer>
    </form>
  </Modal>
  <Modal v-if="deleting" title="删除任务" @close="deleting = undefined"><div class="modal-body confirm-body"><Trash2 :size="29" class="text-danger" /><p>确认删除「{{ deleting.name }}」？</p></div><footer class="modal-footer"><button class="button secondary" @click="deleting = undefined">取消</button><button class="button destructive" :disabled="busyId === deleting.id" @click="deleteJob"><Trash2 :size="16" />删除任务</button></footer></Modal>
  <Modal v-if="deletingSite" title="删除站点" @close="deletingSite = undefined"><div class="modal-body confirm-body"><Trash2 :size="29" class="text-danger" /><p>确认删除「{{ deletingSite.name }}」？只会移除站点记录和任务关联，关联的备份任务、历史版本和归档都会保留。</p></div><footer class="modal-footer"><button class="button secondary" @click="deletingSite = undefined">取消</button><button class="button destructive" :disabled="siteBusyId === deletingSite.id" @click="deleteSite"><Trash2 :size="16" />删除站点</button></footer></Modal>
  <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><CheckCircle2 :size="19" /><span>{{ toast }}</span><button class="icon-button" title="关闭通知" aria-label="关闭通知" @click="toast = ''"><X :size="16" /></button></div></Transition>
</template>
