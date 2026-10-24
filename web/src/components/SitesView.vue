<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Globe, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-vue-next';
import { shortTime, statusLabels } from '../format';
import { siteDomainLink } from '../../../shared/contracts.mjs';
import type { Job, Site } from '../types';

/**
 * Presentational site inventory. App owns the data and every mutation, so this
 * view only filters the authoritative list and emits the user's intent.
 */
const props = defineProps<{
  sites: Site[];
  jobs: Job[];
  /** True only after /sites returned successfully, so "empty" is never assumed. */
  loaded: boolean;
  /** True only after the current /jobs read succeeded; unresolved links are not deletions. */
  jobsLoaded: boolean;
  loading: boolean;
  error: string;
  /** Raw low-level text, shown only as a tooltip; the body copy is already localized. */
  errorDetail?: string;
  busyId: string;
}>();
const emit = defineEmits<{
  create: [];
  edit: [site: Site];
  remove: [site: Site];
  openJob: [job: Job];
  reload: [];
}>();

const search = ref('');
const tagFilter = ref('');
const linkFilter = ref<'all' | 'linked' | 'unlinked'>('all');

const typeLabels: Record<Job['type'], string> = { directory: '目录备份', vaultwarden: 'Vaultwarden', newapi: 'NewAPI', system: '系统配置' };
const jobById = computed(() => new Map(props.jobs.map(job => [job.id, job])));
const linkedJobs = (site: Site): Job[] => (site.backupJobIds as string[]).map(id => jobById.value.get(id)).filter((job): job is Job => Boolean(job));
/** Selected link IDs that the current task list cannot resolve (pending or stale, never assumed deleted). */
const unresolvedCount = (site: Site) => (site.backupJobIds as string[]).filter(id => !jobById.value.has(id)).length;

const allTags = computed<string[]>(() => [...new Set<string>(props.sites.flatMap(site => site.tags as string[]))].sort((a, b) => a.localeCompare(b, 'zh')));
// A stale tag filter must not hide every row after its last site is re-tagged or deleted.
watch(allTags, tags => { if (tagFilter.value && !tags.includes(tagFilter.value)) tagFilter.value = ''; });

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return props.sites.filter(site => {
    if (tagFilter.value && !site.tags.includes(tagFilter.value)) return false;
    if (linkFilter.value === 'linked' && !(site.backupJobIds as string[]).length) return false;
    if (linkFilter.value === 'unlinked' && (site.backupJobIds as string[]).length) return false;
    if (!needle) return true;
    return [site.name, ...site.domains, ...site.tags].join(' ').toLowerCase().includes(needle);
  });
});
const filterActive = computed(() => Boolean(search.value.trim()) || Boolean(tagFilter.value) || linkFilter.value !== 'all');
function clearFilters() { search.value = ''; tagFilter.value = ''; linkFilter.value = 'all'; }

interface DomainLink { href: string; label: string }
/** Canonical href plus compact label from the shared contract; never reparsed here. */
function domainsOf(site: Site): DomainLink[] {
  return (site.domains as string[]).map((domain: string): DomainLink => {
    try { return siteDomainLink(domain) as DomainLink; }
    catch { return { href: '', label: domain }; }
  });
}

const jobStatus = (job: Job) => job.lastRun ? statusLabels[job.lastRun.status] : job.enabled ? '尚未执行' : '已暂停';
const jobStatusClass = (job: Job) => job.lastRun?.status ?? (job.enabled ? 'pending' : 'disabled');
</script>

<template>
  <section class="panel sites-panel">
    <div class="panel-heading jobs-toolbar sites-toolbar">
      <label class="search-field"><Search :size="17" /><input v-model="search" aria-label="搜索站点" placeholder="搜索站点名称、域名或标签" /></label>
      <div class="toolbar-filters">
        <div class="filter-group">
          <select v-model="tagFilter" aria-label="按站点标签筛选"><option value="">全部站点标签</option><option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option></select>
          <div class="segmented compact" aria-label="按关联任务筛选"><button type="button" :class="{ active: linkFilter === 'all' }" @click="linkFilter = 'all'">全部</button><button type="button" :class="{ active: linkFilter === 'linked' }" @click="linkFilter = 'linked'">已关联</button><button type="button" :class="{ active: linkFilter === 'unlinked' }" @click="linkFilter = 'unlinked'">未关联</button></div>
        </div>
      </div>
      <span class="muted group-summary">{{ sites.length }} 个站点 · {{ filtered.length }} 个匹配<template v-if="loading && loaded"> · 正在刷新…</template></span>
    </div>
    <div v-if="error" class="panel-body site-error-body"><div class="notice error" role="alert"><span :title="errorDetail || undefined">{{ error }}</span><button type="button" class="text-button" @click="emit('reload')"><RefreshCw :size="14" />重新读取</button></div></div>
    <div v-if="!loaded && !error" class="loading-line">正在读取站点…</div>
    <div v-else-if="loaded && !sites.length && !error" class="empty-state tall">
      <div class="empty-symbol"><Globe :size="31" /></div>
      <h3>尚无站点</h3>
      <p>先创建站点，再把已有的备份任务关联到它。站点只是分类信息，不会新建或改动备份任务。</p>
      <button class="button primary" @click="emit('create')"><Plus :size="16" />新增站点</button>
    </div>
    <div v-else-if="sites.length && !filtered.length" class="empty-state tall">
      <div class="empty-symbol"><Search :size="31" /></div>
      <h3>没有匹配的站点</h3>
      <button v-if="filterActive" class="button secondary" @click="clearFilters">清除筛选</button>
    </div>
    <div v-else-if="sites.length" class="site-list">
      <article v-for="site in filtered" :key="site.id" class="site-row">
        <div class="site-row-head">
          <div class="site-identity">
            <Globe :size="18" />
            <div>
              <strong class="site-name">{{ site.name }}</strong>
              <span class="site-meta">{{ site.domains.length ? `${site.domains.length} 个访问地址` : '未填写访问地址' }} · {{ (site.backupJobIds as string[]).length }} 个关联任务<template v-if="site.updatedAt"> · 更新于 {{ shortTime(site.updatedAt) }}</template></span>
            </div>
          </div>
          <div class="site-actions">
            <button class="icon-button" type="button" title="编辑站点" aria-label="编辑站点" @click="emit('edit', site)"><Pencil :size="16" /></button>
            <button class="icon-button danger" type="button" title="删除站点" aria-label="删除站点" :disabled="busyId === site.id" @click="emit('remove', site)"><Trash2 :size="16" /></button>
          </div>
        </div>
        <div class="site-domains">
          <template v-if="site.domains.length">
            <template v-for="item in domainsOf(site)" :key="item.href || item.label">
              <a v-if="item.href" class="site-domain" :href="item.href" target="_blank" rel="noopener noreferrer">{{ item.label }}</a>
              <span v-else class="site-domain">{{ item.label }}</span>
            </template>
          </template>
          <span v-else class="muted">未填写访问地址</span>
        </div>
        <div v-if="site.tags.length" class="tag-list site-tags">
          <button v-for="tag in site.tags" :key="tag" type="button" class="tag-chip" :class="{ active: tagFilter === tag }" :title="tagFilter === tag ? '取消站点标签筛选' : `只看站点标签 ${tag}`" @click="tagFilter = tagFilter === tag ? '' : tag">{{ tag }}</button>
        </div>
        <div class="site-jobs">
          <span class="site-jobs-label">关联任务</span>
          <template v-if="jobsLoaded">
            <button v-for="job in linkedJobs(site)" :key="job.id" type="button" class="site-job" :title="`查看任务 ${job.name}`" @click="emit('openJob', job)">
              <span class="site-job-name">{{ job.name }}</span>
              <span class="site-job-type">{{ typeLabels[job.type] }}</span>
              <span class="status" :class="jobStatusClass(job)">{{ jobStatus(job) }}</span>
            </button>
            <span v-if="unresolvedCount(site)" class="site-job unknown" title="当前任务列表里找不到这些关联任务，不会被自动解除">任务信息未同步（{{ unresolvedCount(site) }}）</span>
            <span v-else-if="!linkedJobs(site).length" class="muted">未关联备份任务</span>
          </template>
          <template v-else>
            <span v-if="(site.backupJobIds as string[]).length" class="site-job pending" title="任务列表尚未成功加载">任务信息待加载（{{ (site.backupJobIds as string[]).length }}）</span>
            <span v-else class="muted">未关联备份任务</span>
          </template>
        </div>
      </article>
    </div>
  </section>
</template>
