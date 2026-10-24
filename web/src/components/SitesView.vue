<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Globe, Plus, RefreshCw, Search } from 'lucide-vue-next';
import SiteRow from './SiteRow.vue';
import type { Job, Site } from '../types';

/**
 * Presentational site inventory. App owns the data and every mutation, so this
 * view only filters the authoritative list and emits the user's intent.
 *
 * Rows come from the shared SiteRow so the inventory and the overview preview
 * cannot drift apart.
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

const allTags = computed<string[]>(() => [...new Set<string>(props.sites.flatMap(site => site.tags as string[]))].sort((a, b) => a.localeCompare(b, 'zh')));
// A stale tag filter must not hide every row after its last site is re-tagged or deleted.
watch(allTags, tags => { if (tagFilter.value && !tags.includes(tagFilter.value)) tagFilter.value = ''; });

/** Search covers name, addresses, tags, repository URLs and notes. */
function haystack(site: Site) {
  return [site.name, ...(site.domains as string[]), ...(site.tags as string[]), ...((site.repositoryUrls ?? []) as string[]), site.notes ?? '']
    .join(' ')
    .toLowerCase();
}

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return props.sites.filter(site => {
    if (tagFilter.value && !site.tags.includes(tagFilter.value)) return false;
    if (linkFilter.value === 'linked' && !(site.backupJobIds as string[]).length) return false;
    if (linkFilter.value === 'unlinked' && (site.backupJobIds as string[]).length) return false;
    if (!needle) return true;
    return haystack(site).includes(needle);
  });
});
const filterActive = computed(() => Boolean(search.value.trim()) || Boolean(tagFilter.value) || linkFilter.value !== 'all');
function clearFilters() { search.value = ''; tagFilter.value = ''; linkFilter.value = 'all'; }
function toggleTag(tag: string) { tagFilter.value = tagFilter.value === tag ? '' : tag; }
</script>

<template>
  <section class="panel sites-panel">
    <div class="panel-heading jobs-toolbar sites-toolbar">
      <label class="search-field"><Search :size="17" /><input v-model="search" aria-label="搜索站点" placeholder="搜索站点名称、地址、标签、仓库或备注" /></label>
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
      <SiteRow
        v-for="site in filtered"
        :key="site.id"
        :site="site"
        :jobs="jobs"
        :jobs-loaded="jobsLoaded"
        :tag-filter="tagFilter"
        :busy="busyId === site.id"
        @edit="emit('edit', $event)"
        @remove="emit('remove', $event)"
        @open-job="emit('openJob', $event)"
        @filter-tag="toggleTag"
      />
    </div>
  </section>
</template>
