<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Plus, RefreshCw, Search, Server, Trash2 } from 'lucide-vue-next';
import { dateTime } from '../format';
import { nodeStatusLabel } from '../nodes';
import type { AppNode } from '../types';

/**
 * Server-node inventory.
 *
 * App owns every request, so this view only filters the authoritative list and
 * emits the user's intent. Nodes are links to other installations, never local
 * state: nothing here can change a backup task on this controller.
 */
const props = defineProps<{
  nodes: AppNode[];
  /** True only after /nodes returned successfully, so "empty" is never assumed. */
  loaded: boolean;
  loading: boolean;
  error: string;
  /** Raw low-level text, tooltip only; the body copy is already localized. */
  errorDetail?: string;
  /** Node currently awaiting a response, so only its own buttons spin. */
  busyId: string;
  /** Action in flight for `busyId`, used for the button label. */
  busyAction: '' | 'test' | 'sync';
}>();
const emit = defineEmits<{
  create: [];
  edit: [node: AppNode];
  remove: [node: AppNode];
  test: [node: AppNode];
  sync: [node: AppNode];
  reload: [];
  message: [text: string];
}>();

const search = ref('');
const statusFilter = ref<'' | 'enabled' | 'disabled'>('');

function haystack(node: AppNode) {
  return [node.name, node.baseUrl, ...node.pathRules.flatMap(rule => [rule.from, rule.to])].join(' ').toLowerCase();
}

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return props.nodes.filter(node => {
    if (statusFilter.value === 'enabled' && !node.enabled) return false;
    if (statusFilter.value === 'disabled' && node.enabled) return false;
    return needle ? haystack(node).includes(needle) : true;
  });
});
const filterActive = computed(() => Boolean(search.value.trim()) || statusFilter.value !== '');
function clearFilters() { search.value = ''; statusFilter.value = ''; }

/** Sync counts come from the latest push; a node that never synced has none. */
const counts = (node: AppNode) => {
  const summary = node.lastSync ?? null;
  return {
    total: summary?.total ?? 0,
    synced: summary?.synced ?? 0,
    unmapped: summary?.unmapped ?? 0,
    failed: summary?.failed ?? 0,
  };
};

const expanded = ref<Record<string, boolean>>({});
const toggleExpanded = (node: AppNode) => { expanded.value = { ...expanded.value, [node.id]: !expanded.value[node.id] }; };
const isExpanded = (node: AppNode) => Boolean(expanded.value[node.id]) || counts(node).unmapped > 0 || counts(node).failed > 0;

// A new node list invalidates the expanded rows: an id may have been deleted or
// renamed, so a stale open flag must not keep a stale result table on screen.
watch(() => props.nodes.map(node => `${node.id}:${node.lastSync?.at ?? ''}`).join('|'), () => { expanded.value = {}; });
</script>

<template>
  <section class="panel nodes-panel">
    <div class="panel-heading jobs-toolbar nodes-toolbar">
      <label class="search-field"><Search :size="17" /><input v-model="search" aria-label="搜索服务器节点" placeholder="搜索节点名称、地址或路径规则" /></label>
      <div class="toolbar-filters">
        <div class="filter-group">
          <select v-model="statusFilter" aria-label="按启用状态筛选"><option value="">全部节点</option><option value="enabled">仅已启用</option><option value="disabled">仅已停用</option></select>
        </div>
      </div>
      <span class="muted group-summary">{{ nodes.length }} 个节点 · {{ filtered.length }} 个匹配<template v-if="loading && loaded"> · 正在刷新…</template></span>
    </div>
    <div v-if="error" class="panel-body site-error-body"><div class="notice error" role="alert"><span :title="errorDetail || undefined">{{ error }}</span><button type="button" class="text-button" @click="emit('reload')"><RefreshCw :size="14" />重新读取</button></div></div>
    <div v-if="!loaded && !error" class="loading-line">正在读取服务器节点…</div>
    <div v-else-if="loaded && !nodes.length && !error" class="empty-state tall">
      <div class="empty-symbol"><Server :size="31" /></div>
      <h3>尚无服务器节点</h3>
      <p>节点是另一个本系统的实例，用它的 API 令牌接收任务定义。添加节点后可以把任务推送到它，源路径按节点自己的映射规则转换。</p>
      <button class="button primary" @click="emit('create')"><Plus :size="16" />添加节点</button>
    </div>
    <div v-else-if="nodes.length && !filtered.length" class="empty-state tall">
      <div class="empty-symbol"><Search :size="31" /></div>
      <h3>没有匹配的节点</h3>
      <button v-if="filterActive" class="button secondary" @click="clearFilters">清除筛选</button>
    </div>
    <div v-else-if="nodes.length" class="node-list">
      <article v-for="node in filtered" :key="node.id" class="node-row" :data-node-id="node.id">
        <div class="node-row-main">
          <div class="node-identity">
            <strong class="node-name" :title="node.name">{{ node.name }}</strong>
            <span class="node-base mono" :title="node.baseUrl">{{ node.baseUrl }}</span>
            <span class="status" :class="node.enabled ? 'succeeded' : 'pending'">{{ node.enabled ? '已启用' : '已停用' }}</span>
          </div>
          <div class="node-meta">
            <span class="status" :class="nodeStatusLabel(node).className">{{ nodeStatusLabel(node).label }}</span>
            <span class="muted">最后同步 {{ node.lastSyncAt ? dateTime(node.lastSyncAt) : '从未' }}</span>
            <span v-if="node.pathRules.length" class="muted">· {{ node.pathRules.length }} 条路径规则</span>
            <span v-else class="muted node-warn">· 未配置路径规则</span>
            <span v-if="!node.tokenSet" class="muted node-warn">· 未设置令牌</span>
          </div>
          <div v-if="counts(node).total" class="node-meta">
            <span class="muted">任务 {{ counts(node).total }} 个</span>
            <span class="muted">已同步 {{ counts(node).synced }}</span>
            <span :class="counts(node).unmapped ? 'node-count-warn' : 'muted'">需映射 {{ counts(node).unmapped }}</span>
            <span :class="counts(node).failed ? 'node-count-error' : 'muted'">失败 {{ counts(node).failed }}</span>
            <button v-if="node.lastSync?.jobs?.length" type="button" class="text-button" @click="toggleExpanded(node)">{{ isExpanded(node) ? '收起结果' : '查看结果' }}</button>
          </div>
        </div>
        <div class="node-actions">
          <button class="button secondary small" type="button" :disabled="busyId === node.id" @click="emit('test', node)">{{ busyId === node.id && busyAction === 'test' ? '测试中…' : '测试连接' }}</button>
          <button class="button secondary small" type="button" :disabled="busyId === node.id || !node.enabled" :title="node.enabled ? '按当前规则把任务推送到该节点' : '节点已停用，启用后才能同步'" @click="emit('sync', node)">{{ busyId === node.id && busyAction === 'sync' ? '同步中…' : '立即同步' }}</button>
          <button class="icon-button" type="button" title="编辑节点" aria-label="编辑节点" @click="emit('edit', node)">编辑</button>
          <button class="icon-button danger" type="button" title="删除节点" aria-label="删除节点" :disabled="busyId === node.id" @click="emit('remove', node)"><Trash2 :size="16" /></button>
        </div>
        <div v-if="isExpanded(node) && node.lastSync?.jobs?.length" class="node-sync-results">
          <div v-for="job in node.lastSync.jobs" :key="job.jobId" class="node-sync-row" :data-sync-job="job.jobId">
            <span class="node-sync-name" :title="job.jobName || job.jobId">{{ job.jobName || job.jobId }}</span>
            <span class="status" :class="job.status === 'synced' ? 'succeeded' : job.status === 'unmapped' ? 'queued' : 'failed'">
              {{ job.status === 'synced' ? '已同步' : job.status === 'unmapped' ? '需映射' : '失败' }}
            </span>
            <span v-if="job.paused" class="muted" title="凭据只保存在节点本地，需要在节点上填写后才能执行">已在节点上暂停（需本地填写凭据）</span>
            <span v-if="job.status === 'unmapped' && job.unmapped?.length" class="node-sync-detail mono" :title="job.unmapped.join('\n')">未映射：{{ job.unmapped.join('、') }}</span>
            <span v-else-if="job.message" class="node-sync-detail" :title="job.message">{{ job.message }}</span>
            <span v-else-if="job.sources?.length" class="node-sync-detail mono" :title="job.sources.join('\n')">{{ job.sources.join('、') }}</span>
            <button v-else type="button" class="text-button" @click="emit('edit', node)">为它设置路径映射</button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
