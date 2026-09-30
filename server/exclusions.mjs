import path from 'node:path';

export function isExcluded(relativePath, excludes) {
  const relative = relativePath.split(path.sep).join('/');
  return excludes.some((pattern) => path.posix.matchesGlob(relative, pattern) || path.posix.matchesGlob(`./${relative}`, pattern) || (!pattern.startsWith('/') && !pattern.startsWith('./') && path.posix.matchesGlob(relative, `**/${pattern}`)));
}
