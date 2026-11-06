import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'azurekiln-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { DATA_DIR: path.join(root, 'data'), SOURCE_ROOTS: path.join(root, 'sources') };
  return { root, read: (overrides = {}) => loadConfig({ ...env, ...overrides }, root) };
}

test('Compose discovery follows filename precedence and retains legacy deployments', (t) => {
  const f = fixture(t);
  assert.equal(f.read().systemComposePath, '');
  const filenames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  for (const file of filenames) {
    const candidate = path.join(f.root, file);
    writeFileSync(candidate, 'services: {}\n');
    assert.equal(f.read().systemComposePath, candidate, `${file} wins over the older defaults`);
  }
  for (const file of filenames.toReversed()) {
    assert.equal(f.read().systemComposePath, path.join(f.root, file));
    rmSync(path.join(f.root, file));
  }
  assert.equal(f.read().systemComposePath, '');
});

test('an explicit SYSTEM_COMPOSE_FILE overrides default discovery even before the file exists', (t) => {
  const f = fixture(t);
  for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    writeFileSync(path.join(f.root, file), 'services: {}\n');
  }
  const relative = path.join('deployment', 'custom-compose.yml');
  assert.equal(f.read({ SYSTEM_COMPOSE_FILE: relative }).systemComposePath, path.resolve(f.root, relative));
  const absolute = path.join(f.root, 'external-compose.yml');
  assert.equal(f.read({ SYSTEM_COMPOSE_FILE: absolute }).systemComposePath, absolute);
});
