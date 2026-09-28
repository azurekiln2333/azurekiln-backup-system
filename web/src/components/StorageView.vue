<script setup lang="ts">
import { reactive, ref } from 'vue';
import { Check, FileInput, FolderOpen, HardDrive, RefreshCw, Save, Server } from 'lucide-vue-next';
import type { Remote, RcloneStatus, Settings } from '../types';
import { api, errorMessage, write } from '../api';
import PathPicker from './PathPicker.vue';
const emit = defineEmits<{ message: [message: string] }>();
const status = ref<RcloneStatus>({ available: false, configured: false });
const remotes = ref<Remote[]>([]);
const sourcePath = ref('');
const configPassword = ref('');
const error = ref('');
const loading = ref(true);
const importing = ref(false);
const inspecting = ref<Remote | null>(null);
const testRemote = reactive({ remote: '', path: '' });
const testing = ref(false);
async function load() {
  loading.value = true; error.value = '';
  try {
    const [tool, config] = await Promise.all([api<RcloneStatus>('/rclone/status'), api<Settings>('/settings')]);
    status.value = tool; sourcePath.value = config.rclone.sourceConfigPath;
    if (tool.available && tool.configured) remotes.value = await api('/rclone/remotes');
    else remotes.value = [];
  } catch (cause) { error.value = errorMessage(cause); }
  finally { loading.value = false; }
}
async function importConfig() {
  error.value = ''; importing.value = true;
  try {
    await write('/rclone/import', {
      ...(sourcePath.value ? { sourceConfigPath: sourcePath.value } : {}),
      ...(configPassword.value ? { configPassword: configPassword.value } : {}),
    });
    configPassword.value = ''; emit('message', 'rclone 配置已导入'); await load();
  } catch (cause) { error.value = errorMessage(cause); }
  finally { importing.value = false; }
}
async function saveImportPath() {
  try { await write('/settings', { rclone: { sourceConfigPath: sourcePath.value } }, 'PATCH'); emit('message', '导入路径已保存'); await load(); }
  catch (cause) { error.value = errorMessage(cause); }
}
async function testConnection() {
  error.value = ''; testing.value = true;
  try { await write('/rclone/test', testRemote); emit('message', `${testRemote.remote} 连接正常`); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { testing.value = false; }
}
void load();
</script>

<template>
  <div v-if="error" class="notice error" role="alert">{{ error }}</div>
  <section class="storage-config">
    <div class="section-heading"><h2><Server :size="19" />rclone 配置</h2><button class="icon-button" title="刷新存储状态" aria-label="刷新存储状态" :disabled="loading" @click="load"><RefreshCw :size="18" :class="{ spinning: loading }" /></button></div>
    <div class="property-grid"><div><span>工具状态</span><strong :class="status.available ? 'text-success' : 'text-warning'">{{ loading ? '检测中' : status.available ? '可用' : '未安装' }}</strong></div><div><span>配置状态</span><strong>{{ status.configured ? '已导入' : '未配置' }}</strong></div><div><span>版本</span><strong>{{ status.version || '—' }}</strong></div><div><span>系统配置路径</span><strong class="mono">{{ status.configPath || '—' }}</strong></div></div>
    <div v-if="status.error" class="notice warning">{{ status.error }}</div>
    <form class="form-grid" @submit.prevent="importConfig">
      <label class="field full">现有 rclone 配置文件路径<input v-model="sourcePath" placeholder="/config/rclone.conf" /></label>
      <label class="field full">源配置解密密码<input v-model="configPassword" type="password" autocomplete="new-password" placeholder="未加密的配置可留空" /></label>
      <div class="form-actions full"><button type="button" class="button secondary" :disabled="importing" @click="saveImportPath"><Save :size="16" />保存路径</button><button class="button primary" :disabled="importing || !status.available"><FileInput :size="16" />{{ importing ? '导入中…' : '导入 rclone 配置' }}</button></div>
    </form>
  </section>
  <section class="page-band">
    <div class="section-heading"><h2>远端存储 <span class="count">{{ remotes.length }}</span></h2></div>
    <div v-if="!remotes.length" class="empty-state compact"><HardDrive :size="30" /><h3>尚无远端存储</h3><p>{{ status.available ? '未读取到 rclone 远端' : 'rclone 不可用' }}</p></div>
    <div v-else class="remote-grid">
      <article v-for="remote in remotes" :key="remote.name" class="remote-item"><div class="remote-symbol"><HardDrive :size="24" /></div><div class="remote-meta"><h3>{{ remote.name }}</h3><span>{{ remote.type }}</span></div><button class="icon-button" title="浏览远端目录" aria-label="浏览远端目录" @click="inspecting = remote"><FolderOpen :size="19" /></button></article>
    </div>
  </section>
  <section v-if="remotes.length" class="page-band connection-form">
    <div class="section-heading"><h2>连接测试</h2></div>
    <form class="form-grid" @submit.prevent="testConnection"><label class="field">远端<select v-model="testRemote.remote" required><option value="" disabled>选择远端</option><option v-for="remote in remotes" :key="remote.name">{{ remote.name }}</option></select></label><label class="field">目录<input v-model="testRemote.path" placeholder="根目录" /></label><div class="form-actions full"><button class="button secondary" :disabled="testing || !testRemote.remote"><Check :size="16" />{{ testing ? '测试中…' : '测试连接' }}</button></div></form>
  </section>
  <PathPicker v-if="inspecting" kind="remote" :remote="inspecting.name" @close="inspecting = null" @select="path => { testRemote.remote = inspecting?.name ?? ''; testRemote.path = path; inspecting = null; }" />
</template>
