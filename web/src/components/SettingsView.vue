<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { KeyRound, Mail, Save, Send, Settings2, ShieldCheck } from 'lucide-vue-next';
import type { Settings } from '../types';
import { api, errorMessage, write } from '../api';
import { defaultSettings } from '../../../shared/contracts.mjs';
const emit = defineEmits<{ saved: []; message: [message: string] }>();
const form = reactive<Settings>(structuredClone(defaultSettings));
const active = ref('smtp');
const sections = [{ id: 'smtp', label: '邮件通知', icon: Mail }, { id: 'oidc', label: '授权登录', icon: ShieldCheck }, { id: 'storage', label: '临时文件', icon: Settings2 }];
const recipients = ref('');
const tempGb = ref(10);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const error = ref('');
const callbackUrl = computed(() => `${window.location.origin}/api/auth/oidc/callback`);
async function load() {
  try { Object.assign(form, await api<Settings>('/settings')); recipients.value = form.smtp.to.join('\n'); tempGb.value = form.storage.maxTempBytes / 1073741824; }
  catch (cause) { error.value = errorMessage(cause); }
  finally { loading.value = false; }
}
async function save(notify = true) {
  error.value = ''; saving.value = true;
  form.smtp.to = recipients.value.split(/[\n,;，；]/).map(item => item.trim()).filter(Boolean);
  form.storage.maxTempBytes = Math.round(tempGb.value * 1073741824);
  try {
    const patch = active.value === 'smtp' ? { smtp: form.smtp } : active.value === 'oidc' ? { oidc: form.oidc } : { storage: form.storage };
    Object.assign(form, await write<Settings>('/settings', patch, 'PATCH'));
    form.smtp.password = ''; form.oidc.clientSecret = '';
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
void load();
</script>

<template>
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="系统设置"><button v-for="section in sections" :key="section.id" :class="{ active: active === section.id }" @click="active = section.id"><component :is="section.icon" :size="18" />{{ section.label }}</button></nav>
    <form class="settings-form" novalidate @submit.prevent="save()">
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <div v-if="loading" class="loading-line">正在读取设置…</div>
      <template v-else>
        <section v-show="active === 'smtp'">
          <div class="section-heading"><h2>邮件通知</h2><label class="toggle-row"><input v-model="form.smtp.enabled" class="switch" type="checkbox" /><span>{{ form.smtp.enabled ? '已启用' : '未启用' }}</span></label></div>
          <div class="form-grid">
            <label class="field">SMTP 主机<input v-model="form.smtp.host" placeholder="smtp.example.com" /></label>
            <label class="field">端口<input v-model.number="form.smtp.port" type="number" min="1" max="65535" /></label>
            <label class="field full">传输安全<select v-model="form.smtp.mode"><option value="starttls">STARTTLS</option><option value="tls">TLS</option><option value="none">无加密</option></select></label>
            <label class="field">用户名<input v-model="form.smtp.username" autocomplete="off" /></label>
            <label class="field">密码<span v-if="form.smtp.passwordSet" class="configured">已设置</span><input v-model="form.smtp.password" type="password" autocomplete="new-password" :placeholder="form.smtp.passwordSet ? '留空保留现有密码' : 'SMTP 密码'" /></label>
            <label class="field full">发件人<input v-model="form.smtp.from" type="email" placeholder="backup@example.com" /></label>
            <label class="field full">收件人<textarea v-model="recipients" rows="3" placeholder="admin@example.com" /></label>
          </div>
          <div class="form-actions"><button type="button" class="button secondary" :disabled="testing || saving || !form.smtp.enabled" @click="testEmail"><Send :size="16" />{{ testing ? '发送中…' : '发送测试邮件' }}</button><button class="button primary" :disabled="saving"><Save :size="16" />保存设置</button></div>
        </section>
        <section v-show="active === 'oidc'">
          <div class="section-heading"><h2>OAuth2 / OIDC 登录</h2><label class="toggle-row"><input v-model="form.oidc.enabled" class="switch" type="checkbox" /><span>{{ form.oidc.enabled ? '已启用' : '未启用' }}</span></label></div>
          <div class="form-grid">
            <label class="field full">Issuer URL<input v-model="form.oidc.issuer" type="url" placeholder="https://sso.example.com" /></label>
            <label class="field">Client ID<input v-model="form.oidc.clientId" /></label>
            <label class="field">Client Secret<span v-if="form.oidc.clientSecretSet" class="configured">已设置</span><input v-model="form.oidc.clientSecret" type="password" autocomplete="new-password" :placeholder="form.oidc.clientSecretSet ? '留空保留现有密钥' : '客户端密钥'" /></label>
            <label class="field full">管理员 Subject（sub）<input v-model="form.oidc.subject" autocomplete="off" /></label>
            <label class="field full">回调地址<input :value="callbackUrl" readonly class="mono" /></label>
          </div>
          <div class="form-actions"><button class="button primary" :disabled="saving"><KeyRound :size="16" />保存设置</button></div>
        </section>
        <section v-show="active === 'storage'">
          <div class="section-heading"><h2>临时文件策略</h2></div>
          <div class="form-grid">
            <label class="field">失败文件保留时长（小时）<input v-model.number="form.storage.failedRetentionHours" type="number" min="0" max="168" /></label>
            <label class="field">临时空间上限（GB）<input v-model.number="tempGb" type="number" min="0.001" step="any" /></label>
          </div>
          <div class="property-row"><span>上传成功后的本地归档</span><span class="status succeeded">立即清理</span></div>
          <div class="form-actions"><button class="button primary" :disabled="saving"><Save :size="16" />保存设置</button></div>
        </section>
      </template>
    </form>
  </div>
</template>
