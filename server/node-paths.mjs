// Pure path mapping for pushing task definitions to a replica node.
//
// A node is another instance of this application with its own filesystem layout.
// A task that archives `/srv/vaultwarden` on the controller may archive
// `/data/vaultwarden` on the node, so before a task definition is pushed every
// path it references has to be translated. This module owns that translation and
// nothing else: no I/O, no store access, no HTTP. The sync lane imports it so the
// controller, the API and the tests cannot disagree about what a mapped path is.
//
// Contract (see .trellis/tasks/11-02-server-nodes/prd.md):
//   - Longest matching prefix wins.
//   - `from` defines the comparison style: a Windows-looking `from` (drive letter
//     or backslashes) is matched case-insensitively, a POSIX `from` case-sensitively.
//     Repeating or mixed separators never defeat a match.
//   - A per-job override wins over the node's rules.
//   - An absolute path with no match is reported as needing a mapping. The caller
//     must skip that job rather than push a path the node cannot resolve.
//   - A relative path that no rule matches is reported as unmapped but NOT as
//     needing a mapping, because a relative path is already meaningful on the node.
import path from 'node:path';

/** Node path rule limits, shared with the node schema so validation cannot drift. */
export const NODE_PATH_RULE_LIMIT = 50;
export const NODE_PATH_MAX_LENGTH = 1024;

const WINDOWS_DRIVE = /^[A-Za-z]:/;
const UNC_PREFIX = /^[\\/]{2}[^\\/]/;
const UNIX_ABSOLUTE = /^\//;

/** True when the value contains a backslash or a drive letter: a Windows-style path. */
export function isWindowsStyle(value) {
  return typeof value === 'string' && (value.includes('\\') || WINDOWS_DRIVE.test(value));
}

/**
 * Split a path into its leading volume and its segments, without touching the
 * filesystem. Empty and `.` segments are dropped; `..` is kept as a segment so a
 * mapping can never silently walk upward.
 * @param {string} input
 * @returns {{ volume: string, segments: string[], absolute: boolean, separator: string }}
 */
export function splitPath(input) {
  if (typeof input !== 'string') throw new TypeError('path must be a string');
  const raw = input.trim();
  const separator = isWindowsStyle(raw) ? '\\' : '/';
  let volume = '';
  let rest = raw;
  if (WINDOWS_DRIVE.test(rest)) {
    volume = rest.slice(0, 2);
    rest = rest.slice(2);
  } else if (UNC_PREFIX.test(rest)) {
    // \\server\share is a volume; the remaining segments start after the share.
    const parts = rest.replace(/\\/g, '/').split('/').filter(Boolean);
    volume = `//${parts[0] ?? ''}/${parts[1] ?? ''}`;
    rest = `/${parts.slice(2).join('/')}`;
  }
  const segments = rest.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  // A drive-relative path (`C:foo`) has a volume but no root, so it is NOT absolute:
  // it resolves against that drive's current directory and cannot be mapped safely.
  const driveRelative = WINDOWS_DRIVE.test(volume) && !rest.startsWith('/') && !rest.startsWith('\\');
  const absolute = (Boolean(volume) && !driveRelative) || rest.startsWith('/') || rest.startsWith('\\');
  return { volume, segments, absolute, separator };
}

/** Rebuild a path from a volume, segments and a separator. */
export function joinPath(volume, segments, separator = '/') {
  const body = segments.join(separator);
  if (volume) {
    // `C:` needs its separator back (`C:\a`); `//host/share` already has one.
    if (WINDOWS_DRIVE.test(volume)) return `${volume}${separator}${body}`;
    return body ? `${volume}/${body}` : `${volume}/`;
  }
  return `${separator}${body}`;
}

/** Comparison form: Windows paths fold case, POSIX paths keep it. */
function comparisonSegments(parsed, caseInsensitive) {
  return caseInsensitive
    ? parsed.segments.map((segment) => segment.toLowerCase())
    : parsed.segments;
}

function isPrefix(prefix, candidate) {
  if (prefix.length > candidate.length) return false;
  return prefix.every((segment, index) => segment === candidate[index]);
}

/** Validate and normalize one `{from,to}` rule. Throws on an unusable rule. */
export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('路径规则必须是对象。');
  const from = typeof rule.from === 'string' ? rule.from.trim() : '';
  const to = typeof rule.to === 'string' ? rule.to.trim() : '';
  if (!from) throw new Error('路径规则的源路径不能为空。');
  if (!to) throw new Error('路径规则的目标路径不能为空。');
  if (from.length > NODE_PATH_MAX_LENGTH || to.length > NODE_PATH_MAX_LENGTH) {
    throw new Error(`路径规则的路径最多 ${NODE_PATH_MAX_LENGTH} 个字符。`);
  }
  if (/\0/.test(from) || /\0/.test(to)) throw new Error('路径规则不能包含空字符。');
  // Both ends must be absolute: a relative target would resolve somewhere
  // unpredictable on the node, and a relative source cannot identify a subtree.
  if (!splitPath(from).absolute) throw new Error('路径规则的源路径必须是绝对路径。');
  if (!splitPath(to).absolute) throw new Error('路径规则的目标路径必须是绝对路径。');
  return { from, to };
}

/** Normalize a rule list, rejecting duplicates that would make the result ambiguous. */
export function normalizeRules(rules) {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) throw new Error('路径规则必须是数组。');
  if (rules.length > NODE_PATH_RULE_LIMIT) throw new Error(`最多 ${NODE_PATH_RULE_LIMIT} 条路径规则。`);
  const normalized = rules.map(normalizeRule);
  const seen = new Set();
  for (const rule of normalized) {
    const parsed = splitPath(rule.from);
    const key = `${isWindowsStyle(rule.from) ? 'w' : 'p'}:${comparisonSegments(parsed, isWindowsStyle(rule.from)).join('/')}`;
    if (seen.has(key)) throw new Error(`路径规则的源路径重复：${rule.from}`);
    seen.add(key);
  }
  return normalized;
}

// A rule or an override entry becomes a matcher with a comparable comparison key.
function toMatcher(rule, source) {
  const windows = isWindowsStyle(rule.from);
  const from = splitPath(rule.from);
  const to = splitPath(rule.to);
  return {
    source,
    fromRaw: rule.from,
    toRaw: rule.to,
    windows,
    fromParts: comparisonSegments(from, windows),
    toVolume: to.volume,
    toSegments: to.segments,
    // A Windows `from` with a Windows `to` keeps the target's separator; a rule
    // that crosses platforms uses the target's own style, which `to` defines.
    separator: to.separator,
  };
}

/**
 * Map one path through a node's rules, with an optional per-job override.
 *
 * @param {string} input The path as stored on the controller.
 * @param {Array<{from: string, to: string}>} [rules] The node's shared rules.
 * @param {{ sources?: Array<{from: string, to: string}> } | null} [override]
 *   Per-job rules for this node. `sources` wins over `rules` entirely, so a job
 *   that needs special handling is never partially mapped by the node defaults.
 * @returns {{ path: string, mapped: boolean, needsMapping: boolean, rule: object|null }}
 *   `path` is the value the node should receive. `mapped` says a rule applied.
 *   `needsMapping` is true only for an absolute path that no rule matched: the
 *   caller must skip the job instead of pushing an unresolvable path.
 */
export function mapPath(input, rules = [], override = null) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { path: '', mapped: false, needsMapping: false, rule: null };
  }
  const raw = input.trim();
  const parsed = splitPath(raw);
  // A drive-relative path (`C:foo`) resolves against that drive's current
  // directory, so it has no stable meaning on the node; never map it.
  if (!parsed.absolute && parsed.volume) {
    return { path: raw, mapped: false, needsMapping: true, rule: null };
  }
  // An override on a job replaces the node rules rather than extending them:
  // mixing two rule sets for one path would make the result depend on ordering.
  const overrideRules = override?.sources;
  const usingOverride = overrideRules !== undefined && overrideRules !== null;
  const ruleList = normalizeRules(usingOverride ? overrideRules : rules);
  const source = usingOverride ? 'override' : 'node';

  // Case sensitivity follows each rule's own `from` style, so the comparison form
  // of the candidate is computed per matcher rather than once for all of them.
  let best = null;
  for (const rule of ruleList) {
    const matcher = toMatcher(rule, source);
    const parts = comparisonSegments(parsed, matcher.windows);
    if (!isPrefix(matcher.fromParts, parts)) continue;
    if (!best || matcher.fromParts.length > best.matcher.fromParts.length) {
      best = { matcher, parts };
    }
  }
  if (!best) {
    // No rule applied. Only an absolute path is unresolvable on the node.
    return { path: raw, mapped: false, needsMapping: parsed.absolute, rule: null };
  }

  const remainder = best.parts.slice(best.matcher.fromParts.length);
  const rebuilt = joinPath(
    best.matcher.toVolume,
    [...best.matcher.toSegments, ...remainder],
    best.matcher.separator,
  );
  return {
    path: rebuilt,
    mapped: true,
    needsMapping: false,
    rule: { from: best.matcher.fromRaw, to: best.matcher.toRaw, source: best.matcher.source },
  };
}
