<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Activity, Archive as ArchiveIcon, ArrowRight, Check, CheckCircle2, ChevronRight, CircleAlert, Clock3,
  Database, Download, FileArchive, Folder, HardDrive, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Play,
  Plus, RefreshCw, Search, Settings2, ShieldCheck, Sun, Trash2, Pencil, X,
} from 'lucide-vue-next';
import { api, ApiError, errorMessage, setCsrfToken, uploadArchive, write } from './api';
import { bytes, dateTime, duration, phaseLabels, progress, shortTime, statusLabels } from './format';
import { isPage, navItems, pageTitle, type Page } from './nav';
import type { Archive, AuthStatus, Job, Overview, Run, ToolStatus } from './types';
import AccountMenu from './components/AccountMenu.vue';
import JobEditor from './components/JobEditor.vue';
import FileManagerView from './components/FileManagerView.vue';
import Modal from './components/Modal.vue';
import RunDetail from './components/RunDetail.vue';
import SettingsView from './components/SettingsView.vue';
import StorageView from './components/StorageView.vue';

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
const overview = ref<Overview>();
const jobs = ref<Job[]>([]);
const runs = ref<Run[]>([]);
const runsTotal = ref(0);
const runsPage = ref(0);
const runFilter = ref('');
const runStatusFilter = ref('');
const search = ref('');
const jobFilter = ref('all');
const editing = ref(false);
const editJob = ref<Job>();
const initialType = ref<'directory' | 'vaultwarden'>('directory');
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
const tagFilter = ref('');
const allTags = computed(() => [...new Set(jobs.value.flatMap(job => job.tags ?? []))].sort((a, b) => a.localeCompare(b)));
watch(allTags, tags => { if (tagFilter.value && !tags.includes(tagFilter.value)) tagFilter.value = ''; });
const filteredJobs = computed(() => jobs.value.filter(job => {
  const match = [job.name, job.description, job.sourcePath, job.vaultwarden.dataDir, ...(job.tags ?? []), ...job.destinations.map(target => `${target.remote}:${target.path}`)].join(' ').toLowerCase().includes(search.value.toLowerCase());
  return match && (!tagFilter.value || (job.tags ?? []).includes(tagFilter.value)) && (jobFilter.value === 'all' || (jobFilter.value === 'enabled' ? job.enabled : !job.enabled));
}));
const filteredRuns = computed(() => runs.value);
const recentRuns = computed(() => overview.value?.recentRuns.slice(0, 6) ?? []);
const activeRuns = computed(() => jobs.value.flatMap(job => job.lastRun && ['queued', 'running'].includes(job.lastRun.status)
  ? [{ ...job.lastRun, jobId: job.id, jobName: job.name, type: job.type }] : []));
const tools = computed(() => {
  const value = overview.value?.tools ?? {};
  const labels: Record<string, string> = { rclone: 'rclone', sevenZip: '7-Zip', tar: 'tar', sqlite: 'SQLite', pgDump: 'PostgreSQL', mysqlDump: 'MariaDB' };
  return (Array.isArray(value) ? value.map((tool, index) => [tool.name ?? String(index), tool] as const) : Object.entries(value))
    .map(([key, tool]) => ({ key, label: labels[key] ?? key, ...(typeof tool === 'boolean' ? { available: tool } : tool as ToolStatus) }));
});
const sourcePath = (job: Job) => job.type === 'system' ? '本系统配置' : job.type === 'vaultwarden' ? job.vaultwarden.dataDir : job.sourcePath;
const typeLabel = (type: Job['type']) => type === 'system' ? '系统配置' : type === 'vaultwarden' ? 'Vaultwarden' : '目录备份';
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
  if (auth.value.authenticated) await refresh();
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
  try { await write('/auth/logout'); auth.value = await api('/auth/status'); setCsrfToken(''); jobs.value = []; runs.value = []; overview.value = undefined; loaded.value = false; selectedJob.value = undefined; selectedRun.value = ''; }
  catch (cause) { error.value = errorMessage(cause); }
}
async function loadRuns() {
  const request = ++runsRequest;
  const data = await api<{ items: Run[]; total: number }>(`/runs?limit=30&offset=${runsPage.value * 30}${runFilter.value ? `&jobId=${encodeURIComponent(runFilter.value)}` : ''}${runStatusFilter.value ? `&status=${encodeURIComponent(runStatusFilter.value)}` : ''}`);
  if (request === runsRequest) { runs.value = data.items; runsTotal.value = data.total; }
}
async function refresh(silent = false) {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const [summary, list] = await Promise.all([api<Overview>('/overview'), api<Job[]>('/jobs'), loadRuns()]);
    overview.value = summary; jobs.value = list; error.value = ''; loaded.value = true;
    if (selectedJob.value) selectedJob.value = list.find(job => job.id === selectedJob.value?.id);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      auth.value = { initialized: true, authenticated: false, user: null, oidcEnabled: auth.value?.oidcEnabled ?? false, setupTokenRequired: false };
      setCsrfToken('');
    }
    else if (!silent) error.value = errorMessage(cause);
  } finally { refreshing.value = false; }
}
watch([runFilter, runStatusFilter], () => { runsPage.value = 0; if (auth.value?.authenticated) void loadRuns().catch(cause => { error.value = errorMessage(cause); }); });
watch(runsPage, () => { if (auth.value?.authenticated) void loadRuns().catch(cause => { error.value = errorMessage(cause); }); });
function createJob(type: 'directory' | 'vaultwarden' = 'directory', source = '') { editJob.value = undefined; initialType.value = type; initialSourcePath.value = source; editing.value = true; }
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
  try { await write(`/jobs/${deleting.value.id}`, undefined, 'DELETE'); if (selectedJob.value?.id === deleting.value.id) selectedJob.value = undefined; deleting.value = undefined; notify('任务已删除'); await refresh(); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { busyId.value = ''; }
}
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
    <aside class="sidebar" :class="{ open: mobileNav, collapsed }">
      <a class="brand" href="#overview" :title="collapsed ? 'AzureKiln Backup System' : undefined" @click="navigate('overview')"><img src="/brand.svg" alt="" width="35" height="35" /><div><strong>AzureKiln</strong><span>Backup System</span></div></a>
      <nav class="main-nav" aria-label="主导航"><button v-for="item in navItems" :key="item.id" :class="{ active: page === item.id }" :title="collapsed ? item.label : undefined" @click="navigate(item.id)"><component :is="item.icon" :size="19" /><span>{{ item.label }}</span><span v-if="item.badge === 'jobs' && jobs.length" class="nav-count">{{ jobs.length }}</span></button></nav>
      <button class="sidebar-collapse" type="button" :title="collapsed ? '展开导航' : '收起导航'" :aria-label="collapsed ? '展开导航' : '收起导航'" @click="toggleCollapsed"><PanelLeftOpen v-if="collapsed" :size="18" /><PanelLeftClose v-else :size="18" /><span>收起导航</span></button>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" title="打开导航" aria-label="打开导航" @click="mobileNav = !mobileNav"><Menu :size="21" /></button><span class="workspace-label">管理控制台</span></div><div class="topbar-actions"><span class="live-indicator"><i />{{ activeRuns.length ? `${activeRuns.length} 个执行中` : '系统在线' }}</span><button class="icon-button" :title="theme === 'dark' ? '浅色主题' : '深色主题'" :aria-label="theme === 'dark' ? '浅色主题' : '深色主题'" @click="toggleTheme"><Sun v-if="theme === 'dark'" :size="19" /><Moon v-else :size="19" /></button><AccountMenu :username="auth.user?.username" :theme="theme" @toggle-theme="toggleTheme" @logout="logout" /></div></header>
      <main class="main-content">
        <header class="page-heading"><h1>{{ title }}</h1><div class="heading-actions"><button v-if="['overview','jobs','runs'].includes(page)" class="icon-button bordered" title="刷新" aria-label="刷新" :disabled="refreshing" @click="refresh()"><RefreshCw :size="18" :class="{ spinning: refreshing }" /></button><button v-if="page === 'overview' || page === 'jobs'" class="button primary" @click="createJob()"><Plus :size="17" />新建任务</button></div></header>
        <div v-if="error" class="notice error" role="alert">{{ error }}<button class="icon-button" title="关闭错误提示" aria-label="关闭错误提示" @click="error = ''"><X :size="16" /></button></div>
        <div v-if="!loaded && ['overview','jobs','runs'].includes(page)" class="loading-line">正在读取备份数据…</div>
        <template v-else-if="page === 'overview'">
          <section class="metrics" aria-label="备份统计"><div class="metric"><div><span>备份任务</span><Folder :size="19" /></div><strong>{{ overview?.totalJobs ?? 0 }}<small>个</small></strong><p>{{ overview?.enabledJobs ?? 0 }} 个已启用</p></div><div class="metric"><div><span>正在执行</span><Activity :size="19" /></div><strong>{{ activeRuns.length }}<small>个</small></strong><p>{{ activeRuns.length ? '备份进行中' : '队列空闲' }}</p></div><div class="metric"><div><span>最近成功</span><CheckCircle2 :size="19" /></div><strong class="date-value">{{ overview?.lastSuccessAt ? shortTime(overview.lastSuccessAt) : '—' }}</strong><p>{{ overview?.lastSuccessAt ? '最近一次成功备份' : '暂无成功记录' }}</p></div><div class="metric"><div><span>临时空间</span><FileArchive :size="19" /></div><strong>{{ bytes(overview?.storage.tempBytes ?? 0) }}</strong><p>{{ overview?.storage.maxTempBytes ? `上限 ${bytes(overview.storage.maxTempBytes)}` : '—' }}</p></div></section>
          <section v-if="activeRuns.length" class="page-band active-section"><div class="section-heading"><h2>当前执行</h2><span class="status running"><i />{{ activeRuns.length }} 个任务</span></div><button v-for="run in activeRuns" :key="run.id" class="active-run" @click="selectedRun = run.id"><div class="run-symbol"><RefreshCw :size="20" class="spinning" /></div><div><strong>{{ run.jobName }}</strong><span>{{ phaseLabels[run.phase] || run.phase }}<template v-if="liveProgress(run)"> · {{ liveProgress(run) }}</template></span></div><ChevronRight :size="19" /></button></section>
          <div class="overview-columns"><section class="page-band"><div class="section-heading"><h2>备份任务 <span class="count">{{ jobs.length }}</span></h2><button class="text-button" @click="navigate('jobs')">全部任务<ArrowRight :size="15" /></button></div><div v-if="!jobs.length" class="empty-state"><div class="empty-symbol"><Folder :size="31" /></div><h3>尚无备份任务</h3><div class="empty-actions"><button class="button secondary" @click="createJob('directory')"><Plus :size="16" />目录备份</button><button class="button secondary" @click="createJob('vaultwarden')"><Database :size="16" />Vaultwarden</button></div></div><div v-else class="overview-job-list"><div v-for="job in jobs.slice(0, 6)" :key="job.id" class="overview-job"><button class="job-primary" @click="openJob(job)"><div class="job-symbol" :class="job.type"><Settings2 v-if="job.type === 'system'" :size="20" /><Database v-else-if="job.type === 'vaultwarden'" :size="20" /><Folder v-else :size="20" /></div><div><strong>{{ job.name }}</strong><span class="mono">{{ sourcePath(job) }}</span><span v-if="job.description" :title="job.description">{{ job.description }}</span></div></button><span class="status" :class="job.lastRun?.status ?? (job.enabled ? 'pending' : 'disabled')">{{ job.lastRun ? statusLabels[job.lastRun.status] : job.enabled ? '尚未执行' : '已暂停' }}</span><button class="icon-button" title="立即备份" aria-label="立即备份" :disabled="busyId === job.id || activeJob(job.id) || !canRunJob(job)" @click="runJob(job)"><Play :size="17" /></button></div></div></section><section class="page-band environment-section"><div class="section-heading"><h2>运行环境</h2><button class="text-button" @click="navigate('storage')">存储<ArrowRight :size="15" /></button></div><div v-for="tool in tools" :key="tool.key" class="tool-row"><span>{{ tool.label }}</span><span :class="tool.available ? 'text-success' : 'muted'"><Check v-if="tool.available" :size="14" /><CircleAlert v-else :size="14" />{{ tool.available ? '可用' : '未安装' }}</span></div></section></div>
          <section class="page-band"><div class="section-heading"><h2>最近执行</h2><button class="text-button" @click="navigate('runs')">全部记录<ArrowRight :size="15" /></button></div><div v-if="!recentRuns.length" class="empty-state compact"><Clock3 :size="28" /><h3>暂无执行记录</h3></div><div v-else class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>执行时间</th><th>归档大小</th><th>耗时</th><th class="action-column"></th></tr></thead><tbody><tr v-for="run in recentRuns" :key="run.id"><td><button class="table-link" @click="selectedRun = run.id">{{ run.jobName }}</button></td><td><span class="status" :class="run.status"><i />{{ statusLabels[run.status] }}</span></td><td class="nowrap">{{ shortTime(run.createdAt) }}</td><td>{{ bytes(run.archiveBytes) }}</td><td class="nowrap">{{ duration(run) }}</td><td><button class="icon-button" title="查看执行详情" aria-label="查看执行详情" @click="selectedRun = run.id"><ChevronRight :size="17" /></button></td></tr></tbody></table></div></section>
        </template>
        <template v-else-if="page === 'jobs'">
          <div class="list-toolbar"><label class="search-field"><Search :size="17" /><input v-model="search" aria-label="搜索任务" placeholder="搜索名称、描述、目录或远端" /></label><div class="filter-group"><select v-if="allTags.length" v-model="tagFilter" aria-label="按标签筛选"><option value="">全部标签</option><option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option></select><div class="segmented compact"><button :class="{ active: jobFilter === 'all' }" @click="jobFilter = 'all'">全部</button><button :class="{ active: jobFilter === 'enabled' }" @click="jobFilter = 'enabled'">已启用</button><button :class="{ active: jobFilter === 'disabled' }" @click="jobFilter = 'disabled'">已暂停</button></div></div></div>
          <div v-if="!filteredJobs.length" class="empty-state tall"><div class="empty-symbol"><Folder :size="32" /></div><h3>{{ jobs.length ? '没有匹配的任务' : '尚无备份任务' }}</h3><button v-if="!jobs.length" class="button primary" @click="createJob()"><Plus :size="16" />新建任务</button></div>
          <div v-else class="table-wrap jobs-table"><table><thead><tr><th>任务 / 来源</th><th>同步目标</th><th>最近执行</th><th>下次执行</th><th>启用</th><th>文件监听</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="job in filteredJobs" :key="job.id"><td><button class="job-primary" @click="openJob(job)"><div class="job-symbol" :class="job.type"><Settings2 v-if="job.type === 'system'" :size="20" /><Database v-else-if="job.type === 'vaultwarden'" :size="20" /><Folder v-else :size="20" /></div><div><strong>{{ job.name }}</strong><span class="mono">{{ sourcePath(job) }}</span><span v-if="job.description" :title="job.description">{{ job.description }}</span></div></button><div v-if="job.tags?.length" class="tag-list"><button v-for="tag in job.tags" :key="tag" type="button" class="tag-chip" :class="{ active: tagFilter === tag }" :title="tagFilter === tag ? '取消标签筛选' : `只看标签 ${tag}`" @click="tagFilter = tagFilter === tag ? '' : tag">{{ tag }}</button></div></td><td><div class="target-label" v-for="(destination, index) in job.destinations" :key="index"><HardDrive :size="13" /><span class="mono">{{ destination.remote }}:{{ destination.path }}</span></div><span v-if="!job.destinations.length" class="muted">未配置</span></td><td><span class="status" :class="job.lastRun?.status ?? 'pending'">{{ job.lastRun ? statusLabels[job.lastRun.status] : '尚未执行' }}</span><small class="table-secondary">{{ shortTime(job.lastRun?.createdAt) }}</small></td><td class="nowrap">{{ job.schedule.enabled ? shortTime(job.nextRunAt) : '手动执行' }}</td><td><input class="switch" type="checkbox" :checked="job.enabled" :disabled="busyId === job.id || (job.type === 'system' && !canRunJob(job))" :aria-label="`启用 ${job.name}`" @change="toggleJob(job)" /></td><td class="nowrap"><template v-if="job.type === 'directory'"><input class="switch" type="checkbox" :checked="job.watch?.enabled ?? false" :disabled="busyId === job.id" :aria-label="`文件监听 ${job.name}`" @change="toggleWatch(job)" /><small v-if="watchLabel(job)" class="table-secondary" :class="{ 'text-danger': overview?.watchStatus?.[job.id]?.state === 'error' }" :title="overview?.watchStatus?.[job.id]?.error ?? undefined">{{ watchLabel(job) }}</small></template><span v-else class="muted">—</span></td><td><div class="row-actions"><button class="icon-button" title="立即备份" aria-label="立即备份" :disabled="busyId === job.id || activeJob(job.id) || !canRunJob(job)" @click="runJob(job)"><Play :size="17" /></button><button class="icon-button" title="编辑任务" aria-label="编辑任务" @click="edit(job)"><Pencil :size="16" /></button><button v-if="job.type !== 'system'" class="icon-button danger" title="删除任务" aria-label="删除任务" :disabled="activeJob(job.id)" @click="deleting = job"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div>
        </template>
        <template v-else-if="page === 'runs'">
          <div class="list-toolbar"><div class="filter-group"><select v-model="runFilter" aria-label="按任务筛选"><option value="">全部任务</option><option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.name }}</option></select><select v-model="runStatusFilter" aria-label="按状态筛选"><option value="">全部状态</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="running">执行中</option><option value="queued">排队中</option><option value="cancelled">已取消</option><option value="interrupted">已中断</option></select></div><span class="muted record-count">{{ runsTotal }} 条记录</span></div>
          <div v-if="!filteredRuns.length" class="empty-state tall"><div class="empty-symbol"><Activity :size="31" /></div><h3>{{ runs.length ? '没有匹配的执行记录' : '暂无执行记录' }}</h3></div>
          <div v-else class="table-wrap"><table><thead><tr><th>任务</th><th>状态 / 阶段</th><th>执行时间</th><th>归档大小</th><th>耗时</th><th>触发</th><th class="action-column"></th></tr></thead><tbody><tr v-for="run in filteredRuns" :key="run.id"><td><button class="table-link" @click="selectedRun = run.id">{{ run.jobName }}</button><small class="table-secondary">{{ typeLabel(run.type) }}</small></td><td><span class="status" :class="run.status"><i />{{ statusLabels[run.status] }}</span><small class="table-secondary">{{ phaseLabels[run.phase] || run.phase }}<template v-if="run.status === 'running' && liveProgress(run)"> · {{ liveProgress(run) }}</template></small></td><td class="nowrap">{{ dateTime(run.createdAt) }}</td><td>{{ bytes(run.archiveBytes) }}</td><td class="nowrap">{{ duration(run) }}</td><td>{{ run.trigger === 'manual' ? '手动' : run.trigger === 'schedule' ? '计划' : run.trigger === 'watch' ? (run.backupKind === 'incremental' ? '监听 · 增量' : '监听') : run.trigger }}</td><td><button class="icon-button" title="查看执行详情" aria-label="查看执行详情" @click="selectedRun = run.id"><ChevronRight :size="17" /></button></td></tr></tbody></table></div>
          <div v-if="runsTotal > 30" class="pagination"><button class="button secondary small" :disabled="runsPage === 0" @click="runsPage--">上一页</button><span>{{ runsPage + 1 }} / {{ Math.ceil(runsTotal / 30) }}</span><button class="button secondary small" :disabled="(runsPage + 1) * 30 >= runsTotal" @click="runsPage++">下一页</button></div>
        </template>
        <FileManagerView v-else-if="page === 'files'" @create-job="source => createJob('directory', source)" />
        <StorageView v-else-if="page === 'storage'" @message="notify" />
        <SettingsView v-else-if="page === 'settings'" @message="notify" @saved="settingsSaved" />
      </main>
    </div>
  </div>
  <JobEditor v-if="editing" :job="editJob" :jobs="jobs" :initial-type="initialType" :initial-source-path="initialSourcePath" @close="editing = false" @saved="saved" @batch-saved="batchSaved" />
  <RunDetail v-if="selectedRun" :id="selectedRun" @close="selectedRun = ''" @changed="refresh()" />
  <Modal v-if="selectedJob" :title="selectedJob.name" wide @close="selectedJob = undefined">
    <nav class="dialog-tabs"><button :class="{ active: jobDetailTab === 'summary' }" @click="jobDetailTab = 'summary'">任务信息</button><button :class="{ active: jobDetailTab === 'archives' }" @click="jobDetailTab = 'archives'">备份版本 <span class="count">{{ archives.length }}</span></button></nav>
    <div class="modal-body job-detail">
      <template v-if="jobDetailTab === 'summary'"><div class="property-grid"><div><span>类型</span><strong>{{ typeLabel(selectedJob.type) }}</strong></div><div><span>状态</span><strong>{{ selectedJob.enabled ? '已启用' : '已暂停' }}</strong></div><div v-if="selectedJob.description" class="full"><span>描述</span><strong>{{ selectedJob.description }}</strong></div><div v-if="selectedJob.tags?.length" class="full"><span>标签</span><strong>{{ selectedJob.tags.join('、') }}</strong></div><div class="full"><span>{{ selectedJob.type === 'system' ? '来源' : '源目录' }}</span><strong class="mono">{{ sourcePath(selectedJob) }}</strong></div><div><span>压缩格式</span><strong>{{ selectedJob.archive.format }}{{ selectedJob.archive.encrypted ? ' · AES-256' : '' }}</strong></div><div><span>保留策略</span><strong>{{ selectedJob.retention.days }} 天 · 至少 {{ selectedJob.retention.keepLast }} 份</strong></div><div v-if="selectedJob.type === 'directory'"><span>文件监听</span><strong>{{ !selectedJob.watch?.enabled ? '未启用' : !selectedJob.enabled ? '任务已暂停' : overview?.watchStatus?.[selectedJob.id]?.state === 'error' ? '监听错误' : !overview?.watchStatus?.[selectedJob.id] ? '状态待确认' : overview.watchStatus[selectedJob.id]?.capturing ? '正在建立基线' : overview.watchStatus[selectedJob.id]?.pending ? '等待备份' : '监听中' }}{{ selectedJob.watch?.enabled ? (selectedJob.watch.mode === 'incremental' ? ' · 仅变化文件' : ' · 整个目录') : '' }}</strong></div><div v-if="selectedJob.watch?.enabled && overview?.watchStatus?.[selectedJob.id]?.error" class="full"><span>监听错误</span><strong>{{ overview.watchStatus[selectedJob.id]?.error }}</strong></div><div><span>执行计划</span><strong class="mono">{{ selectedJob.schedule.enabled ? selectedJob.schedule.cron : '手动执行' }}</strong></div><div><span>下次执行</span><strong>{{ dateTime(selectedJob.nextRunAt) }}</strong></div><div v-if="selectedJob.type === 'vaultwarden'"><span>数据库</span><strong>{{ selectedJob.vaultwarden.dbType }}</strong></div></div><h3 class="form-heading separated">同步目标</h3><div v-for="(destination, index) in selectedJob.destinations" :key="index" class="target-row"><HardDrive :size="17" /><strong class="mono">{{ destination.remote }}:{{ destination.path }}</strong></div><span v-if="!selectedJob.destinations.length" class="muted">未配置</span><h3 class="form-heading separated">最近执行</h3><button v-if="selectedJob.lastRun" class="last-run-button" @click="selectedRun = selectedJob.lastRun.id"><span class="status" :class="selectedJob.lastRun.status">{{ statusLabels[selectedJob.lastRun.status] }}</span><span>{{ dateTime(selectedJob.lastRun.createdAt) }}</span><ChevronRight :size="17" /></button><span v-else class="muted">尚未执行</span></template>
      <template v-else><div v-if="archiveError" class="notice error">{{ archiveError }}</div><div v-if="archivesLoading" class="loading-line">正在读取备份版本…</div><div v-else-if="!archives.length" class="empty-state compact"><ArchiveIcon :size="29" /><h3>暂无备份版本</h3></div><div v-else class="archive-list"><article v-for="archive in archives" :key="archive.runId ?? archive.id" class="archive-row"><FileArchive :size="21" /><div class="archive-meta"><strong>{{ archive.archiveName ?? archive.name }}</strong><span>{{ dateTime(archive.createdAt ?? archive.finishedAt) }} · {{ bytes(archive.archiveBytes ?? archive.size) }}</span><span v-if="archive.sha256" class="mono checksum">SHA-256 {{ archive.sha256 }}</span><div class="archive-targets"><a v-for="(target, index) in availableTargets(archive)" :key="index" class="button secondary small" :href="`/api/jobs/${selectedJob.id}/archives/${archive.runId ?? archive.id}/download?destinationId=${encodeURIComponent(target.destinationId ?? '')}`"><Download :size="14" />{{ selectedJob.type === 'system' ? `导出 · ${target.remote}` : target.remote }}</a><span v-if="!availableTargets(archive).length" class="muted">远端版本已清理</span></div></div></article></div></template>
    </div>
    <footer class="modal-footer"><button v-if="selectedJob.type === 'system'" class="button secondary" @click="openSystemImport"><ArchiveIcon :size="16" />导入配置</button><button class="button secondary" @click="edit(selectedJob)"><Pencil :size="16" />编辑任务</button><button class="button primary" :disabled="busyId === selectedJob.id || activeJob(selectedJob.id) || !canRunJob(selectedJob)" @click="runJob(selectedJob)"><Play :size="16" />立即备份</button></footer>
  </Modal>
  <Modal v-if="systemImportOpen" title="导入系统配置" @close="systemImportOpen = false">
    <form @submit.prevent="importSystemConfiguration">
      <div class="modal-body"><div v-if="systemImportError" class="notice error" role="alert">{{ systemImportError }}</div><div v-if="systemImportDone" class="notice success" role="status">{{ systemImportDone }}</div><div v-else class="notice warning">重启服务后将替换当前任务、设置、登录账号和远端配置。</div><div class="form-grid"><label class="field full">系统配置归档<input type="file" accept=".7z,application/x-7z-compressed" @change="selectSystemImportFile" /></label><label class="field full">压缩包密码<input v-model="systemImportPassword" type="password" maxlength="1024" autocomplete="off" /></label></div></div>
      <footer class="modal-footer"><button class="button secondary" type="button" @click="systemImportOpen = false">关闭</button><button v-if="!systemImportDone" class="button primary" :disabled="systemImportBusy || !systemImportFile || !systemImportPassword"><ArchiveIcon :size="16" />{{ systemImportBusy ? '校验中…' : '导入配置' }}</button></footer>
    </form>
  </Modal>
  <Modal v-if="deleting" title="删除任务" @close="deleting = undefined"><div class="modal-body confirm-body"><Trash2 :size="29" class="text-danger" /><p>确认删除「{{ deleting.name }}」？</p></div><footer class="modal-footer"><button class="button secondary" @click="deleting = undefined">取消</button><button class="button destructive" :disabled="busyId === deleting.id" @click="deleteJob"><Trash2 :size="16" />删除任务</button></footer></Modal>
  <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><CheckCircle2 :size="19" /><span>{{ toast }}</span><button class="icon-button" title="关闭通知" aria-label="关闭通知" @click="toast = ''"><X :size="16" /></button></div></Transition>
</template>
