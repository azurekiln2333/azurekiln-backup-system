<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ArrowUp, ChevronRight, File, Folder, HardDrive, Plus, RefreshCw, Search } from 'lucide-vue-next';
import { api, errorMessage } from '../api';
import { bytes, dateTime } from '../format';
import type { SourceEntry, SourceListing } from '../types';

const emit = defineEmits<{ createJob: [path: string, kind: 'directory' | 'file'] }>();
const roots = ref<string[]>([]);
const currentPath = ref('');
const requestedPath = ref('');
const parentPath = ref<string | null>(null);
const entries = ref<SourceEntry[]>([]);
const total = ref(0);
const page = ref(0);
const search = ref('');
const loading = ref(false);
const error = ref('');
const pageSize = 100;
let requestId = 0;
let searchTimer: number;
let initialLoad = true;

const breadcrumbs = computed(() => {
  if (!requestedPath.value) return [];
  const match = roots.value.map(root => {
    const separator = root.startsWith('/') ? '/' : '\\';
    const base = root.replace(separator === '/' ? /\/+$/ : /\\+$/, '');
    return { root, separator, base };
  }).sort((a, b) => b.base.length - a.base.length)
    .find(({ base, separator }) => requestedPath.value === base || requestedPath.value.startsWith(`${base}${separator}`));
  if (!match) return [];
  const { root, separator, base } = match;
  const parts = requestedPath.value.slice(base.length).split(separator).filter(Boolean);
  return [{ label: root, path: root }, ...parts.map((part, index) => ({ label: part, path: base + separator + parts.slice(0, index + 1).join(separator) }))];
});
const navigationParent = computed(() => requestedPath.value === currentPath.value ? parentPath.value : breadcrumbs.value.at(-2)?.path ?? null);

async function load(target = requestedPath.value, nextPage = page.value) {
  window.clearTimeout(searchTimer);
  const id = ++requestId;
  requestedPath.value = target;
  page.value = nextPage;
  loading.value = true;
  error.value = '';
  if (target !== currentPath.value) { entries.value = []; total.value = 0; }
  try {
    const query = target ? `?path=${encodeURIComponent(target)}&limit=${pageSize}&offset=${nextPage * pageSize}&search=${encodeURIComponent(search.value)}` : '';
    const result = await api<SourceListing>(`/sources${query}`);
    if (id !== requestId) return;
    if (!target && initialLoad) {
      initialLoad = false;
      if (result.roots.length === 1) {
        roots.value = result.roots;
        void load(result.roots[0], 0);
        return;
      }
    }
    roots.value = result.roots;
    const resultTotal = result.total ?? result.entries.length;
    const lastPage = Math.max(0, Math.ceil(resultTotal / pageSize) - 1);
    if (target && nextPage > lastPage) {
      void load(target, lastPage);
      return;
    }
    currentPath.value = result.path ?? '';
    requestedPath.value = currentPath.value;
    parentPath.value = result.parent ?? null;
    entries.value = result.entries;
    total.value = resultTotal;
    page.value = nextPage;
  } catch (cause) {
    if (id === requestId) error.value = errorMessage(cause);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

function open(target: string) {
  initialLoad = false;
  search.value = '';
  void load(target, 0);
}

function searchChanged() {
  window.clearTimeout(searchTimer);
  // Invalidate immediately: a previous response can arrive during the debounce.
  requestId++;
  page.value = 0;
  error.value = '';
  loading.value = !!requestedPath.value;
  if (requestedPath.value) searchTimer = window.setTimeout(() => { void load(requestedPath.value, 0); }, 250);
}
onBeforeUnmount(() => { window.clearTimeout(searchTimer); requestId++; });
void load('', 0);
</script>

<template>
  <section class="panel files-panel">
    <div class="panel-heading files-toolbar">
      <nav class="files-breadcrumbs" aria-label="当前目录">
        <button :class="{ current: !requestedPath }" @click="open('')">挂载目录</button>
        <template v-for="crumb in breadcrumbs" :key="crumb.path">
          <ChevronRight :size="14" />
          <button :class="{ current: crumb.path === requestedPath }" :title="crumb.path" @click="open(crumb.path)">{{ crumb.label }}</button>
        </template>
      </nav>
      <button class="icon-button bordered" title="刷新文件列表" aria-label="刷新文件列表" :disabled="loading" @click="load()"><RefreshCw :size="18" :class="{ spinning: loading }" /></button>
    </div>
    <div class="panel-body files-body">
      <div v-if="error" class="notice error" role="alert">{{ error }}<button class="button secondary small" @click="load()">重试</button></div>
      <div v-if="requestedPath" class="files-actions">
        <div class="files-location"><HardDrive :size="17" /><span class="mono" :title="requestedPath">{{ requestedPath }}</span></div>
        <button class="button secondary small" :disabled="loading || !!error" @click="emit('createJob', requestedPath, 'directory')"><Plus :size="15" />备份此目录</button>
      </div>
      <div class="files-list-toolbar">
        <button class="icon-button bordered" title="上一级" aria-label="上一级" :disabled="!requestedPath" @click="open(navigationParent ?? '')"><ArrowUp :size="18" /></button>
        <label v-if="requestedPath" class="search-field"><Search :size="17" /><input v-model="search" maxlength="200" aria-label="搜索当前目录" placeholder="搜索当前目录" @input="searchChanged" /></label>
        <span class="muted files-count">{{ total }} 项</span>
      </div>
      <div v-if="loading" class="loading-line">正在读取目录…</div>
      <div v-else-if="error" class="empty-state compact"><Folder :size="29" /><h3>无法读取目录</h3></div>
      <div v-else-if="!entries.length" class="empty-state compact"><Folder :size="29" /><h3>{{ search ? '没有匹配的文件' : requestedPath ? '目录为空' : '没有可访问的挂载目录' }}</h3></div>
      <div v-else class="table-wrap files-table"><table>
        <thead><tr><th>名称</th><th>类型</th><th>大小</th><th>修改时间</th><th class="action-column"></th></tr></thead>
        <tbody><tr v-for="entry in entries" :key="entry.path">
        <td><button v-if="entry.isDirectory" class="files-name" :title="entry.path" @click="open(entry.path)"><Folder :size="18" /><span>{{ entry.name }}</span></button><span v-else class="files-name static" :title="entry.path"><File :size="18" /><span>{{ entry.name }}</span></span></td>
        <td class="muted">{{ entry.isDirectory ? '目录' : '文件' }}</td>
        <td class="muted nowrap">{{ entry.isDirectory ? '—' : bytes(entry.size) }}</td>
        <td class="muted nowrap">{{ dateTime(entry.modifiedAt) }}</td>
        <td><button v-if="entry.isDirectory" class="icon-button" title="备份此目录" :aria-label="`备份目录 ${entry.name}`" @click="emit('createJob', entry.path, 'directory')"><Plus :size="17" /></button><button v-else class="icon-button" title="备份此文件" :aria-label="`备份文件 ${entry.name}`" @click="emit('createJob', entry.path, 'file')"><Plus :size="17" /></button></td>
        </tr></tbody>
        </table></div>
    </div>
    <div v-if="requestedPath && !error && total > pageSize" class="pagination"><button class="button secondary small" :disabled="page === 0 || loading" @click="load(requestedPath, page - 1)">上一页</button><span>{{ page + 1 }} / {{ Math.ceil(total / pageSize) }}</span><button class="button secondary small" :disabled="(page + 1) * pageSize >= total || loading" @click="load(requestedPath, page + 1)">下一页</button></div>
  </section>
</template>
