<script setup lang="ts">
import { ref, useId } from 'vue';
import { X } from 'lucide-vue-next';

/**
 * Site-tag chip editor.
 *
 * It mirrors the established task-tag interaction (Enter/comma adds, Backspace
 * removes, 32 chars, 10 cap, case-insensitive dedupe) but is deliberately scoped
 * to the site editor: `JobEditor` keeps its own pinned datalist/aria behavior
 * for the browser suite, so this is not a refactor of the task editor.
 */
const props = withDefaults(defineProps<{
  modelValue: string[];
  /** Existing labels offered through a datalist; they are never auto-added. */
  suggestions?: string[];
  label?: string;
  placeholder?: string;
  max?: number;
}>(), { suggestions: () => [], label: '标签', placeholder: '例如 生产，回车添加', max: 10 });

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const listId = `tag-suggestions-${useId()}`;
const draft = ref('');

const available = () => props.suggestions.filter(tag => !props.modelValue.some(item => item.toLowerCase() === tag.toLowerCase()));

function add(text = draft.value) {
  const next = [...props.modelValue];
  for (const raw of text.split(/[,，\n]/)) {
    const tag = raw.trim().slice(0, 32);
    if (tag && next.length < props.max && !next.some(item => item.toLowerCase() === tag.toLowerCase())) next.push(tag);
  }
  draft.value = '';
  if (next.length !== props.modelValue.length) emit('update:modelValue', next);
}
function remove(index: number) {
  const next = [...props.modelValue];
  next.splice(index, 1);
  emit('update:modelValue', next);
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); }
  else if (event.key === 'Backspace' && !draft.value && props.modelValue.length) remove(props.modelValue.length - 1);
}
</script>

<template>
  <div class="field full">
    <span>{{ label }}</span>
    <div class="tag-input">
      <span v-for="(tag, index) in modelValue" :key="tag" class="tag-chip">{{ tag }}<button type="button" :title="`移除标签 ${tag}`" :aria-label="`移除标签 ${tag}`" @click="remove(index)"><X :size="11" /></button></span>
      <input v-model="draft" :list="listId" :aria-label="`添加${label}`" :placeholder="modelValue.length ? '' : placeholder" :disabled="modelValue.length >= max" maxlength="32" @keydown="keydown" @blur="add()" />
    </div>
    <datalist :id="listId"><option v-for="tag in available()" :key="tag" :value="tag" /></datalist>
    <small class="muted">{{ modelValue.length }} / {{ max }} 个标签，站点标签与任务标签互相独立。</small>
  </div>
</template>
