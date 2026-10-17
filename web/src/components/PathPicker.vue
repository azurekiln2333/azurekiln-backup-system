<script setup lang="ts">
import { ref } from 'vue';
import { ArrowUp, Check, Folder, FolderPlus, HardDrive, RefreshCw } from 'lucide-vue-next';
import Modal from './Modal.vue';
import { api, errorMessage, write } from '../api';
import { friendlyError, rawError } from '../errors';
const props = defineProps<{ kind: 'source' | 'remote'; remote?: string; initialPath?: string }>();
const emit = defineEmits<{ close: []; select: [path: string] }>();
const path = ref(props.initialPath ?? '');
const roots = ref<string[]>([]);
const entries = ref<{ name: string; path: string; isDirectory?: boolean }[]>([]);
const loading = ref(false);
const error = ref('');
const errorDetail = ref('');
const newDirectory = ref('');
type RemoteEntry = { name: string; path: string };
const remoteUrl = (value: string) => `/rclone/directories?remote=${encodeURIComponent(props.remote ?? '')}&path=${encodeURIComponent(value)}`;
async function load(value = path.value) {
  loading.value = true; error.value = ''; errorDetail.value = '';
  try {
    if (props.kind === 'source') {
      const data = await api<{ roots: string[]; path: string | null; entries: { name: string; path: string; isDirectory: boolean }[] }>(`/sources${value ? `?path=${encodeURIComponent(value)}` : ''}`);
      roots.value = data.roots; path.value = data.path ?? ''; entries.value = data.entries.filter(item => item.isDirectory);
    } else {
      entries.value = await api<RemoteEntry[]>(remoteUrl(value));
      path.value = value;
    }
  } catch (cause) {
    // A failed read must not also render an "empty directory" state below it.
    entries.value = [];
    error.value = friendlyError(cause, '无法读取目录');
    errorDetail.value = rawError(cause);
  }
  finally { loading.value = false; }
}
function parent() {
  if (props.kind === 'source' && roots.value.includes(path.value)) return load('');
  if (props.kind === 'remote' && !/[\\/]/.test(path.value)) return load('');
  return load(path.value.replace(/[\\/]$/, '').replace(/[\\/][^\\/]*$/, ''));
}
async function mkdir() {
  if (!newDirectory.value.trim()) return;
  try {
    await write('/rclone/directories', { remote: props.remote, path: [path.value, newDirectory.value.trim()].filter(Boolean).join('/') });
    newDirectory.value = ''; await load();
  } catch (cause) { error.value = friendlyError(cause, '新建目录失败'); errorDetail.value = rawError(cause); }
}
void load();
</script>

<template>
  <Modal :title="kind === 'source' ? '选择源目录' : `选择远端目录 · ${remote}`" @close="emit('close')">
    <div class="modal-body picker-body">
      <div v-if="error" class="notice error" role="alert" :title="errorDetail || undefined">
        <span>{{ error }}</span>
        <button class="button secondary small" type="button" @click="load()">重试</button>
      </div>
      <form class="path-toolbar" @submit.prevent="load()">
        <button class="icon-button" type="button" title="上一级" aria-label="上一级" :disabled="!path || loading" @click="parent"><ArrowUp :size="18" /></button>
        <input v-model="path" aria-label="当前目录" placeholder="根目录" :disabled="loading" />
        <button class="icon-button" title="刷新目录" aria-label="刷新目录" :disabled="loading"><RefreshCw :size="18" :class="{ spinning: loading }" /></button>
      </form>
      <div class="directory-list" :aria-busy="loading">
        <Transition name="picker-fade" mode="out-in">
          <div v-if="loading" key="loading" class="picker-loading" role="status"><RefreshCw :size="21" class="spinning" /><span>正在读取目录…</span></div>
          <div v-else-if="kind === 'source' && !path && roots.length" key="roots" class="picker-rows">
            <button v-for="root in roots" :key="root" @click="load(root)"><HardDrive :size="18" /><span class="mono">{{ root }}</span></button>
          </div>
          <div v-else-if="error" key="error" class="picker-empty">无法读取此位置,请返回上一级或重试</div>
          <div v-else key="entries" class="picker-rows">
            <button v-for="entry in entries" :key="entry.path" @click="load(entry.path)"><Folder :size="18" /><span>{{ entry.name }}</span></button>
            <div v-if="!entries.length" class="picker-empty">没有子目录</div>
          </div>
        </Transition>
      </div>
      <form v-if="kind === 'remote'" class="path-toolbar" @submit.prevent="mkdir">
        <input v-model="newDirectory" aria-label="新目录名称" placeholder="新目录名称" />
        <button class="button secondary" :disabled="!newDirectory.trim() || loading"><FolderPlus :size="16" />创建</button>
      </form>
    </div>
    <footer class="modal-footer"><button class="button secondary" @click="emit('close')">取消</button><button class="button primary" :disabled="loading || !!error || (kind === 'source' && !path)" @click="emit('select', path)"><Check :size="16" />选择此目录</button></footer>
  </Modal>
</template>
