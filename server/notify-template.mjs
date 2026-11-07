// Notification templates: a deliberately tiny `{{variable}}` renderer.
//
// Contract (see .trellis/tasks/11-02-notify-template/prd.md):
//   renderNotification(template, ctx) -> { subject, text, html }
//
// Design constraints that shape everything below:
//   * Pure: no I/O, no clock reads, no dependency on Express or SQLite. The
//     aggregation batch (server/notify-batch.mjs) and the preview route both
//     call into this file, so it must be trivially testable.
//   * Never throw on bad input. Unknown variables render as an empty string;
//     a malformed template degrades to the default template instead of failing
//     a backup run's notification.
//   * Never execute anything. Only `{{name}}` and the single `{{#items}}…
//     {{/items}}` section are understood, so a template can never reach a
//     property path, a function call, or an include.
//   * HTML is always escaped, including every `{{variable}}` substituted into
//     an item row. Task names are operator-supplied and end up in mail bodies.
//
// Empty strings mean "use the built-in default" for both subject and body, so a
// stored `{}` or `{ subject: '', body: '' }` is equivalent to not configuring a
// template at all.

/** Longest accepted template string. Guards the settings schema and the preview API. */
export const TEMPLATE_MAX_LENGTH = 8192;

/**
 * Placeholder pattern: `{{name}}` or `{{#items}}`/`{{/items}}`. Names are `\w` only.
 *
 * Always instantiated per scan (via `token()`): a `g`-flagged RegExp keeps its
 * `lastIndex` on the object, and `renderString` recurses into item sections. A
 * shared module-level instance would let the inner scan reset the outer
 * loop's position, which silently spins forever on the first section.
 */
const TOKEN_SOURCE = /\{\{\s*([#/]?)([A-Za-z0-9_]+)\s*\}\}/g;
const token = () => new RegExp(TOKEN_SOURCE.source, 'g');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every HTML-significant character. Applied to all substituted values. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

export const DEFAULT_TEMPLATE = Object.freeze({
  // Aggregate subject: one mail describing the whole batch. Keep it free of
  // `{{#items}}` so the header stays stable regardless of row count.
  subject: '备份汇总:成功 {{successCount}} / 警告 {{warningCount}} / 失败 {{failedCount}}(共 {{total}})',
  body: [
    '备份汇总:共 {{total}} 个,成功 {{successCount}},警告 {{warningCount}},失败 {{failedCount}}',
    '主机:{{hostName}}',
    '开始:{{startedAt}}  结束:{{finishedAt}}',
    '',
    '{{#items}}',
    '- {{jobName}} ({{type}}) {{status}} 耗时 {{durationSec}} 秒 体积 {{archiveBytes}} 字节{{error}}',
    '{{/items}}',
  ].join('\n'),
});

/**
 * Built-in single-run default. Used when a caller renders one run rather than a
 * batch; it shares the wording of the aggregated default so an operator sees no
 * format change when aggregation is disabled.
 */
export const DEFAULT_SINGLE_TEMPLATE = Object.freeze({
  subject: '[备份 {{status}}] {{jobName}}',
  body: [
    '任务:{{jobName}} ({{type}})',
    '状态:{{status}}  耗时 {{durationSec}} 秒',
    '开始:{{startedAt}}  结束:{{finishedAt}}',
    '归档:{{archiveName}} 体积:{{archiveBytes}} 字节',
    '错误:{{error}}',
  ].join('\n'),
});

/** Sample context used by the preview API when the caller supplies none. */
export function sampleContext() {
  const startedAt = '2026-11-02T01:00:00.000Z';
  const finishedAt = '2026-11-02T01:04:12.000Z';
  return {
    total: 3,
    successCount: 1,
    warningCount: 1,
    failedCount: 1,
    startedAt,
    finishedAt,
    hostName: 'backup-host',
    items: [
      { jobName: '站点目录', type: 'directory', status: 'succeeded', durationSec: 42, archiveBytes: 1048576, error: '', nodeName: '' },
      { jobName: 'Vaultwarden', type: 'vaultwarden', status: 'warning', durationSec: 61, archiveBytes: 524288, error: 'Warning: remote checksum unavailable', nodeName: '' },
      { jobName: 'new-api 数据', type: 'newapi', status: 'failed', durationSec: 7, archiveBytes: 0, error: 'Error: database unreachable', nodeName: '' },
    ],
  };
}

/** Coerce a template field into `{ subject, body }`, tolerating junk from storage. */
function normalizeTemplate(template) {
  const source = template && typeof template === 'object' ? template : {};
  const subject = typeof source.subject === 'string' ? source.subject.trim() : '';
  const body = typeof source.body === 'string' ? source.body.trim() : '';
  return {
    subject: subject ? subject.slice(0, TEMPLATE_MAX_LENGTH) : '',
    body: body ? body.slice(0, TEMPLATE_MAX_LENGTH) : '',
  };
}

/** Scalar rendering: unknown or non-scalar values become an empty string. */
function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  // Objects/arrays are never stringified: they would leak internals or print
  // "[object Object]" into a mail body.
  return '';
}

/**
 * Render one template string. `{{#items}}…{{/items}}` is the only control
 * structure; everything else is a scalar substitution.
 *
 * Unbalanced or nested sections are tolerated:
 *   * `{{#items}}` without a matching `{{/items}}` renders its body once per
 *     item (the section extends to the end of the template);
 *   * `{{/items}}` without an opening tag is dropped;
 *   * a `{{#items}}` nested inside a section body is skipped, so recursion is
 *     impossible.
 */
function renderString(source, context, { escape }) {
  const items = Array.isArray(context.items) ? context.items.filter((item) => item && typeof item === 'object') : [];
  const output = [];
  let cursor = 0;
  let inItems = false;
  let sectionStart = -1;

  const substitute = (name) => {
    if (name === 'items') return ''; // `{{items}}` outside a section is not a value
    // Item fields never leak into the outer scope: only the top-level context is
    // visible outside `{{#items}}`, and only the item is visible inside it.
    return scalar(context[name]);
  };

  const scan = token();
  let match;
  while ((match = scan.exec(source)) !== null) {
    const [, marker, name] = match;
    // Advance past this token up front so that no branch below can re-match it.
    // Every `continue` is therefore progress, and unknown markers are skipped
    // without being emitted.
    const afterToken = scan.lastIndex;
    if (inItems && !(marker === '/' && name === 'items')) {
      // Inside a section body, ignore everything until the matching close. The
      // body is re-rendered per item afterwards, so substituting here (once,
      // against the outer context) would both leak outer values into rows and
      // emit an extra stray row.
      continue;
    }
    if (marker) {
      if (marker === '#' && name === 'items') {
        output.push(source.slice(cursor, match.index));
        inItems = true;
        sectionStart = afterToken;
        cursor = afterToken;
        continue;
      }
      if (marker === '/' && name === 'items') {
        if (!inItems) {
          // Stray close: drop the token.
          output.push(source.slice(cursor, match.index));
          cursor = afterToken;
          continue;
        }
        const section = source.slice(sectionStart, match.index);
        const rows = section.split(/\r?\n/);
        // Blank the first/last line when the tags sit on their own lines, so a
        // multi-line section does not emit a leading and trailing blank row.
        if (rows.length > 1 && rows[0].trim() === '') rows.shift();
        if (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop();
        const body = rows.join('\n');
        // Join rendered rows with a newline: a row body normally ends without a
        // trailing newline, so without this every row would concatenate.
        output.push(items.map((item) => renderString(body, item, { escape })).join('\n'));
        inItems = false;
        sectionStart = -1;
        cursor = afterToken;
        continue;
      }
      // Unknown section marker: drop the token but keep scanning.
      output.push(source.slice(cursor, match.index));
      cursor = afterToken;
      continue;
    }
    output.push(source.slice(cursor, match.index));
    const value = substitute(name);
    output.push(escape ? escapeHtml(value) : value);
    cursor = afterToken;
  }

  if (inItems && sectionStart >= 0) {
    // Unclosed section: everything from the opening tag to the end is the body.
    const rows = source.slice(sectionStart).split(/\r?\n/);
    if (rows.length > 1 && rows[0].trim() === '') rows.shift();
    const body = rows.join('\n');
    output.push(items.map((item) => renderString(body, item, { escape })).join('\n'));
    return output.join('');
  }
  output.push(source.slice(cursor));
  return output.join('');
}

/**
 * Render a notification.
 *
 * @param {{subject?: string, body?: string}|null|undefined} template Operator template; empty fields fall back to defaults.
 * @param {object} context Aggregation context; see `sampleContext()` for the shape.
 * @param {{fallback?: {subject?: string, body?: string}}} [options] `fallback` selects the built-in default
 *   (the batch default unless a single-run default is requested).
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderNotification(template, context, options = {}) {
  const normalized = normalizeTemplate(template);
  const fallback = normalizeTemplate(options.fallback);
  const subjectSource = normalized.subject || fallback.subject || DEFAULT_TEMPLATE.subject;
  const bodySource = normalized.body || fallback.body || DEFAULT_TEMPLATE.body;
  const safeContext = context && typeof context === 'object' ? context : {};

  const subject = renderString(subjectSource, safeContext, { escape: false }).replace(/[\r\n]+/g, ' ').trim();
  const text = renderString(bodySource, safeContext, { escape: false }).replace(/\r\n/g, '\n').trim();
  const html = renderString(bodySource, safeContext, { escape: true }).replace(/\r\n/g, '\n').trim();

  return {
    // RFC 5322 headers cannot contain CRLF: stripping them means a template can
    // never inject extra headers. The subject is deliberately not HTML-escaped,
    // because it is transmitted as a plain header, not as markup.
    subject: subject || 'AzureKiln Backup',
    text,
    html: `<div style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${html}</div>`,
  };
}

/** Variables an operator may use. Kept in sync with `renderNotification` and the defaults. */
export const TEMPLATE_VARIABLES = Object.freeze({
  // Always available, at the top level of the context.
  scalars: ['total', 'successCount', 'warningCount', 'failedCount', 'startedAt', 'finishedAt', 'hostName'],
  // Available inside `{{#items}}…{{/items}}`.
  items: ['jobName', 'type', 'status', 'durationSec', 'archiveBytes', 'error', 'nodeName'],
  // Also valid at the top level when rendering a single run rather than a batch
  // (see DEFAULT_SINGLE_TEMPLATE). Outside a section these render empty for an
  // aggregated context, because the summarized fields live on the rows.
  singleRunScalars: ['jobName', 'type', 'status', 'durationSec', 'archiveBytes', 'archiveName', 'error'],
  sections: ['items'],
});
