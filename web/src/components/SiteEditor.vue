<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Plus, Save, Search, Trash2 } from 'lucide-vue-next';
import { ApiError } from '../api';
import { friendlyError, rawError } from '../errors';
import {
  SITE_DOMAIN_LIMIT, SITE_DOMAIN_MAX_LENGTH, SITE_NOTES_MAX_LENGTH, SITE_REPOSITORY_LIMIT, SITE_REPOSITORY_MAX_LENGTH,
  siteDomainHostname, siteDomainLink, siteRepositoryLink, siteSchema,
} from '../../../shared/contracts.mjs';
import Modal from './Modal.vue';
import TagInput from './TagInput.vue';
import type { Job, Site, SiteInput } from '../types';

/**
 * Site create/edit form.
 *
 * App owns the HTTP write: `save` is passed in and awaited here so a failure can
 * keep the user's entered values in place and show the API message inline. The
 * draft is cloned once on mount; a background refresh therefore never replaces
 * what the user is typing.
 */
const props = defineProps<{
  site?: Site;
  jobs: Job[];
  /** True only after the current /jobs read succeeded; otherwise links are unknown, not deleted. */
  jobsLoaded: boolean;
  sites: Site[];
  save: (id: string | undefined, input: SiteInput) => Promise<Site>;
}>();
const emit = defineEmits<{ close: []; saved: [site: Site] }>();

const form = reactive({
  name: props.site?.name ?? '',
  domains: [...(props.site?.domains ?? [])],
  tags: [...(props.site?.tags ?? [])],
  repositoryUrls: [...(props.site?.repositoryUrls ?? [])],
  notes: props.site?.notes ?? '',
  backupJobIds: [...(props.site?.backupJobIds ?? [])],
});
const errors = ref<{ name?: string; domains?: string; tags?: string; repositories?: string; notes?: string; jobs?: string }>({});
const error = ref('');
/** Raw low-level text, tooltip only; user-facing copy goes through friendlyError. */
const errorDetail = ref('');
const saving = ref(false);
const jobSearch = ref('');

const typeLabels: Record<Job['type'], string> = { directory: '目录备份', file: '单文件备份', vaultwarden: 'Vaultwarden', newapi: 'NewAPI', system: '系统配置' };
const jobSource = (job: Job) => job.type === 'system' ? '本系统配置' : job.type === 'vaultwarden' ? job.vaultwarden.dataDir : job.type === 'newapi' ? job.newapi.dataDir : job.sourcePath;
const siteTagSuggestions = computed<string[]>(() => [...new Set<string>(props.sites.flatMap(site => site.tags as string[]))].sort((a, b) => a.localeCompare(b, 'zh')));
const otherSites = (jobId: string) => props.sites.filter(site => site.id !== props.site?.id && site.backupJobIds.includes(jobId)).length;

const visibleJobs = computed(() => {
  const needle = jobSearch.value.trim().toLowerCase();
  if (!needle) return props.jobs;
  return props.jobs.filter(job => [job.name, typeLabels[job.type], jobSource(job), job.description].join(' ').toLowerCase().includes(needle));
});
const jobSearchActive = computed(() => Boolean(jobSearch.value.trim()));

/**
 * Selected task IDs the current task list cannot resolve.
 * Only meaningful after a successful /jobs read: an unattempted or failed list
 * must never be reported as "these tasks were deleted".
 */
const staleJobIds = computed(() => props.jobsLoaded ? form.backupJobIds.filter(id => !props.jobs.some(job => job.id === id)) : []);
function removeStaleJobs() {
  form.backupJobIds = form.backupJobIds.filter(id => props.jobs.some(job => job.id === id));
  errors.value = { ...errors.value, jobs: undefined };
  error.value = '';
  errorDetail.value = '';
}
/** The edited site disappeared server-side; keep the draft and warn instead of closing. */
const editedSiteGone = computed(() => Boolean(props.site) && !props.sites.some(site => site.id === props.site?.id));

/** Map a shared-schema issue to actionable Chinese, keyed by the top-level field. */
function fieldMessage(field: string, message: string) {
  if (field === 'name') return '请输入 1-100 个字符的站点名称';
  if (field === 'domains') return message || '地址必须是主机名或 HTTP(S) 地址。';
  if (field === 'tags') return /at most 10/.test(message) ? '最多 10 个标签' : (message || '标签无效。');
  if (field === 'repositoryUrls') return /at most/.test(message) ? `最多 ${SITE_REPOSITORY_LIMIT} 个仓库地址` : (message || '仓库地址无效。');
  if (field === 'notes') return /at most/.test(message) ? `备注最多 ${SITE_NOTES_MAX_LENGTH} 个字符` : (message || '备注无效。');
  if (field === 'backupJobIds') return /at most/.test(message) ? '关联任务过多。' : '关联任务无效。';
  return message || '请检查站点信息。';
}

function toggleJob(id: string) {
  const index = form.backupJobIds.indexOf(id);
  if (index >= 0) form.backupJobIds.splice(index, 1);
  else form.backupJobIds.push(id);
}
function normalizeDomains() { return form.domains.map(value => value.trim()).filter(Boolean); }
function normalizeRepositories() { return form.repositoryUrls.map(value => value.trim()).filter(Boolean); }

/**
 * Full-address preview for the editor only. The list row shows the first
 * hostname, so the editor keeps the complete canonical form visible here.
 */
const addressPreview = computed(() => normalizeDomains().map(value => {
  try {
    return { host: siteDomainHostname(value) as string, full: (siteDomainLink(value) as { href: string }).href };
  } catch {
    return { host: value, full: value };
  }
}));
const firstHostname = computed(() => addressPreview.value[0]?.host ?? '');
const repositoryPreview = computed(() => normalizeRepositories().map(value => {
  try {
    return (siteRepositoryLink(value) as { label: string }).label;
  } catch {
    return value;
  }
}));

/** Localized save copy; site-specific codes get explicit Chinese instead of raw English. */
function siteFailure(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.code === 'SITE_NOT_FOUND') return '该站点已被删除，请关闭后重新创建。';
    if (cause.code === 'VALIDATION_FAILED') return '站点信息未通过校验，请检查名称、地址、仓库和标签。';
  }
  return friendlyError(cause, '保存站点失败，请稍后重试');
}

async function save() {
  error.value = '';
  errorDetail.value = '';
  // Validate the whole site with the same shared schema the API uses; empty
  // address/repository rows are treated as "not filled yet" and dropped.
  const payload = {
    name: form.name,
    domains: normalizeDomains(),
    tags: form.tags,
    repositoryUrls: normalizeRepositories(),
    notes: form.notes,
    backupJobIds: form.backupJobIds,
  };
  const parsed = siteSchema.safeParse(payload);
  if (!parsed.success) {
    const byField: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? '');
      if (!byField[field]) byField[field] = fieldMessage(field, issue.message);
    }
    errors.value = {
      name: byField.name,
      domains: byField.domains,
      tags: byField.tags,
      repositories: byField.repositoryUrls,
      notes: byField.notes,
      jobs: byField.backupJobIds,
    };
    error.value = byField.domains || byField.repositoryUrls || byField.notes || byField.tags || byField.name || byField.backupJobIds || '请检查站点信息。';
    return;
  }
  if (staleJobIds.value.length) {
    // The inline warning already names the action; do not repeat it in the alert.
    errors.value = { jobs: `有 ${staleJobIds.value.length} 个关联任务已被删除，请先移除已删除的关联再保存。` };
    return;
  }
  saving.value = true;
  try {
    const saved = await props.save(props.site?.id, parsed.data as SiteInput);
    emit('saved', saved);
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'SITE_JOB_NOT_FOUND') {
      const count = staleJobIds.value.length;
      error.value = count
        ? `保存失败：有 ${count} 个关联任务已被删除，请点击“移除已删除的关联”后重新保存。`
        : '保存失败：部分关联任务已被删除，请刷新后移除这些关联再保存。';
      errors.value = { jobs: error.value };
    } else {
      error.value = siteFailure(cause);
      errorDetail.value = rawError(cause);
    }
  }
  finally { saving.value = false; }
}
</script>

<template>
  <Modal :title="site ? `编辑站点 · ${site.name}` : '新增站点'" wide @close="emit('close')">
    <form novalidate @submit.prevent="save">
      <div class="modal-body editor-body">
        <div v-if="error" class="notice error" role="alert" :title="errorDetail || undefined">{{ error }}</div>
        <div v-if="staleJobIds.length" class="notice warning" role="status">
          <span>有 {{ staleJobIds.length }} 个关联任务已被删除，保存前请先移除。</span>
          <button type="button" class="text-button" @click="removeStaleJobs">移除已删除的关联</button>
        </div>
        <div v-if="editedSiteGone" class="notice warning" role="status">该站点已在其他位置被删除；当前草稿仍保留，保存会失败，建议关闭后重新创建。</div>
        <div class="form-grid">
          <label class="field full">站点名称<input v-model="form.name" maxlength="100" placeholder="例如 官网" /><small v-if="errors.name" class="field-error">{{ errors.name }}</small></label>

          <div class="field full">
            <span>访问地址</span>
            <div class="domain-editor">
              <div v-for="(domain, index) in form.domains" :key="index" class="domain-row">
                <input v-model="form.domains[index]" :maxlength="SITE_DOMAIN_MAX_LENGTH" :aria-label="`访问地址 ${index + 1}`" placeholder="example.com 或 https://example.com:8443/app" />
                <button type="button" class="icon-button danger" :title="`删除地址 ${index + 1}`" :aria-label="`删除地址 ${index + 1}`" @click="form.domains.splice(index, 1)"><Trash2 :size="16" /></button>
              </div>
              <div class="domain-actions">
                <button type="button" class="button secondary small" :disabled="form.domains.length >= SITE_DOMAIN_LIMIT" @click="form.domains.push('')"><Plus :size="15" />添加地址</button>
                <span class="muted">裸域名默认 https，最多 {{ SITE_DOMAIN_LIMIT }} 个，不能包含账号密码。</span>
              </div>
              <p class="field-hint">列表只显示第一个地址的主机名<template v-if="firstHostname">（<span class="mono">{{ firstHostname }}</span>）</template>，点击仍会打开完整地址；全部地址都会保留。</p>
              <small v-if="errors.domains" class="field-error">{{ errors.domains }}</small>
            </div>
          </div>

          <TagInput v-model="form.tags" :suggestions="siteTagSuggestions" label="站点标签" placeholder="例如 生产，回车添加" />
          <small v-if="errors.tags" class="field-error full">{{ errors.tags }}</small>

          <div class="field full">
            <span>仓库地址</span>
            <div class="domain-editor">
              <div v-for="(repository, index) in form.repositoryUrls" :key="index" class="domain-row">
                <input v-model="form.repositoryUrls[index]" :maxlength="SITE_REPOSITORY_MAX_LENGTH" :aria-label="`仓库地址 ${index + 1}`" placeholder="https://github.com/owner/repo" />
                <button type="button" class="icon-button danger" :title="`删除仓库 ${index + 1}`" :aria-label="`删除仓库 ${index + 1}`" @click="form.repositoryUrls.splice(index, 1)"><Trash2 :size="16" /></button>
              </div>
              <div class="domain-actions">
                <button type="button" class="button secondary small" :disabled="form.repositoryUrls.length >= SITE_REPOSITORY_LIMIT" @click="form.repositoryUrls.push('')"><Plus :size="15" />添加仓库</button>
                <span class="muted">支持 GitHub、CNB、Gitee、GitCode，最多 {{ SITE_REPOSITORY_LIMIT }} 个。</span>
              </div>
              <p v-if="repositoryPreview.length" class="field-hint">将显示：<span class="mono">{{ repositoryPreview.join('、') }}</span></p>
              <small v-if="errors.repositories" class="field-error">{{ errors.repositories }}</small>
            </div>
          </div>

          <label class="field full">备注
            <textarea v-model="form.notes" :maxlength="SITE_NOTES_MAX_LENGTH" rows="3" aria-label="站点备注" placeholder="可选，例如：主站，变更需通知运维" />
            <small class="field-hint">纯文本，最多 {{ SITE_NOTES_MAX_LENGTH }} 个字符；列表只显示一行预览，完整内容在这里查看。</small>
            <small v-if="errors.notes" class="field-error">{{ errors.notes }}</small>
          </label>

          <div class="field full">
            <span>关联备份任务<template v-if="form.backupJobIds.length"> · 已选 {{ form.backupJobIds.length }} 个</template></span>
            <label class="search-field site-job-search"><Search :size="16" /><input v-model="jobSearch" aria-label="搜索可关联任务" placeholder="搜索任务名称、类型或来源" /></label>
            <div v-if="!jobsLoaded" class="muted">任务列表尚未成功加载，可稍后再关联；保存时服务端仍会校验关联任务。</div>
            <div v-else-if="!jobs.length" class="muted">尚无备份任务，可以先保存站点，稍后再关联。</div>
            <div v-else-if="!visibleJobs.length" class="muted">没有匹配的任务{{ jobSearchActive ? '，换个关键词试试' : '' }}。</div>
            <div v-else class="site-job-options">
              <label v-for="job in visibleJobs" :key="job.id" class="check-row site-job-option">
                <input type="checkbox" :checked="form.backupJobIds.includes(job.id)" @change="toggleJob(job.id)" />
                <span class="site-job-option-main"><strong>{{ job.name }}</strong><span class="muted">{{ typeLabels[job.type] }} · {{ jobSource(job) || '未设置来源' }}</span></span>
                <span v-if="otherSites(job.id)" class="count" :title="`还被 ${otherSites(job.id)} 个其他站点关联`">共享 {{ otherSites(job.id) }}</span>
              </label>
            </div>
            <small v-if="errors.jobs" class="field-error">{{ errors.jobs }}</small>
            <small class="muted">关联只是记录站点与任务的关系，不会修改任务的计划、密码、目标或启用状态，也不会把一个任务从其他站点移走。</small>
          </div>
        </div>
      </div>
      <footer class="modal-footer"><button class="button secondary" type="button" @click="emit('close')">取消</button><button class="button primary" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : site ? '保存站点' : '创建站点' }}</button></footer>
    </form>
  </Modal>
</template>
