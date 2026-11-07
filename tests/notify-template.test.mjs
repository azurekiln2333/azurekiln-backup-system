import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SINGLE_TEMPLATE, DEFAULT_TEMPLATE, escapeHtml, renderNotification, sampleContext, TEMPLATE_VARIABLES } from '../server/notify-template.mjs';
import { notificationTemplateSchema, settingsSchema, TEMPLATE_MAX_LENGTH } from '../shared/contracts.mjs';

// The renderer is a pure function; these tests pin the parts a mail body depends
// on: the aggregated default format, variable substitution, loop semantics,
// escaping, and the "never throw, never execute" promise.

const context = () => sampleContext();

test('default template renders the aggregated summary and one row per item', () => {
  const { subject, text, html } = renderNotification({}, context());
  assert.match(subject, /成功 1/);
  assert.match(subject, /失败 1/);
  assert.match(text, /备份汇总:共 3 个,成功 1,警告 1,失败 1/);
  assert.match(text, /主机:backup-host/);
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 3);
  assert.match(text, /- 站点目录 \(directory\) succeeded 耗时 42 秒/);
  assert.match(text, /- new-api 数据 \(newapi\) failed/);
  assert.ok(html.includes('备份汇总'), 'html carries the same body');
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
  assert.ok(!html.includes('{{'));
});

test('empty or missing template fields fall back to the built-in defaults', () => {
  const expected = renderNotification({}, context());
  for (const template of [undefined, null, {}, { subject: '', body: '' }, { subject: '   ', body: '\n\t ' }]) {
    const actual = renderNotification(template, context());
    assert.equal(actual.subject, expected.subject);
    assert.equal(actual.text, expected.text);
  }
});

test('a custom template replaces only the fields it sets', () => {
  const rendered = renderNotification({ subject: 'custom {{total}}' }, context());
  assert.equal(rendered.subject, 'custom 3');
  // body still uses the default format
  assert.match(rendered.text, /备份汇总:共 3 个/);
});

test('single-run fallback is selectable and distinct from the batch default', () => {
  const ctx = { jobName: 'nightly', type: 'directory', status: 'succeeded', durationSec: 5, startedAt: 'a', finishedAt: 'b', archiveName: 'x.7z', archiveBytes: 10, error: '' };
  const rendered = renderNotification({}, ctx, { fallback: DEFAULT_SINGLE_TEMPLATE });
  assert.equal(rendered.subject, '[备份 succeeded] nightly');
  assert.match(rendered.text, /归档:x\.7z/);
  assert.notEqual(rendered.text, renderNotification({}, ctx).text);
});

test('{{#items}} repeats its body once per item and joins rows with newlines', () => {
  const rendered = renderNotification({ body: 'HEAD\n{{#items}}\n- {{jobName}}\n{{/items}}\nTAIL' }, context());
  assert.equal(rendered.text, 'HEAD\n- 站点目录\n- Vaultwarden\n- new-api 数据\nTAIL');
  const inline = renderNotification({ body: '{{#items}}[{{jobName}}]{{/items}}' }, context());
  assert.equal(inline.text, '[站点目录]\n[Vaultwarden]\n[new-api 数据]');
});

test('item fields never leak into the outer scope', () => {
  // `status` exists on items only; outside the section it must render empty and
  // must not pick up a row value. Rows are newline-joined, hence the separators.
  const rendered = renderNotification({ body: 'X{{status}}Y|{{#items}}{{status}};{{/items}}' }, context());
  assert.equal(rendered.text, 'XY|succeeded;\nwarning;\nfailed;');
});

test('unknown variables render as empty strings and never throw', () => {
  const rendered = renderNotification({ subject: '{{nope}}', body: 'a{{missing}}b{{}}c{{#unknown}}d{{/unknown}}e' }, context());
  assert.equal(rendered.subject, 'AzureKiln Backup');
  // `{{}}` has no token name, so it is left as literal text rather than treated
  // as a variable. Nothing is dropped or executed either way.
  assert.equal(rendered.text, 'ab{{}}cde');
  // Malformed / hostile input must all be tolerated.
  for (const body of ['{{', '}}', '{{#items}}', '{{/items}}', '{{#items}}{{#items}}x{{/items}}', '{{ items }}', '{{__proto__}}', '{{constructor}}', '{{toString}}']) {
    assert.doesNotThrow(() => renderNotification({ subject: 'x', body }, context()), `threw on ${body}`);
  }
});

test('prototype and non-scalar values are never stringified', () => {
  const rendered = renderNotification({ body: '{{__proto__}}|{{constructor}}|{{items}}|{{toString}}' }, context());
  assert.equal(rendered.text, '|||');
  const noItems = renderNotification({ body: '{{items}}' }, { items: 'not-an-array' });
  assert.equal(noItems.text, '');
});

test('html escapes every substituted value, including item fields', () => {
  const hostile = {
    ...context(),
    hostName: '<img src=x onerror=alert(1)>',
    items: [{ jobName: '<script>alert(1)</script>', type: '" onmouseover="', status: 'failed', durationSec: 1, archiveBytes: 2, error: "it's a & trap" }],
  };
  const rendered = renderNotification({ subject: 'subj', body: '{{hostName}}|{{#items}}{{jobName}}{{type}}{{error}}{{/items}}' }, hostile);
  assert.ok(!rendered.html.includes('<script>'), 'script tag must not survive in html');
  assert.ok(!rendered.html.includes('<img'), 'img tag must not survive in html');
  assert.ok(rendered.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(rendered.html.includes('&quot; onmouseover=&quot;'));
  assert.ok(rendered.html.includes('it&#39;s a &amp; trap'));
  assert.ok(rendered.html.startsWith('<div style="white-space:pre-wrap'));
  // The plain-text part intentionally keeps the raw characters.
  assert.ok(rendered.text.includes('<script>alert(1)</script>'));
});

test('escapeHtml covers all five HTML-significant characters and nullish input', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
});

test('subject cannot inject extra mail headers', () => {
  const rendered = renderNotification({ subject: 'ok{{hostName}}' }, { ...context(), hostName: 'x' });
  assert.ok(!/[\r\n]/.test(rendered.subject));
  // A template that renders to nothing still yields a usable, non-empty subject.
  assert.equal(renderNotification({ subject: '{{nope}}' }, context()).subject, 'AzureKiln Backup');
});

test('the default template only uses documented variables', () => {
  const scalars = new Set([...TEMPLATE_VARIABLES.scalars, ...TEMPLATE_VARIABLES.singleRunScalars]);
  const itemFields = new Set(TEMPLATE_VARIABLES.items);
  const check = (source) => {
    let inItems = false;
    for (const [, marker, name] of source.matchAll(/\{\{\s*([#/]?)([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (marker === '#' && name === 'items') { inItems = true; continue; }
      if (marker === '/' && name === 'items') { inItems = false; continue; }
      assert.ok((inItems ? itemFields : scalars).has(name), `undocumented variable ${name}`);
    }
    assert.equal(inItems, false, 'unbalanced items section in the default template');
  };
  // The subject is an aggregate header, so it must not depend on row fields.
  check(DEFAULT_TEMPLATE.subject);
  check(DEFAULT_TEMPLATE.body);
  check(DEFAULT_SINGLE_TEMPLATE.subject);
  check(DEFAULT_SINGLE_TEMPLATE.body);
});

test('schema bounds the template and rejects control characters in the subject', () => {
  assert.equal(notificationTemplateSchema.parse({}).subject, '');
  assert.equal(notificationTemplateSchema.parse({}).body, '');
  assert.throws(() => notificationTemplateSchema.parse({ subject: 'a\nb' }));
  assert.throws(() => notificationTemplateSchema.parse({ subject: 'a\rb' }));
  assert.throws(() => notificationTemplateSchema.parse({ subject: 'a\0b' }));
  assert.throws(() => notificationTemplateSchema.parse({ body: 'x'.repeat(TEMPLATE_MAX_LENGTH + 1) }));
  assert.doesNotThrow(() => notificationTemplateSchema.parse({ body: 'x'.repeat(TEMPLATE_MAX_LENGTH) }));
});

test('stored settings without a template keep working', () => {
  // Simulates settings rows written before this feature existed.
  const parsed = settingsSchema.parse({ smtp: { enabled: false }, notification: { success: true } });
  assert.deepEqual(parsed.notification.template, { subject: '', body: '' });
  assert.equal(parsed.notification.aggregateWindowSec, 120);
  // And rendering them still produces the documented default.
  const rendered = renderNotification(parsed.notification.template, context());
  assert.match(rendered.text, /备份汇总:共 3 个/);
});
