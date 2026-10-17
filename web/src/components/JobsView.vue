<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ChevronDown, ChevronRight, Database, Folder, HardDrive, Pencil, Play, Plus, Search, Settings2, Trash2,
} from 'lucide-vue-next';
import { shortTime, statusLabels } from '../format';
import type { Job, Overview } from '../types';
import {
  groupJobs, groupModeLabels, readCollapsed, readGroupMode, writeCollapsed, writeGroupMode,
  type GroupMode,
} from '../jobGroups';

const props = defineProps<{
  jobs: Job[];
  overview?: Overview;
  busyId: string;
  activeJob: (id: string) => boolean;
  canRunJob: (job: Job) => boolean;
}>();
const emit = defineEmits<{
  create: [];
  open: [job: Job];
  run: [job: Job];
  edit: [job: Job];
  remove: [job: Job];
  toggle: [job: Job];
  toggleWatch: [job: Job];
}>();

/** Browser storage is absent while server-rendering; every helper tolerates undefined. */
const storage = typeof localStorage === 'undefined' ? undefined : localStorage;

const search = ref('');
const jobFilter = ref('all');
const tagFilter = ref('');
const groupMode = ref<GroupMode>(readGroupMode(storage));
const collapsed = ref(readCollapsed(storage, groupMode.value));
const groupModes = Object.keys(groupModeLabels) as GroupMode[];

// Remember the mode, and swap in the collapse state stored for it.
watch(groupMode, mode => {
  writeGroupMode(storage, mode);
  collapsed.value = readCollapsed(storage, mode);
});
watch(collapsed, value => writeCollapsed(storage, groupMode.value, value));

const sourcePath = (job: Job) => job.type === 'system' ? '本系统配置' : job.type === 'vaultwarden' ? job.vaultwarden.dataDir : job.sourcePath;
const allTags = computed(() => [...new Set(props.jobs.flatMap(job => job.tags ?? []))].sort((a, b) => a.localeCompare(b)));
// A stale tag filter must not hide every row when its last task is re-tagged or deleted.
watch(allTags, tags => { if (tagFilter.value && !tags.includes(tagFilter.value)) tagFilter.value = ''; });

function matches(job: Job) {
  const haystack = [job.name, job.description, job.sourcePath, job.vaultwarden.dataDir, ...(job.tags ?? []), ...job.destinations.map(target => `${target.remote}:${target.path}`)].join(' ').toLowerCase();
  return haystack.includes(search.value.toLowerCase())
    && (!tagFilter.value || (job.tags ?? []).includes(tagFilter.value))
    && (jobFilter.value === 'all' || (jobFilter.value === 'enabled' ? job.enabled : !job.enabled));
}

const filterActive = computed(() => Boolean(search.value.trim()) || Boolean(tagFilter.value) || jobFilter.value !== 'all');
const groups = computed(() => groupJobs(props.jobs, { mode: groupMode.value, match: matches }));
const matchCount = computed(() => groups.value.reduce((sum, group) => sum + group.jobs.length, 0));

// A hit inside a collapsed group would stay invisible, so a search always opens every group.
const searching = computed(() => Boolean(search.value.trim()));
const isCollapsed = (key: string) => !searching.value && collapsed.value.has(key);
function toggleGroup(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}
function expandAll() { collapsed.value = new Set(); }
function collapseAll() { collapsed.value = new Set(groups.value.map(group => group.key)); }
const allCollapsed = computed(() => groups.value.length > 0 && groups.value.every(group => collapsed.value.has(group.key)));
// "Expand all" is pointless once nothing is collapsed, and vice versa.
const anyCollapsed = computed(() => groups.value.some(group => collapsed.value.has(group.key)));

function watchLabel(job: Job) {
  if (job.type !== 'directory' || !job.watch?.enabled) return '';
  const status = props.overview?.watchStatus?.[job.id];
  const mode = job.watch.mode === 'incremental' ? '增量' : '整目录';
  if (!job.enabled) return `${mode} · 任务已暂停`;
  if (!status) return mode;
  return `${mode} · ${status.state === 'error' ? '监听错误' : status.capturing ? '建立基线' : status.pending ? '等待备份' : '监听中'}`;
}
</script>

<template>
  <div class="list-toolbar">
    <label class="search-field"><Search :size="17" /><input v-model="search" aria-label="搜索任务" placeholder="搜索名称、描述、目录或远端" /></label>
    <div class="filter-group">
      <select v-model="tagFilter" aria-label="按标签筛选"><option value="">全部标签</option><option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option></select>
      <div class="segmented compact"><button :class="{ active: jobFilter === 'all' }" @click="jobFilter = 'all'">全部</button><button :class="{ active: jobFilter === 'enabled' }" @click="jobFilter = 'enabled'">已启用</button><button :class="{ active: jobFilter === 'disabled' }" @click="jobFilter = 'disabled'">已暂停</button></div>
    </div>
  </div>
  <div class="group-toolbar">
    <label class="group-mode"><span>分组方式</span><select v-model="groupMode" aria-label="分组方式"><option v-for="mode in groupModes" :key="mode" :value="mode">{{ groupModeLabels[mode] }}</option></select></label>
    <template v-if="groupMode !== 'none' && groups.length > 1">
      <span class="muted group-summary">{{ groups.length }} 组 · {{ matchCount }} 个任务</span>
      <button type="button" class="text-button" :disabled="searching || allCollapsed" @click="collapseAll">全部折叠</button>
      <button type="button" class="text-button" :disabled="searching || !anyCollapsed" @click="expandAll">全部展开</button>
    </template>
  </div>
  <div v-if="!matchCount" class="empty-state tall">
    <div class="empty-symbol"><Folder :size="32" /></div>
    <h3>{{ jobs.length ? '没有匹配的任务' : '尚无备份任务' }}</h3>
    <button v-if="!jobs.length" class="button primary" @click="emit('create')"><Plus :size="16" />新建任务</button>
    <button v-else-if="filterActive" class="button secondary" @click="search = ''; tagFilter = ''; jobFilter = 'all'">清除筛选</button>
  </div>
  <div v-else class="table-wrap jobs-table">
    <table>
      <thead><tr><th>任务 / 来源</th><th>同步目标</th><th>最近执行</th><th>下次执行</th><th>启用</th><th>文件监听</th><th class="action-column">操作</th></tr></thead>
      <tbody v-for="group in groups" :key="group.key" :class="{ 'group-collapsed': isCollapsed(group.key) }">
        <tr v-if="groupMode !== 'none' && groups.length > 1" class="group-row">
          <td colspan="7">
            <button type="button" class="group-toggle" :aria-expanded="!isCollapsed(group.key)" :aria-controls="`job-group-${group.key}`" @click="toggleGroup(group.key)">
              <ChevronRight v-if="isCollapsed(group.key)" :size="16" /><ChevronDown v-else :size="16" />
              <strong>{{ group.label }}</strong>
              <span class="group-count">{{ group.jobs.length }}</span>
              <span v-if="group.failed" class="group-failed">{{ group.failed }} 个失败</span>
            </button>
          </td>
        </tr>
        <template v-if="!isCollapsed(group.key)">
          <tr v-for="job in group.jobs" :key="job.id">
            <td>
              <button class="job-primary" @click="emit('open', job)"><div class="job-symbol" :class="job.type"><Settings2 v-if="job.type === 'system'" :size="20" /><Database v-else-if="job.type === 'vaultwarden'" :size="20" /><Folder v-else :size="20" /></div><div><strong>{{ job.name }}</strong><span class="mono">{{ sourcePath(job) }}</span><span v-if="job.description" :title="job.description">{{ job.description }}</span></div></button>
              <div v-if="job.tags?.length" class="tag-list"><button v-for="tag in job.tags" :key="tag" type="button" class="tag-chip" :class="{ active: tagFilter === tag }" :title="tagFilter === tag ? '取消标签筛选' : `只看标签 ${tag}`" @click="tagFilter = tagFilter === tag ? '' : tag">{{ tag }}</button></div>
            </td>
            <td><div class="target-label" v-for="(destination, index) in job.destinations" :key="index"><HardDrive :size="13" /><span class="mono">{{ destination.remote }}:{{ destination.path }}</span></div><span v-if="!job.destinations.length" class="muted">未配置</span></td>
            <td><span class="status" :class="job.lastRun?.status ?? 'pending'">{{ job.lastRun ? statusLabels[job.lastRun.status] : '尚未执行' }}</span><small class="table-secondary">{{ shortTime(job.lastRun?.createdAt) }}</small></td>
            <td class="nowrap">{{ job.schedule.enabled ? shortTime(job.nextRunAt) : '手动执行' }}</td>
            <td><input class="switch" type="checkbox" :checked="job.enabled" :disabled="busyId === job.id || (job.type === 'system' && !canRunJob(job))" :aria-label="`启用 ${job.name}`" @change="emit('toggle', job)" /></td>
            <td class="nowrap"><template v-if="job.type === 'directory'"><input class="switch" type="checkbox" :checked="job.watch?.enabled ?? false" :disabled="busyId === job.id" :aria-label="`文件监听 ${job.name}`" @change="emit('toggleWatch', job)" /><small v-if="watchLabel(job)" class="table-secondary" :class="{ 'text-danger': overview?.watchStatus?.[job.id]?.state === 'error' }" :title="overview?.watchStatus?.[job.id]?.error ?? undefined">{{ watchLabel(job) }}</small></template><span v-else class="muted">—</span></td>
            <td><div class="row-actions"><button class="icon-button" title="立即备份" aria-label="立即备份" :disabled="busyId === job.id || activeJob(job.id) || !canRunJob(job)" @click="emit('run', job)"><Play :size="17" /></button><button class="icon-button" title="编辑任务" aria-label="编辑任务" @click="emit('edit', job)"><Pencil :size="16" /></button><button v-if="job.type !== 'system'" class="icon-button danger" title="删除任务" aria-label="删除任务" :disabled="activeJob(job.id)" @click="emit('remove', job)"><Trash2 :size="16" /></button></div></td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
