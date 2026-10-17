#!/usr/bin/env node
/**
 * Border-radius audit.
 *
 * Enforces the console's radius contract (see `.trellis/spec/frontend/ui-api.md`):
 * every corner comes from the `--radius-*` scale, containers never exceed
 * `--radius-lg` (0.5rem = 8px), and only pills (badges, switches, avatars,
 * dots) may be fully round. A raw number in a `border-radius` declaration means
 * someone bypassed the scale, which is exactly how the reference template grew
 * 16–18px panels.
 *
 * Allowed values: `var(--radius-*)`, `0`, `inherit`.
 * Seeded paths are printed so fixes stay explicit. Exits 1 on any violation.
 *
 * Usage: node scripts/ui-radius-audit.mjs [--json]
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const roots = ['web/src'];
const allowed = /^(0|inherit|var\(--radius-[a-z]+\))$/i;
const declaration = /border-radius\s*:\s*([^;{}]+)/gi;
const json = process.argv.includes('--json');

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') yield* walk(target); }
    else if (/\.(vue|css)$/.test(entry.name)) yield target;
  }
}

const violations = [];
for (const root of roots) {
  for await (const file of walk(root)) {
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(declaration)) {
        for (const value of match[1].split(/\s+/).filter(Boolean)) {
          const normalized = value.trim();
          // `border-radius: 50%` is a circle; only allow it on square pills.
          if (allowed.test(normalized) || normalized === '50%') continue;
          violations.push({ file: file.split(path.sep).join('/'), line: index + 1, value: normalized });
        }
      }
    });
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`);
} else if (violations.length) {
  console.error(`Radius audit failed: ${violations.length} value(s) bypass the --radius-* scale.`);
  for (const item of violations) console.error(`  ${item.file}:${item.line}  border-radius: ${item.value}`);
  console.error('Use var(--radius-sm|md|lg|pill), or 0 / inherit.');
} else {
  console.log('Radius audit passed: every border-radius uses the --radius-* scale.');
}
process.exit(violations.length ? 1 : 0);
