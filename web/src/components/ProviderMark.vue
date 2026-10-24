<script setup lang="ts">
/**
 * Bundled provider mark for repository links.
 *
 * Assets are the official platform symbols, vendored locally under
 * `src/assets/providers` (provenance, source URLs and hashes are recorded next
 * to them). Nothing is fetched at runtime and no mark is recoloured, so a link
 * keeps working even if an image fails to load — the provider name is always in
 * the link's visible label and accessible name.
 *
 * GitHub publishes a light/dark pair; CSS shows the legible one per theme.
 */
defineProps<{ provider: 'github' | 'cnb' | 'gitee' | 'gitcode' }>();

import githubBlack from '../assets/providers/github-black.svg?url';
import githubWhite from '../assets/providers/github-white.svg?url';
import cnbColor from '../assets/providers/cnb-color.svg?url';
import giteeMark from '../assets/providers/gitee.svg?url';
import gitcodeMark from '../assets/providers/gitcode.svg?url';

const marks = { cnb: cnbColor, gitee: giteeMark, gitcode: gitcodeMark };
</script>

<template>
  <span class="provider-mark" :data-provider="provider" aria-hidden="true">
    <template v-if="provider === 'github'">
      <img class="provider-mark-light" :src="githubBlack" alt="" width="14" height="14" />
      <img class="provider-mark-dark" :src="githubWhite" alt="" width="14" height="14" />
    </template>
    <img v-else :src="marks[provider]" alt="" width="14" height="14" />
  </span>
</template>
