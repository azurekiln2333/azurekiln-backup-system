<script setup lang="ts">
import { computed, reactive, ref, toRaw, watch } from 'vue';
import { Database, Eye, EyeOff, Folder, FolderOpen, HardDrive, LockKeyhole, Plus, Save, Trash2 } from 'lucide-vue-next';
import { jobSchema, newJob } from '../../../shared/contracts.mjs';
import type { Job, JobInput, Remote } from '../types';
import { api, errorMessage, write } from '../api';
import Modal from './Modal.vue';
import PathPicker from './PathPicker.vue';
const props = defineProps<{ job?: Job; initialType?: 'directory' | 'vaultwarden'; initialSourcePath?: string }>();
const emit = defineEmits<{ close: []; saved: [job: Job] }>();
const form = reactive<JobInput>(structuredClone(props.job ? toRaw(props.job) : newJob(props.initialType ?? 'directory')));
form.archive.folderTemplate ??= '{datetime}';
form.archive.fileTemplate ??= '{task}';
form.archive.method ??= 'lzma2';
form.archive.threads ??= 0;
form.archive.dictionaryMiB ??= 0;
if (!props.job && props.initialSourcePath) form.sourcePath = props.initialSourcePath;
const tabs = ['基本信息', '目标位置', '压缩与保留', '计划与通知'];
const tab = ref(0);
const error = ref('');
const errorTab = ref(0);
const saving = ref(false);
const remotes = ref<Remote[]>([]);
const remoteError = ref('');
const excludes = ref(form.excludes.join('\n'));
const sourcePicker = ref<'sourcePath' | 'dataDir' | 'attachmentsPath' | 'sendsPath' | null>(null);
const destinationPicker = ref<number | null>(null);
const showArchivePassword = ref(false);
const timezones = [...new Set(['Asia/Shanghai', 'UTC', ...Intl.supportedValuesOf('timeZone'), form.schedule.timezone])];
const cronPresets = [
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每小时整点', cron: '0 * * * *' },
  { label: '每 6 小时', cron: '0 */6 * * *' },
  { label: '每天 03:00', cron: '0 3 * * *' },
  { label: '每天 09:00', cron: '0 9 * * *' },
  { label: '每周一 03:00', cron: '0 3 * * 1' },
  { label: '每月 1 日 03:00', cron: '0 3 1 * *' },
];
const cronPreset = computed({
  get: () => cronPresets.find(preset => preset.cron === form.schedule.cron)?.cron ?? '',
  set: (value: string) => { form.schedule.cron = value; },
});
const archivePasswordSet = computed(() => props.job?.archive.passwordSet ?? false);
const dbPasswordSet = computed(() => props.job?.vaultwarden.database.passwordSet ?? false);
watch(form, () => { error.value = ''; }, { deep: true, flush: 'sync' });
watch(excludes, () => { error.value = ''; });
watch(() => form.archive.encrypted, enabled => { if (enabled && form.archive.format === 'tar.gz') form.archive.format = '7z'; });
watch(() => form.vaultwarden.dbType, type => { form.vaultwarden.database.port = type === 'postgresql' ? 5432 : type === 'mysql' ? 3306 : undefined; });
async function loadRemotes() {
  try { remotes.value = await api('/rclone/remotes'); remoteError.value = ''; }
  catch (cause) { remoteError.value = errorMessage(cause); }
}
function selectSource(path: string) {
  if (sourcePicker.value === 'sourcePath') form.sourcePath = path;
  else if (sourcePicker.value) form.vaultwarden[sourcePicker.value] = path;
  sourcePicker.value = null;
}
function addDestination() { form.destinations.push({ remote: '', path: '' }); }
function showError(message: string, targetTab = tab.value) {
  tab.value = targetTab;
  errorTab.value = targetTab;
  error.value = message;
}
async function save() {
  error.value = '';
  form.excludes = excludes.value.split('\n').map(value => value.trim()).filter(Boolean);
  if (!form.name.trim()) { showError('请输入任务名称', 0); return; }
  if (form.type === 'directory' && !form.sourcePath.trim()) { showError('请选择源目录', 0); return; }
  if (form.type === 'vaultwarden' && !form.vaultwarden.dataDir.trim()) { showError('请选择 Vaultwarden 数据目录', 0); return; }
  if (form.type === 'vaultwarden' && form.vaultwarden.dbType !== 'sqlite' && (!form.vaultwarden.database.host.trim() || !form.vaultwarden.database.name.trim() || !form.vaultwarden.database.username.trim())) { showError('请填写数据库主机、数据库名称和用户名', 0); return; }
  if (!form.destinations.length && (form.type !== 'system' || form.enabled)) { showError('请添加备份目标', 1); return; }
  if (form.destinations.some(item => !item.remote)) { showError('请选择每个目标的 rclone 远端', 1); return; }
  if (form.archive.encrypted && !form.archive.password && !archivePasswordSet.value && (form.type !== 'system' || form.enabled)) { showError('请输入压缩包密码', 2); return; }
  const parsed = jobSchema.safeParse(form);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const targetTab = field === 'destinations' ? 1 : ['archive', 'retention', 'retry'].includes(String(field)) ? 2 : ['schedule', 'notification'].includes(String(field)) ? 3 : 0;
    showError(parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；'), targetTab);
    return;
  }
  saving.value = true;
  try { emit('saved', await write<Job>(props.job ? `/jobs/${props.job.id}` : '/jobs', parsed.data, props.job ? 'PATCH' : 'POST')); }
  catch (cause) { showError(errorMessage(cause)); }
  finally { saving.value = false; }
}
void loadRemotes();
</script>

<template>
  <Modal :title="job ? `编辑任务 · ${job.name}` : '新建备份任务'" wide @close="emit('close')">
    <form novalidate @submit.prevent="save">
      <nav class="dialog-tabs" aria-label="任务设置"><button v-for="(label, index) in tabs" :key="label" type="button" :class="{ active: tab === index }" @click="tab = index">{{ label }}</button></nav>
      <div class="modal-body editor-body">
        <div v-if="error && tab === errorTab" class="notice error" role="alert">{{ error }}</div>
        <section v-show="tab === 0" class="form-section">
          <div class="form-grid">
            <label class="field full">任务名称<input v-model="form.name" maxlength="100" placeholder="任务名称" /></label>
            <label class="field full">任务描述<textarea v-model="form.description" maxlength="500" rows="3" placeholder="可选" /></label>
            <div v-if="form.type !== 'system'" class="field full"><span>备份类型</span><div class="segmented"><button type="button" :class="{ active: form.type === 'directory' }" @click="form.type = 'directory'"><Folder :size="17" />目录</button><button type="button" :class="{ active: form.type === 'vaultwarden' }" @click="form.type = 'vaultwarden'"><Database :size="17" />Vaultwarden</button></div></div>
            <label v-if="form.type === 'directory'" class="field full">源目录<div class="input-action"><input v-model="form.sourcePath" placeholder="/sources/data" /><button type="button" class="icon-button" title="浏览源目录" aria-label="浏览源目录" @click="sourcePicker = 'sourcePath'"><FolderOpen :size="18" /></button></div></label>
            <template v-else-if="form.type === 'vaultwarden'">
              <label class="field full">Vaultwarden 数据目录<div class="input-action"><input v-model="form.vaultwarden.dataDir" placeholder="/sources/vaultwarden" /><button type="button" class="icon-button" title="浏览数据目录" aria-label="浏览数据目录" @click="sourcePicker = 'dataDir'"><FolderOpen :size="18" /></button></div></label>
              <label class="field full">数据库类型<select v-model="form.vaultwarden.dbType"><option value="sqlite">SQLite</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option></select></label>
              <label v-if="form.vaultwarden.dbType === 'sqlite'" class="field full">SQLite 文件<input v-model="form.vaultwarden.sqlitePath" placeholder="默认：数据目录/db.sqlite3" /></label>
              <template v-else>
                <label class="field">数据库主机<input v-model="form.vaultwarden.database.host" placeholder="数据库主机" /></label>
                <label class="field">端口<input v-model.number="form.vaultwarden.database.port" type="number" min="1" max="65535" /></label>
                <label class="field">数据库名称<input v-model="form.vaultwarden.database.name" /></label>
                <label class="field">用户名<input v-model="form.vaultwarden.database.username" autocomplete="off" /></label>
                <label class="field">数据库密码<span v-if="dbPasswordSet" class="configured">已设置</span><input v-model="form.vaultwarden.database.password" type="password" autocomplete="new-password" :placeholder="dbPasswordSet ? '留空保留现有密码' : '数据库密码'" /></label>
                <label class="field">TLS 模式<select v-model="form.vaultwarden.database.sslMode"><option value="default">默认</option><option value="disable">禁用</option><option value="require">{{ form.vaultwarden.dbType === 'mysql' ? '要求 TLS 并校验证书' : '要求 TLS' }}</option><option value="verify-ca">验证 CA</option><option value="verify-full">完整验证</option></select></label>
                <label class="field full">CA 证书路径<input v-model="form.vaultwarden.database.sslCa" placeholder="可选" /></label>
                <label class="field">客户端证书路径<input v-model="form.vaultwarden.database.sslCert" placeholder="可选" /></label>
                <label class="field">客户端密钥路径<input v-model="form.vaultwarden.database.sslKey" placeholder="可选" /></label>
              </template>
              <label class="field full">RSA 密钥路径前缀<input v-model="form.vaultwarden.rsaKeyPath" placeholder="默认：数据目录/rsa_key" /></label>
              <label class="field">附件目录<div class="input-action"><input v-model="form.vaultwarden.attachmentsPath" placeholder="默认：数据目录/attachments" /><button type="button" class="icon-button" title="浏览附件目录" aria-label="浏览附件目录" @click="sourcePicker = 'attachmentsPath'"><FolderOpen :size="18" /></button></div></label>
              <label class="field">Sends 目录<div class="input-action"><input v-model="form.vaultwarden.sendsPath" placeholder="默认：数据目录/sends" /><button type="button" class="icon-button" title="浏览 Sends 目录" aria-label="浏览 Sends 目录" @click="sourcePicker = 'sendsPath'"><FolderOpen :size="18" /></button></div></label>
            </template>
            <div v-else class="field full"><span>备份内容</span><strong>系统状态、加密密钥、rclone 配置</strong></div>
            <label v-if="form.type !== 'system'" class="field full">排除规则<textarea v-model="excludes" rows="3" placeholder="*.log&#10;cache/**" /></label>
            <label class="check-row full"><input v-model="form.enabled" type="checkbox" />启用任务</label>
          </div>
        </section>
        <section v-show="tab === 1" class="form-section">
          <div class="section-heading"><h3>同步目标</h3><button class="button secondary small" type="button" :disabled="form.destinations.length >= 10" @click="addDestination"><Plus :size="16" />添加目标</button></div>
          <div v-if="remoteError" class="notice warning">{{ remoteError }}<button type="button" class="text-button" @click="loadRemotes">重新读取</button></div>
          <div v-for="(destination, index) in form.destinations" :key="index" class="destination-editor">
            <div class="destination-title"><span><HardDrive :size="16" />目标 {{ index + 1 }}</span><button class="icon-button danger" type="button" title="删除目标" aria-label="删除目标" :disabled="form.destinations.length === 1" @click="form.destinations.splice(index, 1)"><Trash2 :size="16" /></button></div>
            <div class="form-grid">
              <label class="field">rclone 远端<select v-model="destination.remote"><option value="" disabled>选择远端</option><option v-for="remote in remotes" :key="remote.name" :value="remote.name">{{ remote.name }} · {{ remote.type }}</option><option v-if="destination.remote && !remotes.some(remote => remote.name === destination.remote)" :value="destination.remote">{{ destination.remote }}</option></select></label>
              <label class="field">保存目录<div class="input-action"><input v-model="destination.path" placeholder="backups" /><button class="icon-button" type="button" title="浏览远端目录" aria-label="浏览远端目录" :disabled="!destination.remote" @click="destinationPicker = index"><FolderOpen :size="18" /></button></div></label>
            </div>
          </div>
        </section>
        <section v-show="tab === 2" class="form-section">
          <h3 class="form-heading"><LockKeyhole :size="17" />压缩设置</h3>
          <div class="form-grid">
            <label v-if="form.type !== 'system'" class="field">压缩格式<select v-model="form.archive.format"><option value="tar.gz" :disabled="form.archive.encrypted">tar.gz</option><option value="7z">7z</option><option value="zip">ZIP</option></select></label>
            <div v-else class="field"><span>压缩格式</span><strong>7z · AES-256</strong></div>
            <label class="field">压缩级别<div class="range-row"><input v-model.number="form.archive.level" type="range" min="0" max="9" /><output>{{ form.archive.level }}</output></div></label>
            <label v-if="form.archive.format === '7z'" class="field">压缩算法<select v-model="form.archive.method" :disabled="form.archive.level === 0"><option value="lzma2">LZMA2</option><option value="lzma">LZMA</option></select></label>
            <label v-if="form.archive.format === '7z'" class="field">压缩线程<select v-model.number="form.archive.threads" :disabled="form.archive.level === 0"><option :value="0">自动（7–9 级为 1 线程）</option><option v-for="count in 8" :key="count" :value="count">{{ count }} 线程</option></select></label>
            <label v-if="form.archive.format === '7z'" class="field">字典大小<select v-model.number="form.archive.dictionaryMiB" :disabled="form.archive.level === 0"><option :value="0">自动（7–9 级为 32 MiB）</option><option v-for="size in [8, 16, 32, 64, 128, 256]" :key="size" :value="size">{{ size }} MiB</option></select></label>
            <label class="field">版本文件夹名（含 {datetime}）<input v-model="form.archive.folderTemplate" maxlength="100" placeholder="{datetime}" title="可使用 {datetime} 和 {task}" /></label>
            <label class="field">压缩包文件名（不含扩展名）<input v-model="form.archive.fileTemplate" maxlength="100" placeholder="{task}" title="可使用 {datetime} 和 {task}" /></label>
            <label v-if="form.type !== 'system'" class="check-row full"><input v-model="form.archive.encrypted" type="checkbox" />AES-256 密码加密</label>
            <label v-if="form.archive.encrypted" class="field full">压缩包密码<span v-if="archivePasswordSet" class="configured">已设置</span><div class="input-action"><input v-model="form.archive.password" :type="showArchivePassword ? 'text' : 'password'" autocomplete="new-password" :placeholder="archivePasswordSet ? '留空保留现有密码' : '压缩包密码'" /><button class="icon-button" type="button" :title="showArchivePassword ? '隐藏密码' : '显示密码'" :aria-label="showArchivePassword ? '隐藏密码' : '显示密码'" @click="showArchivePassword = !showArchivePassword"><EyeOff v-if="showArchivePassword" :size="17" /><Eye v-else :size="17" /></button></div></label>
          </div>
          <h3 class="form-heading separated">远端保留策略</h3>
          <div class="form-grid">
            <label class="field">保留天数<input v-model.number="form.retention.days" type="number" min="0" max="36500" /></label>
            <label class="field">至少保留版本数<input v-model.number="form.retention.keepLast" type="number" min="1" max="10000" /></label>
          </div>
          <h3 class="form-heading separated">失败重试</h3>
          <div class="form-grid">
            <label class="field">最多尝试次数<input v-model.number="form.retry.attempts" type="number" min="1" max="10" /></label>
            <label class="field">重试间隔（秒）<input v-model.number="form.retry.delaySeconds" type="number" min="1" max="3600" /></label>
          </div>
        </section>
        <section v-show="tab === 3" class="form-section">
          <h3 class="form-heading">执行计划</h3>
          <label class="check-row"><input v-model="form.schedule.enabled" type="checkbox" />定时执行</label>
          <div v-if="form.schedule.enabled" class="form-grid separated-small">
            <label class="field">常用计划<select v-model="cronPreset"><option value="">自定义</option><option v-for="preset in cronPresets" :key="preset.cron" :value="preset.cron">{{ preset.label }}</option></select></label>
            <label class="field">Cron 表达式<input v-model="form.schedule.cron" placeholder="0 3 * * *" /></label>
            <label class="field full">时区<select v-model="form.schedule.timezone"><option v-for="timezone in timezones" :key="timezone">{{ timezone }}</option></select></label>
          </div>
          <h3 class="form-heading separated">邮件通知</h3>
          <div class="check-stack"><label class="check-row"><input v-model="form.notification.start" type="checkbox" />执行开始</label><label class="check-row"><input v-model="form.notification.success" type="checkbox" />备份成功</label><label class="check-row"><input v-model="form.notification.failure" type="checkbox" />备份失败</label></div>
        </section>
      </div>
      <footer class="modal-footer"><button class="button secondary" type="button" @click="emit('close')">取消</button><button class="button primary" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : '保存任务' }}</button></footer>
    </form>
  </Modal>
  <PathPicker v-if="sourcePicker" kind="source" :initial-path="sourcePicker === 'sourcePath' ? form.sourcePath : form.vaultwarden[sourcePicker]" @close="sourcePicker = null" @select="selectSource" />
  <PathPicker v-if="destinationPicker !== null" kind="remote" :remote="form.destinations[destinationPicker]?.remote" :initial-path="form.destinations[destinationPicker]?.path" @close="destinationPicker = null" @select="path => { if (destinationPicker !== null) form.destinations[destinationPicker]!.path = path; destinationPicker = null; }" />
</template>
