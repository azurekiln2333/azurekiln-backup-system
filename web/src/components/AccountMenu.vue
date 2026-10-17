<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ChevronDown, LogOut, Moon, Sun } from 'lucide-vue-next';

/**
 * Top-right account menu.
 *
 * Mirrors newapi's `profile-dropdown`: the avatar moves into the header and the
 * identity + session actions live behind it, so the sidebar no longer carries an
 * administrator card. The trigger keeps the username in its accessible name so
 * the account is still discoverable without opening the menu.
 */
defineProps<{ username?: string; theme: string }>();
const emit = defineEmits<{ 'toggle-theme': []; logout: [] }>();

const open = ref(false);
const root = ref<HTMLElement>();

function outside(event: MouseEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) open.value = false;
}
function escape(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === 'Escape') { open.value = false; root.value?.querySelector<HTMLElement>('.account-trigger')?.focus(); }
}
onMounted(() => {
  document.addEventListener('mousedown', outside);
  document.addEventListener('keydown', escape);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', outside);
  document.removeEventListener('keydown', escape);
});
</script>

<template>
  <div ref="root" class="account-menu-wrap">
    <button
      type="button"
      class="account-trigger"
      :title="`账号菜单 · ${username ?? '管理员'}`"
      :aria-label="`账号菜单 ${username ?? '管理员'}`"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="avatar" aria-hidden="true">{{ (username ?? 'A').slice(0, 1).toUpperCase() }}</span>
      <ChevronDown :size="15" class="account-caret" :class="{ open }" />
    </button>
    <Transition name="account-pop">
      <div v-if="open" class="account-menu" role="menu" :aria-label="`账号菜单 ${username ?? '管理员'}`">
        <div class="account-identity">
          <span class="avatar" aria-hidden="true">{{ (username ?? 'A').slice(0, 1).toUpperCase() }}</span>
          <div>
            <strong>{{ username ?? '管理员' }}</strong>
            <span>管理员</span>
          </div>
        </div>
        <button type="button" role="menuitem" @click="emit('toggle-theme')">
          <Sun v-if="theme === 'dark'" :size="16" />
          <Moon v-else :size="16" />
          {{ theme === 'dark' ? '浅色主题' : '深色主题' }}
        </button>
        <div class="account-divider" role="separator" />
        <button type="button" role="menuitem" class="account-signout" @click="emit('logout')">
          <LogOut :size="16" />
          退出登录
        </button>
      </div>
    </Transition>
  </div>
</template>
