<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowUp, Check, File, Folder, FolderPlus, HardDrive, RefreshCw } from 'lucide-vue-next';
import Modal from './Modal.vue';
import { api, errorMessage, write } from '../api';
import { friendlyError, rawError } from '../errors';

/**
 * Source/remote path picker.
 *
 * `select` is `'directory'` for source directories and remote targets, and
 * `'file'` when a single-file backup is choosing its source: directories still
 * navigate, but only a regular file entry can be confirmed.
 * `initialPath` is the directory to open and `initialFile` is the optional
 * entry to preselect inside it once a listing confirms it is a regular file.
 * They are separate props because in file mode the picker browses the parent
 * directory while the prefilled value is the file itself.
 */
const props = withDefaults(defineProps<{
  kind: 'source' | 'remote';
  remote?: string;
  initialPath?: string;
  initialFile?: string;
  select?: 'directory' | 'file';
}>(), { select: 'directory' });
const emit = defineEmits<{ close: []; select: [path: string] }>();
const path = ref(props.initialPath ?? '');
const roots = ref<string[]>([]);
const entries = ref<{ name: string; path: string; isDirectory: boolean; size?: number | null }[]>([]);
const loading = ref(false);
const error = ref('');
const errorDetail = ref('');
const newDirectory = ref('');
/** Regular-file selection, file mode only. Cleared on every directory read. */
const selectedFile = ref('');
/**
 * The prefilled file is preselected only on the initial open. After that the
 * selection follows the user, so refreshing or navigating away and back never
 * silently re-selects a file the user did not pick.
 */
let preselectPending = Boolean(props.initialFile);
type RemoteEntry = { name: string; path: string };
const remoteUrl = (value: string) => `/rclone/directories?remote=${encodeURIComponent(props.remote ?? '')}&path=${encodeURIComponent(value)}`;
const fileMode = computed(() => props.select === 'file');
async function load(value = path.value) {
  loading.value = true; error.value = ''; errorDetail.value = '';
  // Every read invalidates the previous pick: a file removed from this directory
  // must not stay confirmable, and a different directory must not keep it either.
  selectedFile.value = '';
  try {
    if (props.kind === 'source') {
      const data = await api<{ roots: string[]; path: string | null; entries: { name: string; path: string; isDirectory: boolean; size?: number | null }[] }>(`/sources${value ? `?path=${encodeURIComponent(value)}` : ''}`);
      roots.value = data.roots; path.value = data.path ?? '';
      // File mode needs directories for navigation plus regular files to select; directory mode lists directories only.
      entries.value = data.entries.filter(item => fileMode.value || item.isDirectory);
      // Preselect the prefilled file once, and only when this first listing proves it is still a regular file here.
      const requested = props.initialFile ?? '';
      if (fileMode.value && preselectPending && requested && data.entries.some(entry => !entry.isDirectory && entry.path === requested)) selectedFile.value = requested;
      preselectPending = false;
    } else {
      entries.value = (await api<RemoteEntry[]>(remoteUrl(value))).map(item => ({ ...item, isDirectory: true }));
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
/** Confirming is only meaningful once a regular file is chosen in file mode. */
const confirmPath = computed(() => fileMode.value ? selectedFile.value : path.value);
const canConfirm = computed(() => !loading.value && !error.value && (fileMode.value ? Boolean(selectedFile.value) : (props.kind === 'source' ? Boolean(path.value) : true)));
function confirm() { if (canConfirm.value) emit('select', confirmPath.value); }
void load();
</script>

<template>
  <Modal :title="kind === 'source' ? (fileMode ? '选择源文件' : '选择源目录') : `选择远端目录 · ${remote}`" @close="emit('close')">
    <div class="modal-body picker-body">
      <div v-if="error" class="notice error" role="alert" :title="errorDetail || undefined">
        <span>{{ error }}</span>
        <button class="button secondary small" type="button" @click="load()">重试</button>
      </div>
      <form class="path-toolbar" @submit.prevent="load()">
        <button class="icon-button" type="button" title="上一级" aria-label="上一级" :disabled="(!path && kind === 'remote') || loading" @click="parent"><ArrowUp :size="18" /></button>
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
            <template v-for="entry in entries" :key="entry.path">
              <button v-if="entry.isDirectory" @click="load(entry.path)"><Folder :size="18" /><span>{{ entry.name }}</span></button>
              <button
                v-else
                type="button"
                :class="{ selected: selectedFile === entry.path }"
                :aria-pressed="selectedFile === entry.path"
                :title="entry.path"
                @click="selectedFile = entry.path"
              ><File :size="18" /><span>{{ entry.name }}</span></button>
            </template>
            <div v-if="!entries.length" class="picker-empty">{{ fileMode ? '没有可选择的文件' : '没有子目录' }}</div>
          </div>
        </Transition>
      </div>
      <p v-if="fileMode" class="muted picker-selected" role="status">已选文件：<span class="mono">{{ selectedFile || '未选择' }}</span></p>
      <form v-if="kind === 'remote'" class="path-toolbar" @submit.prevent="mkdir">
        <input v-model="newDirectory" aria-label="新目录名称" placeholder="新目录名称" />
        <button class="button secondary" :disabled="!newDirectory.trim() || loading"><FolderPlus :size="16" />创建</button>
      </form>
    </div>
    <footer class="modal-footer"><button class="button secondary" @click="emit('close')">取消</button><button class="button primary" :disabled="!canConfirm" @click="confirm"><Check :size="16" />{{ fileMode ? '选择此文件' : '选择此目录' }}</button></footer>
  </Modal>
</template>