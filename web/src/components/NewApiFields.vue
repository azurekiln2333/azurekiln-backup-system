<script setup lang="ts">
import { FolderOpen } from 'lucide-vue-next';
import type { JobInput } from '../types';

// new-api keeps its authoritative state in a main database plus an optional separate log database.
// The archived .env is mandatory: without CRYPTO_SECRET the encrypted channel keys cannot be restored.
type NewApi = JobInput['newapi'];
type Database = NewApi['database'];

const props = defineProps<{
  modelValue: NewApi;
  sourcePath?: string;
  databasePasswordSet?: boolean;
  logDatabasePasswordSet?: boolean;
  dbPasswordPlaceholder?: string;
}>();
const emit = defineEmits<{ pick: [target: 'dataDir' | 'envFilePath' | 'composeFilePath' | 'serviceFilePath' | 'proxyConfigPath' | 'pluginsPath' | 'logsPath'] }>();

const dbTypes = [
  { value: 'sqlite', label: 'SQLite' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL / MariaDB' },
] as const;
const logTypes = [
  { value: 'same', label: '与主库相同（未设 LOG_SQL_DSN）' },
  { value: 'sqlite', label: '独立 SQLite' },
  { value: 'postgresql', label: '独立 PostgreSQL' },
  { value: 'mysql', label: '独立 MySQL' },
  { value: 'clickhouse', label: 'ClickHouse（需手工导出）' },
] as const;

function defaultPort(type: Database extends never ? never : string) {
  if (type === 'postgresql') return 5432;
  if (type === 'mysql') return 3306;
  if (type === 'clickhouse') return 8123;
  return undefined;
}
function setDbType(value: NewApi['dbType']) {
  props.modelValue.dbType = value;
  props.modelValue.database.port = defaultPort(value);
}
function setLogDbType(value: NewApi['logDbType']) {
  props.modelValue.logDbType = value;
  if (value !== 'same' && value !== 'sqlite') props.modelValue.logDatabase.port = defaultPort(value);
}
</script>

<template>
  <label class="field full">new-api 数据目录（docker-compose 的 ./data:/data）
    <div class="input-action">
      <input v-model="modelValue.dataDir" placeholder="/sources/new-api/data" />
      <button type="button" class="icon-button" title="浏览数据目录" aria-label="浏览数据目录" @click="emit('pick', 'dataDir')"><FolderOpen :size="18" /></button>
    </div>
  </label>
  <label class="field full">.env 文件（必填，含 CRYPTO_SECRET / SESSION_SECRET）
    <div class="input-action">
      <input v-model="modelValue.envFilePath" placeholder="/sources/new-api/.env" />
      <button type="button" class="icon-button" title="浏览 .env" aria-label="浏览 .env" @click="emit('pick', 'envFilePath')"><FolderOpen :size="18" /></button>
    </div>
  </label>
  <label class="field full">主库类型
    <select :value="modelValue.dbType" @change="setDbType(($event.target as HTMLSelectElement).value as NewApi['dbType'])">
      <option v-for="option in dbTypes" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
  </label>
  <label v-if="modelValue.dbType === 'sqlite'" class="field full">SQLite 文件<input v-model="modelValue.sqlitePath" placeholder="默认：数据目录/one-api.db" /></label>
  <template v-else>
    <label class="field">主库主机<input v-model="modelValue.database.host" placeholder="数据库主机" /></label>
    <label class="field">端口<input v-model.number="modelValue.database.port" type="number" min="1" max="65535" /></label>
    <label class="field">数据库名称<input v-model="modelValue.database.name" placeholder="new-api" /></label>
    <label class="field">用户名<input v-model="modelValue.database.username" autocomplete="off" /></label>
    <label class="field">数据库密码<span v-if="databasePasswordSet" class="configured">已设置</span><input v-model="modelValue.database.password" type="password" autocomplete="new-password" :placeholder="databasePasswordSet ? '留空保留现有密码' : (dbPasswordPlaceholder ?? '数据库密码')" /></label>
    <label class="field">TLS 模式<select v-model="modelValue.database.sslMode"><option value="default">默认</option><option value="disable">禁用</option><option value="require">{{ modelValue.dbType === 'mysql' ? '要求 TLS 并校验证书' : '要求 TLS' }}</option><option value="verify-ca">验证 CA</option><option value="verify-full">完整验证</option></select></label>
    <label class="field full">CA 证书路径<input v-model="modelValue.database.sslCa" placeholder="可选" /></label>
    <label class="field">客户端证书路径<input v-model="modelValue.database.sslCert" placeholder="可选" /></label>
    <label class="field">客户端密钥路径<input v-model="modelValue.database.sslKey" placeholder="可选" /></label>
  </template>
  <label class="field full">日志库
    <select :value="modelValue.logDbType" @change="setLogDbType(($event.target as HTMLSelectElement).value as NewApi['logDbType'])">
      <option v-for="option in logTypes" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
  </label>
  <label v-if="modelValue.logDbType === 'sqlite'" class="field full">日志库 SQLite 文件<input v-model="modelValue.logSqlitePath" placeholder="默认：数据目录/one-api-log.db" /></label>
  <template v-else-if="modelValue.logDbType !== 'same'">
    <label class="field">日志库主机<input v-model="modelValue.logDatabase.host" placeholder="数据库主机" /></label>
    <label class="field">端口<input v-model.number="modelValue.logDatabase.port" type="number" min="1" max="65535" /></label>
    <label class="field">数据库名称<input v-model="modelValue.logDatabase.name" :placeholder="modelValue.logDbType === 'clickhouse' ? 'new_api_logs' : 'new-api-log'" /></label>
    <label class="field">用户名<input v-model="modelValue.logDatabase.username" autocomplete="off" /></label>
    <label class="field">日志库密码<span v-if="logDatabasePasswordSet" class="configured">已设置</span><input v-model="modelValue.logDatabase.password" type="password" autocomplete="new-password" :placeholder="logDatabasePasswordSet ? '留空保留现有密码' : '日志库密码'" /></label>
    <p v-if="modelValue.logDbType === 'clickhouse'" class="field full muted">ClickHouse 日志库不会自动导出；备份会记录告警，还原说明里给出手工导出命令。</p>
  </template>
  <label class="field">编排文件输入<div class="input-action"><input v-model="modelValue.composeFilePath" placeholder="可选：docker-compose.yml" /><button type="button" class="icon-button" title="浏览编排文件" aria-label="浏览编排文件" @click="emit('pick', 'composeFilePath')"><FolderOpen :size="18" /></button></div></label>
  <label class="field">systemd 单元输入<div class="input-action"><input v-model="modelValue.serviceFilePath" placeholder="可选：new-api.service" /><button type="button" class="icon-button" title="浏览 unit 文件" aria-label="浏览 unit 文件" @click="emit('pick', 'serviceFilePath')"><FolderOpen :size="18" /></button></div></label>
  <label class="field">反代配置输入<div class="input-action"><input v-model="modelValue.proxyConfigPath" placeholder="可选：Nginx/Caddy 配置文件或目录" /><button type="button" class="icon-button" title="浏览反代配置" aria-label="浏览反代配置" @click="emit('pick', 'proxyConfigPath')"><FolderOpen :size="18" /></button></div></label>
  <label class="field">插件脚本目录<div class="input-action"><input v-model="modelValue.pluginsPath" placeholder="可选：宿主机挂载的插件目录" /><button type="button" class="icon-button" title="浏览插件目录" aria-label="浏览插件目录" @click="emit('pick', 'pluginsPath')"><FolderOpen :size="18" /></button></div></label>
  <label class="field full">new-api 版本（镜像 tag，用于还原时对齐）<input v-model="modelValue.appVersion" placeholder="例如 calciumion/new-api:v0.9.9" /></label>
  <label class="check-row full"><input v-model="modelValue.includeLogTable" type="checkbox" />包含 logs 表（消耗额度与 tokens 历史）</label>
  <label class="check-row full"><input v-model="modelValue.includeLogs" type="checkbox" />包含进进程日志 logs/</label>
  <label v-if="modelValue.includeLogs" class="field full">日志目录<div class="input-action"><input v-model="modelValue.logsPath" placeholder="/sources/new-api/logs" /><button type="button" class="icon-button" title="浏览日志目录" aria-label="浏览日志目录" @click="emit('pick', 'logsPath')"><FolderOpen :size="18" /></button></div></label>
  <p class="field full muted">数据目录内的 <code>new-api-body-cache</code>、<code>*.db-wal</code>、<code>*.db-shm</code> 会自动排除；数据库使用在线一致性快照，归档强制 AES-256 加密。</p>
</template>
