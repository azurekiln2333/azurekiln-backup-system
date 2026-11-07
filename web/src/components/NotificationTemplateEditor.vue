<script setup lang="ts">
/**
 * Notification template editor (设置 → 通知模板).
 *
 * The rendering rules live in `server/notify-template.mjs`; this component never
 * re-implements the `{{variable}}` / `{{#items}}…{{/items}}` engine. The preview
 * comes from `POST /api/settings/notification-template/preview` so the editor
 * shows exactly what the mailer will send, including HTML escaping.
 *
 * Saving goes through the shared `settings.notification.template` field. An
 * empty subject/body means "use the built-in default", and 恢复默认 writes those
 * empty strings rather than copying placeholder text into the stored settings.
 */
import { computed, ref } from 'vue';
import { Eye, RotateCcw, Save } from 'lucide-vue-next';
import { write } from '../api';
import { friendlyError, rawError } from '../errors';

interface TemplateVariableGroups {
  scalars: string[];
  items: string[];
  singleRunScalars: string[];
  sections: string[];
}
interface PreviewResult {
  subject: string;
  text: string;
  html: string;
  variables?: TemplateVariableGroups;
}

const props = defineProps<{
  settings: { subject: string; body: string };
  saving: boolean;
  /** Human-readable labels for variable names; the API owns the variable list. */
  labels: Record<string, string>;
}>();
const emit = defineEmits<{ save: [template: { subject: string; body: string }] }>();

// Draft is independent of the persisted value so a failed save keeps the text.
const draft = ref({ subject: props.settings.subject, body: props.settings.body });
const preview = ref<PreviewResult>();
const previewError = ref('');
const previewDetail = ref('');
const previewing = ref(false);
const error = ref('');
const errorDetail = ref('');
/** Mirrors `TEMPLATE_MAX_LENGTH` in shared/contracts.mjs (8192). */
const maxLength = 8192;
/** Variable groups reported by the preview API; falls back to none before the first run. */
const groups = ref<TemplateVariableGroups | null>(null);

const customized = computed(() => Boolean(draft.value.subject) || Boolean(draft.value.body));
// Derived from the draft, so every action follows what the operator can see.
const dirty = computed(() => draft.value.subject !== props.settings.subject || draft.value.body !== props.settings.body);

// Template tokens are built from plain strings instead of written literally:
// the SFC template compiler treats `{{ … }}` as interpolation, so a literal
// token cannot be rendered in markup at all. `T0`/`T1` are the two braces.
const T0 = '{';
const T1 = '}';
const token = (inner: string) => `${T0}${T0}${inner}${T1}${T1}`;
const tokens = {
  scalar: token('变量'),
  loop: `${token('#items')}一行模板${token('/items')}`,
  itemHelp: '为每个备份任务输出一行；循环内只能使用下面的「任务行变量」。',
};
/** Helper label lookup; unknown names fall back to the raw name. */
const label = (name: string) => props.labels[name] ?? name;
const scalarRows = computed(() => (groups.value?.scalars ?? []).map((name) => ({ name, token: token(name), description: label(name) })));
const itemRows = computed(() => (groups.value?.items ?? []).map((name) => ({ name, token: token(name), description: label(name) })));

async function runPreview() {
  previewing.value = true; previewError.value = ''; previewDetail.value = '';
  try {
    preview.value = await write<PreviewResult>(
      '/settings/notification-template/preview',
      { template: { subject: draft.value.subject, body: draft.value.body } },
    );
    if (preview.value.variables) groups.value = preview.value.variables;
  } catch (cause) {
    preview.value = undefined;
    previewError.value = friendlyError(cause, '无法生成预览');
    previewDetail.value = rawError(cause);
  } finally { previewing.value = false; }
}

function save() {
  error.value = ''; errorDetail.value = '';
  emit('save', { subject: draft.value.subject, body: draft.value.body });
}

/** Called by the settings page with the API error when the patch is rejected. */
function showError(cause: unknown) {
  error.value = friendlyError(cause, '通知模板保存失败');
  errorDetail.value = rawError(cause);
}

function reset() {
  error.value = ''; errorDetail.value = '';
  draft.value = { subject: '', body: '' };
  emit('save', { subject: '', body: '' });
}

// Keep the draft in step with a successful save without discarding local edits:
// the parent calls this only after the API accepted the patch, and passes the
// persisted template so the sync never depends on prop-propagation timing.
function syncFromSettings(saved: { subject: string; body: string } = props.settings) {
  draft.value = { subject: saved.subject, body: saved.body };
}
defineExpose({ showError, syncFromSettings });
</script>

<template>
  <section class="panel settings-panel">
    <div class="panel-heading">
      <h2>通知模板</h2>
      <span class="toggle-row">{{ customized ? '自定义模板' : '内置默认模板' }}</span>
    </div>
    <div class="panel-body">
      <div v-if="error" class="notice error" role="alert" :title="errorDetail">{{ error }}</div>

      <div class="form-grid">
        <label class="field full">邮件主题
          <input v-model="draft.subject" :maxlength="maxLength" placeholder="留空使用内置默认主题" />
        </label>
        <label class="field full">邮件正文（纯文本）
          <textarea v-model="draft.body" rows="12" :maxlength="maxLength" class="mono template-body" placeholder="留空使用内置默认正文" />
          <small class="field-hint">用 <code>{{ tokens.scalar }}</code> 输出变量；用 <code>{{ tokens.loop }}</code> 为每个备份任务输出一行。未知变量输出为空，不会执行代码。</small>
        </label>
      </div>

      <div class="panel-sub template-variables">
        <div class="panel-heading sub-heading"><h2>可用变量</h2><span class="toggle-row">点击预览后由服务端列出</span></div>
        <dl v-if="groups" class="template-variable-list">
          <div v-for="variable in scalarRows" :key="`scalar-${variable.name}`">
            <dt class="mono">{{ variable.token }}</dt>
            <dd>{{ variable.description }}</dd>
          </div>
          <div class="template-variable-group">
            <dt class="mono">{{ tokens.loop }}</dt>
            <dd>{{ tokens.itemHelp }}</dd>
          </div>
          <div v-for="variable in itemRows" :key="`item-${variable.name}`" class="template-variable-item">
            <dt class="mono">{{ variable.token }}</dt>
            <dd>{{ variable.description }}</dd>
          </div>
        </dl>
        <p v-else class="template-variables-empty">点击「预览效果」后会在这里列出本版本支持的变量。</p>
      </div>

      <div class="form-actions">
        <button type="button" class="button secondary" :disabled="previewing" @click="runPreview"><Eye :size="16" />{{ previewing ? '预览中…' : '预览效果' }}</button>
        <button type="button" class="button secondary" :disabled="saving || !customized || !dirty" @click="reset"><RotateCcw :size="16" />恢复默认</button>
        <button type="button" class="button primary" :disabled="saving || !dirty" @click="save"><Save :size="16" />{{ saving ? '保存中…' : '保存模板' }}</button>
      </div>

      <div v-if="previewError" class="notice error template-preview-error" role="alert" :title="previewDetail">{{ previewError }}</div>
      <div v-else-if="preview" class="panel-sub template-preview">
        <div class="panel-heading sub-heading"><h2>预览 <span class="count">样例数据</span></h2></div>
        <div class="template-preview-body">
          <p class="template-preview-subject"><span>主题</span><strong>{{ preview.subject }}</strong></p>
          <pre class="template-preview-text">{{ preview.text }}</pre>
        </div>
      </div>
    </div>
  </section>
</template>
