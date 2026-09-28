<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const element = ref<HTMLElement>();
let previous: HTMLElement | null = null;
function keyboard(event: KeyboardEvent) {
  if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== element.value) return;
  if (event.key === 'Escape') emit('close');
  if (event.key !== 'Tab') return;
  const elements = [...(element.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? [])];
  const first = elements[0]; const last = elements.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
onMounted(() => {
  previous = document.activeElement as HTMLElement;
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', keyboard);
  element.value?.querySelector<HTMLElement>('input, button')?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboard);
  if (document.querySelectorAll('[role="dialog"]').length <= 1) document.body.classList.remove('modal-open');
  previous?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @mousedown.self="emit('close')">
      <section ref="element" class="modal" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <header class="modal-header"><h2>{{ title }}</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('close')"><X :size="20" /></button></header>
        <slot />
      </section>
    </div>
  </Teleport>
</template>
