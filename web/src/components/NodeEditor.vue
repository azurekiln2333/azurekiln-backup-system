<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Plus, Save, Search, Trash2 } from 'lucide-vue-next';
import { ApiError } from '../api';
import { friendlyError, rawError } from '../errors';
import { normalizeBaseUrl, overrideText } from '../nodes';
import Modal from './Modal.vue';
import type { AppNode, Job, NodeInput } from '../types';

/**
 * Server-node create/edit form.
 *
 * App owns the HTTP write: `save` is passed in and awaited here so a failure
 * keeps the entered values in place. The draft is cloned once on mount, so a
 * background refresh can never replace what the user is typing.
 *
 * Path mapping runs on the server; this editor only collects the from → to
 * prefixes and the per-task source overrides. Nothing here is sent as a
 * client-computed mapping result.
 */
const props = defineProps<{
  node?: AppNode;
  jobs: Job[];
  /** True only after the current /jobs read succeeded; otherwise overrides are unknown, not cleared. */
  jobsLoaded: boolean;
  nodes: AppNode[];
  save: (id: string | undefined, input: NodeInput) => Promise<AppNode>;
}>();
const emit = defineEmits<{ close: []; saved: [node: AppNode] }>();

const form = reactive({
  name: props.node?.name ?? '',
  baseUrl: props.node?.baseUrl ?? '',
  token: '',
  enabled: props.node?.enabled ?? true,
  pathRules: (props.node?.pathRules ?? []).map(rule => ({ from: rule.from, to: rule.to })),
});
const overrides = ref<{ jobId: string; text: string }[]>(
  Object.keys(props.node?.jobOverrides ?? {}).map(jobId => ({ jobId, text: overrideText(props.node as AppNode, jobId) })),
);
const errors = ref<{ name?: string; baseUrl?: string; token?: string; rules?: string }>({});
const error = ref('');
/** Raw low-level text, tooltip only; user-facing copy goes through friendlyError. */
const errorDetail = ref('');
const saving = ref(false);
const jobSearch = ref('');
const overrideDraft = ref('');

const typeLabels: Record<Job['type'], string> = { directory: '目录备份', file: '单文件备份', vaultwarden: 'Vaultwarden', newapi: 'NewAPI', system: '系统配置' };
const jobSource = (job: Job) => job.type === 'system' ? '本系统配置' : job.type === 'vaultwarden' ? job.vaultwarden.dataDir : job.type === 'newapi' ? job.newapi.dataDir : job.sourcePath;
/** The edited node disappeared server-side: keep the draft and warn instead of closing. */
const editedNodeGone = computed(() => Boolean(props.node) && !props.nodes.some(node => node.id === props.node?.id));
const baseUrlPreview = computed(() => normalizeBaseUrl(form.baseUrl));

const visibleJobs = computed(() => {
  const needle = jobSearch.value.trim().toLowerCase();
  if (!needle) return props.jobs;
  return props.jobs.filter(job => [job.name, typeLabels[job.type], jobSource(job)].join(' ').toLowerCase().includes(needle));
});
const overriddenIds = computed(() => new Set(overrides.value.map(entry => entry.jobId)));
const availableJobs = computed(() => visibleJobs.value.filter(job => !overriddenIds.value.has(job.id)));
const jobName = (id: string) => props.jobs.find(job => job.id === id)?.name ?? id;

/**
 * Rules must be absolute paths on both sides: the shared schema rejects a
 * relative prefix, and a silent save failure is worse than a field message.
 */
const absolutePath = (value: string) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value.trim());
const incompleteRules = computed(() => form.pathRules.filter(rule => {
  const from = rule.from.trim();
  const to = rule.to.trim();
  return (from && !to) || (!from && to);
}).length);
const relativeRules = computed(() => form.pathRules.filter(rule => {
  const from = rule.from.trim();
  const to = rule.to.trim();
  return from && to && (!absolutePath(from) || !absolutePath(to));
}).length);
const duplicateRules = computed(() => {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const rule of form.pathRules) {
    const key = rule.from.trim();
    if (!key) continue;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
});

function addRule() { form.pathRules.push({ from: '', to: '' }); }
function removeRule(index: number) { form.pathRules.splice(index, 1); }
function addOverride() {
  const jobId = overrideDraft.value;
  if (!jobId || overriddenIds.value.has(jobId)) return;
  // Prefill with the task's current source so the user edits a real value
  // instead of an empty box the server cannot interpret.
  const job = props.jobs.find(candidate => candidate.id === jobId);
  overrides.value.push({ jobId, text: job ? jobSource(job) : '' });
  overrideDraft.value = '';
}
function removeOverride(jobId: string) { overrides.value = overrides.value.filter(entry => entry.jobId !== jobId); }

/** Map a save failure to actionable Chinese; raw copy stays in the tooltip. */
function nodeFailure(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.code === 'NODE_NOT_FOUND') return '该节点已被删除，请关闭后重新添加。';
    if (cause.code === 'NODE_TOKEN_REQUIRED') return '请填写节点的 API 令牌。';
    if (cause.code === 'NODE_BASE_URL_INVALID' || cause.code === 'VALIDATION_FAILED') return '节点信息未通过校验，请检查名称、地址、令牌与路径规则。';
    if (cause.status === 401 || cause.status === 403) return '节点拒绝了该令牌，请确认令牌仍有效并且有同步权限。';
  }
  return friendlyError(cause, '保存节点失败，请稍后重试');
}

async function save() {
  error.value = '';
  errorDetail.value = '';
  const next: Record<string, string> = {};
  if (!form.name.trim()) next.name = '请输入节点名称。';
  else if (form.name.trim().length > 100) next.name = '节点名称最多 100 个字符。';
  if (!baseUrlPreview.value) next.baseUrl = '请输入 http(s) 地址，例如 https://backup-node.example.com。';
  if (incompleteRules.value) next.rules = `有 ${incompleteRules.value} 条路径规则只填了一半，请补全或删除。`;
  else if (relativeRules.value) next.rules = `有 ${relativeRules.value} 条路径规则不是绝对路径，请填写完整路径。`;
  else if (duplicateRules.value) next.rules = `有 ${duplicateRules.value} 条规则的来源前缀重复，最长前缀优先会让重复项失效。`;
  if (!props.node && !form.token.trim()) next.token = '添加节点需要填写该节点的 API 令牌。';
  errors.value = next;
  if (Object.keys(next).length) return;

  // Blank rows the user added and never filled are dropped instead of stored as
  // rules that can never match.
  const pathRules = form.pathRules
    .map(rule => ({ from: rule.from.trim(), to: rule.to.trim() }))
    .filter(rule => rule.from && rule.to);
  // Overrides are addresses on the node, so they follow the same absolute-path rule.
  const invalidOverrides = overrides.value.filter(entry => entry.text
    .split(/[\r\n]+/).map(line => line.trim()).filter(Boolean)
    .some(line => !absolutePath(line)));
  if (invalidOverrides.length) {
    error.value = `有 ${invalidOverrides.length} 个任务的映射不是绝对路径，请填写完整路径。`;
    return;
  }
  const jobOverrides: Record<string, { sources: string[] }> = {};
  for (const entry of overrides.value) {
    const sources = entry.text.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    if (sources.length) jobOverrides[entry.jobId] = { sources };
  }

  saving.value = true;
  try {
    const saved = await props.save(props.node?.id, {
      name: form.name.trim(),
      baseUrl: baseUrlPreview.value as string,
      ...(form.token.trim() ? { token: form.token.trim() } : {}),
      enabled: form.enabled,
      pathRules,
      jobOverrides,
    });
    emit('saved', saved);
  } catch (cause) {
    error.value = nodeFailure(cause);
    errorDetail.value = rawError(cause);
  }
  finally { saving.value = false; }
}
</script>

<template>
  <Modal :title="node ? `编辑节点 · ${node.name}` : '添加服务器节点'" wide @close="emit('close')">
    <form novalidate @submit.prevent="save">
      <div class="modal-body editor-body">
        <div v-if="error" class="notice error" role="alert" :title="errorDetail || undefined">{{ error }}</div>
        <div v-if="editedNodeGone" class="notice warning" role="status">该节点已在其他位置被删除；当前草稿仍保留，保存会失败，建议关闭后重新添加。</div>
        <div class="form-grid">
          <label class="field">节点名称<input v-model="form.name" maxlength="100" placeholder="例如 香港备份机" aria-label="节点名称" /><small v-if="errors.name" class="field-error">{{ errors.name }}</small></label>
          <label class="check-row"><input v-model="form.enabled" type="checkbox" />启用该节点</label>

          <label class="field full">节点地址
            <input v-model="form.baseUrl" class="mono" placeholder="https://backup-node.example.com" aria-label="节点地址" />
            <small class="field-hint">本系统的另一个实例，例如 <span class="mono">http://10.0.0.12:16323</span>；仅支持 http(s)。<template v-if="form.baseUrl.trim()"> 保存为 <span class="mono">{{ baseUrlPreview || '无法解析' }}</span>。</template></small>
            <small v-if="errors.baseUrl" class="field-error">{{ errors.baseUrl }}</small>
          </label>

          <label class="field full">API 令牌
            <input v-model="form.token" type="password" autocomplete="off" maxlength="200" :placeholder="node?.tokenSet ? '已保存令牌，留空表示不修改' : '粘贴该节点创建的 API 令牌'" aria-label="API 令牌" />
            <small class="field-hint">令牌由服务端加密保存，保存后不再显示。在节点自身的「系统设置 → API 令牌」中创建。</small>
            <small v-if="errors.token" class="field-error">{{ errors.token }}</small>
          </label>

          <div class="field full">
            <span>路径映射规则<template v-if="form.pathRules.length"> · {{ form.pathRules.length }} 条</template></span>
            <div class="domain-editor">
              <div v-for="(rule, index) in form.pathRules" :key="index" class="domain-row node-rule-row">
                <input v-model="rule.from" class="mono" :aria-label="`规则 ${index + 1} 的本机前缀`" placeholder="本机前缀，例如 /www/wwwroot" />
                <span class="node-rule-arrow" aria-hidden="true">→</span>
                <input v-model="rule.to" class="mono" :aria-label="`规则 ${index + 1} 的节点前缀`" placeholder="节点前缀，例如 /srv/websites" />
                <button type="button" class="icon-button danger" :title="`删除规则 ${index + 1}`" :aria-label="`删除规则 ${index + 1}`" @click="removeRule(index)"><Trash2 :size="16" /></button>
              </div>
              <div class="domain-actions">
                <button type="button" class="button secondary small" @click="addRule"><Plus :size="15" />添加规则</button>
                <span class="muted">最长前缀优先；路径风格（<span class="mono">\</span> 或 <span class="mono">/</span>）按来源前缀判断。</span>
              </div>
              <p class="field-hint">没有规则匹配的绝对路径会被标记为「需映射」，该任务整体跳过，避免把错误路径推到节点上。</p>
              <small v-if="errors.rules" class="field-error">{{ errors.rules }}</small>
            </div>
          </div>

          <div class="field full">
            <span>任务级路径映射<template v-if="overrides.length"> · {{ overrides.length }} 个任务</template></span>
            <div v-if="overrides.length" class="node-override-list">
              <div v-for="entry in overrides" :key="entry.jobId" class="node-override">
                <div class="node-override-head"><strong>{{ jobName(entry.jobId) }}</strong><button type="button" class="text-button" @click="removeOverride(entry.jobId)">移除映射</button></div>
                <textarea v-model="entry.text" rows="2" :aria-label="`${jobName(entry.jobId)} 在节点上的源路径`" placeholder="该任务在节点上的源路径，每行一个" />
                <small class="field-hint">覆盖前缀规则；按行填写完整路径，目录任务取第一个路径。</small>
              </div>
            </div>
            <div v-if="!jobsLoaded" class="muted">任务列表尚未成功加载，可稍后再设置任务级映射；保存时服务端仍会校验。</div>
            <template v-else-if="jobs.length">
              <label class="search-field node-job-search"><Search :size="16" /><input v-model="jobSearch" aria-label="搜索可映射任务" placeholder="搜索任务名称、类型或来源" /></label>
              <div class="domain-actions">
                <select v-model="overrideDraft" aria-label="选择要单独映射的任务"><option value="">选择一个任务…</option><option v-for="job in availableJobs" :key="job.id" :value="job.id">{{ job.name }}</option></select>
                <button type="button" class="button secondary small" :disabled="!overrideDraft" @click="addOverride"><Plus :size="15" />添加映射</button>
                <span v-if="!availableJobs.length && jobSearch" class="muted">没有匹配的任务</span>
              </div>
            </template>
            <small v-else class="muted">尚无备份任务。</small>
            <small class="field-hint">只同步任务定义（来源、目标、计划、保留策略），不同步运行记录和密钥类设置。</small>
          </div>
        </div>
      </div>
      <footer class="modal-footer"><button class="button secondary" type="button" @click="emit('close')">取消</button><button class="button primary" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : node ? '保存节点' : '添加节点' }}</button></footer>
    </form>
  </Modal>
</template>
