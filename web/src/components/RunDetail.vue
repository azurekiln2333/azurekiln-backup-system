<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { CircleStop, Download, RefreshCw } from 'lucide-vue-next';
import type { Run } from '../types';
import { api, errorMessage, write } from '../api';
import { bytes, dateTime, duration, phaseLabels, progress, statusLabels } from '../format';
import Modal from './Modal.vue';
const props = defineProps<{ id: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const run = ref<Run>();
const error = ref('');
const loading = ref(false);
const cancelling = ref(false);
const percent = computed(() => run.value ? progress(run.value) : null);
const archiveWritten = computed(() => run.value?.progress && typeof run.value.progress === 'object' ? run.value.progress.bytes : undefined);
const progressStep = computed(() => run.value?.progress && typeof run.value.progress === 'object' ? run.value.progress.step : undefined);
const progressUpdateTime = computed(() => {
  const value = run.value?.progress;
  return value && typeof value === 'object' && value.updatedAt ? new Date(value.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
});
const active = computed(() => ['queued', 'running'].includes(run.value?.status ?? ''));
const settling = computed(() => !!run.value && (active.value || !run.value.finishedAt || run.value.notificationStatus === 'pending' || run.value.cleanupStatus === 'pending'));
async function load() {
  loading.value = true;
  try { run.value = await api(`/runs/${props.id}`); error.value = ''; }
  catch (cause) { error.value = errorMessage(cause); }
  finally { loading.value = false; }
}
async function cancel() {
  cancelling.value = true;
  try { await write(`/runs/${props.id}/cancel`); await load(); emit('changed'); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { cancelling.value = false; }
}
const timer = window.setInterval(() => { if (settling.value) void load(); }, 1000);
onBeforeUnmount(() => window.clearInterval(timer));
void load();
</script>

<template>
  <Modal :title="run ? `执行详情 · ${run.jobName}` : '执行详情'" wide @close="emit('close')">
    <div class="modal-body run-detail">
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <div v-if="!run" class="loading-line">正在读取执行记录…</div>
      <template v-else>
        <div class="run-title"><span class="status" :class="run.status"><i />{{ statusLabels[run.status] }}</span><span>{{ phaseLabels[run.phase] || run.phase }}</span><div class="run-actions"><button v-if="active" class="button secondary small" :disabled="cancelling" @click="cancel"><CircleStop :size="15" />取消执行</button><button class="icon-button" title="刷新记录" aria-label="刷新记录" :disabled="loading" @click="load"><RefreshCw :size="17" :class="{ spinning: loading }" /></button></div></div>
        <div v-if="active" class="progress-bar" :class="{ indeterminate: percent === null, archiving: run.phase === 'archiving' || run.phase === 'preparing' }"><span :style="{ width: percent === null ? '35%' : `${percent}%` }" /></div>
        <div v-if="active && (run.phase === 'archiving' || run.phase === 'preparing')" class="progress-detail"><span>{{ progressStep || (run.phase === 'archiving' ? '正在压缩' : '正在准备数据') }}<template v-if="percent !== null"> {{ Math.floor(percent) }}%</template></span><span v-if="archiveWritten !== undefined || progressUpdateTime"><template v-if="archiveWritten !== undefined">已写入 {{ bytes(archiveWritten) }}<template v-if="progressUpdateTime"> · </template></template><template v-if="progressUpdateTime">更新于 {{ progressUpdateTime }}</template></span></div>
        <div class="property-grid run-properties"><div><span>开始时间</span><strong>{{ dateTime(run.startedAt ?? run.createdAt) }}</strong></div><div><span>耗时</span><strong>{{ duration(run) }}</strong></div><div><span>归档大小</span><strong>{{ bytes(run.archiveBytes) }}</strong></div><div><span>触发方式</span><strong>{{ run.trigger === 'manual' ? '手动执行' : run.trigger === 'schedule' ? '定时计划' : run.trigger === 'watch' ? '文件监听' : run.trigger }}</strong></div><div v-if="run.backupKind"><span>备份方式</span><strong>{{ run.backupKind === 'incremental' ? '增量' : '完整' }}</strong></div><div v-if="run.changes"><span>变化文件</span><strong>新增 {{ run.changes.added }} · 修改 {{ run.changes.modified }} · 删除 {{ run.changes.deleted }}</strong></div><div><span>本地清理</span><strong>{{ statusLabels[run.cleanupStatus ?? ''] ?? run.cleanupStatus ?? '—' }}</strong></div><div><span>邮件通知</span><strong>{{ statusLabels[run.notificationStatus ?? ''] ?? run.notificationStatus ?? '—' }}</strong></div></div>
        <div v-if="run.error" class="notice error">{{ run.error }}</div>
        <div v-for="warning in run.warnings" :key="warning" class="notice warning">{{ warning }}</div>
        <div v-if="run.changes?.sample.length" class="skipped-assets"><span class="muted">变化文件</span><span v-for="item in run.changes.sample" :key="item" class="mono">{{ item }}</span><span v-if="run.changes.added + run.changes.modified > run.changes.sample.length" class="muted">等 {{ run.changes.added + run.changes.modified }} 个</span></div>
        <div v-if="run.skipped?.length" class="skipped-assets"><span class="muted">已跳过</span><span v-for="item in run.skipped" :key="item" class="mono">{{ item }}</span></div>
        <h3 class="form-heading separated">同步目标</h3>
        <div v-if="!run.targets?.length" class="muted">尚无同步结果</div>
        <div v-for="(target, index) in run.targets" :key="index" class="target-row"><div><strong class="mono">{{ target.remote }}:{{ target.path ?? target.remotePath }}</strong><span v-if="target.verification" class="muted">{{ target.verification }}</span><span v-if="target.error" class="text-danger">{{ target.error }}</span></div><span class="status" :class="target.status">{{ statusLabels[target.status] ?? target.status }}</span><a v-if="target.status === 'verified'" class="icon-button" title="下载归档" aria-label="下载归档" :href="`/api/jobs/${run.jobId}/archives/${run.id}/download?destinationId=${encodeURIComponent(target.destinationId ?? '')}`"><Download :size="17" /></a></div>
        <h3 class="form-heading separated">执行日志</h3>
        <div class="log-view" tabindex="0"><div v-for="log in run.logs" :key="log.id" class="log-line"><time>{{ dateTime(log.at) }}</time><span :class="`log-${log.level}`">{{ log.level.toUpperCase() }}</span><p>{{ log.message }}</p></div><span v-if="!run.logs?.length" class="muted">暂无日志</span></div>
      </template>
    </div>
    <footer class="modal-footer"><button class="button secondary" @click="emit('close')">关闭</button></footer>
  </Modal>
</template>
