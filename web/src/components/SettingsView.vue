<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { FileText, KeyRound, Mail, RefreshCw, Save, Send, Settings2, ShieldCheck, Trash2 } from 'lucide-vue-next';
import type { LocalStorageStatus, Settings } from '../types';
import { api, errorMessage, write } from '../api';
import { bytes, dateTime } from '../format';
import { defaultSettings } from '../../../shared/contracts.mjs';
import NotificationTemplateEditor from './NotificationTemplateEditor.vue';
const emit = defineEmits<{ saved: []; message: [message: string] }>();
const form = reactive<Settings>(structuredClone(defaultSettings));
const active = ref('smtp');
const sections = [{ id: 'smtp', label: '邮件通知', icon: Mail }, { id: 'template', label: '通知模板', icon: FileText }, { id: 'oidc', label: '授权登录', icon: ShieldCheck }, { id: 'storage', label: '临时文件', icon: Settings2 }];
const recipients = ref('');
const tempGb = ref(10);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const storageStatus = ref<LocalStorageStatus>();
const storageLoading = ref(false);
const clearing = ref('');
const error = ref('');
const storageError = ref('');
const templateSaving = ref(false);
const templateEditor = ref<InstanceType<typeof NotificationTemplateEditor>>();
// Human-readable labels for the variable names reported by the preview API.
// The list itself is owned by server/notify-template.mjs (`TEMPLATE_VARIABLES`),
// so this map only supplies Chinese descriptions and never drives which
// variables are offered.
const templateVariableLabels: Record<string, string> = {
  total: '本次汇总的任务总数',
  successCount: '成功数量',
  warningCount: '有警告的数量',
  failedCount: '失败数量',
  startedAt: '最早开始时间',
  finishedAt: '最后完成时间',
  hostName: '主机名',
  jobName: '任务名称',
  type: '任务类型',
  status: '执行状态',
  durationSec: '耗时（秒）',
  archiveBytes: '归档体积（字节）',
  error: '错误摘要',
  nodeName: '执行节点',
  archiveName: '归档文件名',
};
const callbackUrl = computed(() => `${window.location.origin}/api/auth/oidc/callback`);
/** Older installations store settings without the template field. */
const templateSettings = computed(() => ({
  subject: form.notification.template?.subject ?? '',
  body: form.notification.template?.body ?? '',
}));
async function load() {
  try {
    Object.assign(form, await api<Settings>('/settings'));
    form.storage.successCleanupMode ??= 'immediate';
    form.notification.template ??= { subject: '', body: '' };
    recipients.value = form.smtp.to.join('\n'); tempGb.value = form.storage.maxTempBytes / 1073741824;
  }
  catch (cause) { error.value = errorMessage(cause); }
  finally { loading.value = false; }
  await refreshStorage();
}
async function refreshStorage() {
  storageLoading.value = true; storageError.value = '';
  try { storageStatus.value = await api<LocalStorageStatus>('/storage'); }
  catch (cause) { storageError.value = errorMessage(cause); }
  finally { storageLoading.value = false; }
}
async function clearArchives(runId?: string) {
  if (!window.confirm(runId ? '确认清理这份本地归档？' : '确认清理全部本地保留归档？')) return;
  clearing.value = runId ?? 'all'; error.value = '';
  try {
    await write(`/storage/local-archives${runId ? `/${encodeURIComponent(runId)}` : ''}`, undefined, 'DELETE');
    emit('message', runId ? '本地归档已清理' : '本地归档已全部清理');
    await refreshStorage();
  } catch (cause) { error.value = errorMessage(cause); }
  finally { clearing.value = ''; }
}
async function save(notify = true) {
  error.value = ''; saving.value = true;
  form.smtp.to = recipients.value.split(/[\n,;，；]/).map(item => item.trim()).filter(Boolean);
  form.storage.maxTempBytes = Math.round(tempGb.value * 1073741824);
  try {
    const patch = active.value === 'smtp' ? { smtp: form.smtp } : active.value === 'oidc' ? { oidc: form.oidc } : { storage: form.storage };
    Object.assign(form, await write<Settings>('/settings', patch, 'PATCH'));
    form.smtp.password = ''; form.oidc.clientSecret = '';
    if (active.value === 'storage') await refreshStorage();
    emit('saved'); if (notify) emit('message', '设置已保存'); return true;
  } catch (cause) { error.value = errorMessage(cause); return false; }
  finally { saving.value = false; }
}
async function testEmail() {
  testing.value = true;
  try { if (await save(false)) { await write('/settings/test-email'); emit('message', '测试邮件已发送'); } }
  catch (cause) { error.value = errorMessage(cause); }
  finally { testing.value = false; }
}
/**
 * Persist only `notification.template`. An empty subject/body is meaningful
 * ("use the built-in default"), so the patch is sent verbatim and never merged
 * with the other settings sections.
 */
async function saveTemplate(template: { subject: string; body: string }) {
  templateSaving.value = true;
  try {
    const saved = await write<Settings>('/settings', { notification: { template } }, 'PATCH');
    saved.notification.template ??= { subject: '', body: '' };
    Object.assign(form, saved);
    // The child still owns the draft. Hand it the persisted template explicitly
    // instead of relying on prop propagation timing after a `v-show` remount.
    templateEditor.value?.syncFromSettings(saved.notification.template);
    emit('saved');
    emit('message', template.subject || template.body ? '通知模板已保存' : '已恢复默认通知模板');
  } catch (cause) {
    // The editor keeps its draft so nothing typed is lost.
    templateEditor.value?.showError(cause);
  } finally { templateSaving.value = false; }
}
void load();
</script>

<template>
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="系统设置"><button v-for="section in sections" :key="section.id" :class="{ active: active === section.id }" @click="active = section.id"><component :is="section.icon" :size="18" />{{ section.label }}</button></nav>
    <div class="settings-column">
      <form class="settings-form" novalidate @submit.prevent="save()">
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <div v-if="loading" class="loading-line">正在读取设置…</div>
      <template v-else>
        <section v-show="active === 'smtp'" class="panel settings-panel">
          <div class="panel-heading"><h2>邮件通知</h2><label class="toggle-row"><input v-model="form.smtp.enabled" class="switch" type="checkbox" /><span>{{ form.smtp.enabled ? '已启用' : '未启用' }}</span></label></div>
          <div class="panel-body">
          <div class="form-grid">
            <label class="field">SMTP 主机<input v-model="form.smtp.host" placeholder="smtp.example.com" /></label>
            <label class="field">端口<input v-model.number="form.smtp.port" type="number" min="1" max="65535" /></label>
            <label class="field full">传输安全<select v-model="form.smtp.mode"><option value="starttls">STARTTLS</option><option value="tls">TLS</option><option value="none">无加密</option></select></label>
            <label class="field">用户名<input v-model="form.smtp.username" autocomplete="off" /></label>
            <label class="field">密码<span v-if="form.smtp.passwordSet" class="configured">已设置</span><input v-model="form.smtp.password" type="password" autocomplete="new-password" :placeholder="form.smtp.passwordSet ? '留空保留现有密码' : 'SMTP 密码'" /></label>
            <label class="field full">发件人<input v-model="form.smtp.from" type="email" placeholder="backup@example.com" /></label>
            <label class="field full">收件人<textarea v-model="recipients" rows="3" placeholder="admin@example.com" /></label>
          </div>
          </div>
          <div class="form-actions"><button type="button" class="button secondary" :disabled="testing || saving || !form.smtp.enabled" @click="testEmail"><Send :size="16" />{{ testing ? '发送中…' : '发送测试邮件' }}</button><button class="button primary" :disabled="saving"><Save :size="16" />保存设置</button></div>
        </section>
        <NotificationTemplateEditor v-show="active === 'template'" id="notification-template" ref="templateEditor" :settings="templateSettings" :saving="templateSaving" :labels="templateVariableLabels" @save="saveTemplate" />
        <section v-show="active === 'oidc'" class="panel settings-panel">
          <div class="panel-heading"><h2>OAuth2 / OIDC 登录</h2><label class="toggle-row"><input v-model="form.oidc.enabled" class="switch" type="checkbox" /><span>{{ form.oidc.enabled ? '已启用' : '未启用' }}</span></label></div>
          <div class="panel-body">
          <div class="form-grid">
            <label class="field full">Issuer URL<input v-model="form.oidc.issuer" type="url" placeholder="https://sso.example.com" /></label>
            <label class="field">Client ID<input v-model="form.oidc.clientId" /></label>
            <label class="field">Client Secret<span v-if="form.oidc.clientSecretSet" class="configured">已设置</span><input v-model="form.oidc.clientSecret" type="password" autocomplete="new-password" :placeholder="form.oidc.clientSecretSet ? '留空保留现有密钥' : '客户端密钥'" /></label>
            <label class="field full">管理员 Subject（sub）<input v-model="form.oidc.subject" autocomplete="off" /></label>
            <label class="field full">回调地址<input :value="callbackUrl" readonly class="mono" /></label>
          </div>
          </div>
          <div class="form-actions"><button class="button primary" :disabled="saving"><KeyRound :size="16" />保存设置</button></div>
        </section>
        <section v-show="active === 'storage'" class="panel settings-panel">
          <div class="panel-heading"><h2>临时文件策略</h2></div>
          <div class="panel-body">
          <div class="form-grid">
            <label class="field full">上传成功后的本地归档<select v-model="form.storage.successCleanupMode"><option value="immediate">立即清理</option><option value="manual">手动清理</option></select></label>
            <label class="field">失败文件保留时长（小时）<input v-model.number="form.storage.failedRetentionHours" type="number" min="0" max="168" /></label>
            <label class="field">临时空间上限（GB）<input v-model.number="tempGb" type="number" min="0.001" step="any" /></label>
          </div>
          <div class="form-actions"><button class="button primary" :disabled="saving"><Save :size="16" />保存设置</button></div>
          <div class="local-storage-section panel-sub">
            <div class="panel-heading sub-heading"><h2>临时文件占用</h2><button type="button" class="icon-button" title="刷新占用空间" aria-label="刷新占用空间" :disabled="storageLoading || !!clearing" @click="refreshStorage"><RefreshCw :size="17" :class="{ spinning: storageLoading }" /></button></div>
            <div v-if="storageError" class="notice error" role="alert">{{ storageError }}</div>
            <div v-if="storageStatus" class="property-grid"><div><span>当前占用</span><strong>{{ bytes(storageStatus.tempBytes) }}</strong></div><div><span>空间上限</span><strong>{{ bytes(storageStatus.maxTempBytes) }}</strong></div><div><span>成功归档</span><strong>{{ bytes(storageStatus.retainedBytes) }}</strong></div><div><span>其他临时文件</span><strong>{{ bytes(Math.max(0, storageStatus.tempBytes - storageStatus.retainedBytes)) }}</strong></div></div>
            <div v-else-if="storageLoading" class="loading-line">正在读取空间占用…</div>
            <div class="panel-heading sub-heading local-archives-heading"><h2>本地保留归档 <span class="count">{{ storageStatus?.localArchives.length ?? 0 }}</span></h2><button v-if="storageStatus?.localArchives.length" type="button" class="button secondary small" :disabled="!!clearing" @click="clearArchives()"><Trash2 :size="15" />清理全部</button></div>
            <div v-if="storageStatus && !storageStatus.localArchives.length" class="local-archives-empty">暂无本地保留归档</div>
            <div v-for="archive in storageStatus?.localArchives ?? []" :key="archive.runId" class="local-archive-row"><div><strong>{{ archive.jobName }}</strong><span class="mono">{{ archive.archiveName }}</span><small>{{ dateTime(archive.createdAt) }} · {{ bytes(archive.bytes) }}</small></div><button type="button" class="icon-button danger" title="清理本地归档" :aria-label="`清理本地归档 ${archive.archiveName}`" :disabled="!!clearing" @click="clearArchives(archive.runId)"><Trash2 :size="17" /></button></div>
          </div>
          </div>
        </section>
      </template>
      </form>
    </div>
  </div>
</template>
