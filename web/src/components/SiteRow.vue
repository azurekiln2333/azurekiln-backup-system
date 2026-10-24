<script setup lang="ts">
import { computed } from 'vue';
import { Globe, Pencil, Trash2 } from 'lucide-vue-next';
import { siteDomainHostname, siteDomainLink, siteRepositoryLink } from '../../../shared/contracts.mjs';
import { statusLabels } from '../format';
import ProviderMark from './ProviderMark.vue';
import type { Job, Site } from '../types';

/**
 * One compact site row, shared by the site inventory and the overview preview.
 *
 * The identity line always carries the site title plus the *first* saved
 * address's hostname. Only the hostname is visible; the link keeps the complete
 * canonical URL (scheme/port/path/query/fragment) as its href. Every saved
 * address stays editable in SiteEditor — this row never drops stored data.
 *
 * App owns data and mutations, so the row only emits intent.
 */
const props = withDefaults(defineProps<{
  site: Site;
  jobs: Job[];
  /** True only after the current /jobs read succeeded; unresolved links are not deletions. */
  jobsLoaded: boolean;
  /** Current tag filter, so the row can show its own chip as active. */
  tagFilter?: string;
  /** The overview preview is read-only; the inventory keeps edit/delete. */
  showActions?: boolean;
  /** Tags are filter shortcuts in the inventory; the overview preview shows them read-only. */
  filterable?: boolean;
  busy?: boolean;
}>(), { tagFilter: '', showActions: true, filterable: true, busy: false });

const emit = defineEmits<{
  edit: [site: Site];
  remove: [site: Site];
  openJob: [job: Job];
  filterTag: [tag: string];
}>();

const providerLabels = { github: 'GitHub', cnb: 'CNB', gitee: 'Gitee', gitcode: 'GitCode' } as const;
const typeLabels: Record<Job['type'], string> = { directory: '目录备份', file: '单文件备份', vaultwarden: 'Vaultwarden', newapi: 'NewAPI', system: '系统配置' };

interface AddressLink { href: string; host: string }

/**
 * The single displayed address: first saved entry, hostname label, complete href.
 * A legacy value the shared parser rejects stays readable as plain text and is
 * never turned into a fabricated safe-looking link.
 */
const firstAddress = computed<AddressLink | null>(() => {
  const value = (props.site.domains as string[])[0];
  if (!value) return null;
  try {
    const link = siteDomainLink(value) as { href: string; label: string };
    return { href: link.href, host: siteDomainHostname(value) as string };
  } catch {
    return { href: '', host: value };
  }
});

interface RepositoryLink { href: string; provider: keyof typeof providerLabels | null; label: string }

const repositories = computed<RepositoryLink[]>(() => ((props.site.repositoryUrls ?? []) as string[]).map((value): RepositoryLink => {
  try {
    const link = siteRepositoryLink(value) as { href: string; provider: keyof typeof providerLabels; label: string };
    return { href: link.href, provider: link.provider, label: link.label };
  } catch {
    return { href: '', provider: null, label: value };
  }
}));

const jobById = computed(() => new Map(props.jobs.map(job => [job.id, job])));
const linkedJobs = computed(() => (props.site.backupJobIds as string[])
  .map(id => jobById.value.get(id))
  .filter((job): job is Job => Boolean(job)));
/** Saved links the current task list cannot resolve; never silently unbound. */
const unresolvedCount = computed(() => (props.site.backupJobIds as string[]).filter(id => !jobById.value.has(id)).length);
const linkCount = computed(() => (props.site.backupJobIds as string[]).length);

const jobStatus = (job: Job) => job.lastRun ? statusLabels[job.lastRun.status] : job.enabled ? '尚未执行' : '已暂停';
const jobStatusClass = (job: Job) => job.lastRun?.status ?? (job.enabled ? 'pending' : 'disabled');
</script>

<template>
  <article class="site-row" :data-site-id="site.id">
    <div class="site-row-main">
      <div class="site-identity">
        <strong class="site-name" :title="site.name">{{ site.name }}</strong>
        <a
          v-if="firstAddress && firstAddress.href"
          class="site-domain site-host"
          :href="firstAddress.href"
          target="_blank"
          rel="noopener noreferrer"
          :title="firstAddress.href"
          :aria-label="`打开 ${site.name} 的访问地址 ${firstAddress.href}`"
        ><Globe :size="12" aria-hidden="true" />{{ firstAddress.host }}</a>
        <span v-else-if="firstAddress" class="site-domain site-host invalid" :title="firstAddress.host"><Globe :size="12" aria-hidden="true" />{{ firstAddress.host }}</span>
        <span v-else class="site-host-empty">未填写访问地址</span>
      </div>
      <div v-if="repositories.length || site.tags.length" class="site-secondary">
        <span v-if="repositories.length" class="site-repos">
          <template v-for="(repo, index) in repositories" :key="repo.href || index">
            <a
              v-if="repo.href"
              class="site-repo"
              :href="repo.href"
              target="_blank"
              rel="noopener noreferrer"
              :title="repo.href"
              :aria-label="`在 ${providerLabels[repo.provider!]} 打开 ${repo.label}（${repo.href}）`"
            ><ProviderMark v-if="repo.provider" :provider="repo.provider" /><span class="site-repo-label">{{ repo.label }}</span></a>
            <span v-else class="site-repo invalid" :title="repo.label"><span class="site-repo-label">{{ repo.label }}</span></span>
          </template>
        </span>
        <span v-if="site.tags.length" class="tag-list site-tags">
          <template v-for="tag in site.tags" :key="tag">
            <button
              v-if="filterable"
              type="button"
              class="tag-chip"
              :class="{ active: tagFilter === tag }"
              :title="tagFilter === tag ? '取消站点标签筛选' : `只看站点标签 ${tag}`"
              @click="emit('filterTag', tag)"
            >{{ tag }}</button>
            <span v-else class="tag-chip static" :title="`站点标签 ${tag}`">{{ tag }}</span>
          </template>
        </span>
      </div>
      <p v-if="site.notes" class="site-note" :title="site.notes">{{ site.notes }}</p>
    </div>

    <div class="site-jobs">
      <template v-if="jobsLoaded">
        <button v-for="job in linkedJobs" :key="job.id" type="button" class="site-job" :title="`查看任务 ${job.name}`" @click="emit('openJob', job)">
          <span class="site-job-name">{{ job.name }}</span>
          <span class="site-job-type">{{ typeLabels[job.type] }}</span>
          <span class="status" :class="jobStatusClass(job)">{{ jobStatus(job) }}</span>
        </button>
        <span v-if="unresolvedCount" class="site-job unknown" title="当前任务列表里找不到这些关联任务，不会被自动解除">任务信息未同步（{{ unresolvedCount }}）</span>
        <span v-else-if="!linkedJobs.length" class="muted site-jobs-empty">未关联备份任务</span>
      </template>
      <template v-else>
        <span v-if="linkCount" class="site-job pending" title="任务列表尚未成功加载">任务信息待加载（{{ linkCount }}）</span>
        <span v-else class="muted site-jobs-empty">未关联备份任务</span>
      </template>
    </div>

    <div v-if="showActions" class="site-actions">
      <button class="icon-button" type="button" title="编辑站点" aria-label="编辑站点" @click="emit('edit', site)"><Pencil :size="16" /></button>
      <button class="icon-button danger" type="button" title="删除站点" aria-label="删除站点" :disabled="busy" @click="emit('remove', site)"><Trash2 :size="16" /></button>
    </div>
  </article>
</template>
