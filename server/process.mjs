import { spawn } from 'node:child_process';

export function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(String(secret)).join('[REDACTED]');
  }
  return text.replace(/(password|passwd|token|client_secret)([=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/(\w+:\/\/[^\s/:]+:)[^\s@]+@/g, '$1[REDACTED]@');
}

export function aborted() {
  return Object.assign(new Error('Backup cancelled'), { code: 'CANCELLED' });
}

export function runProcess(binary, args, options = {}) {
  const { signal, cwd, env, secrets = [], onLine, onStdoutLine, stdoutFile, timeoutMs = 0, maxOutputBytes = 8 * 1024 * 1024 } = options;
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true,
      stdio: ['ignore', stdoutFile === undefined ? 'pipe' : stdoutFile, 'pipe'],
    });
    let stdout = '', stderr = '', partial = '', stdoutPartial = '', stopped = false, timeout, forceKill;
    const stop = () => {
      stopped = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
      forceKill.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (timeoutMs) timeout = setTimeout(stop, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < maxOutputBytes) stdout += text;
      else stop();
      if (onStdoutLine) {
        stdoutPartial += text;
        const lines = stdoutPartial.split(/\r\n|\r|\n/);
        stdoutPartial = lines.pop() ?? '';
        for (const line of lines) if (line) onStdoutLine(line);
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = redact(chunk.toString(), secrets);
      stderr = (stderr + text).slice(-maxOutputBytes);
      partial += text;
      const lines = partial.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line && onLine) onLine(line);
    });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      signal?.removeEventListener('abort', stop);
    };
    child.on('error', (error) => {
      cleanup();
      reject(Object.assign(new Error(redact(`${binary}: ${error.message}`, secrets)), { code: error.code ?? 'TOOL_ERROR' }));
    });
    child.on('close', (code) => {
      cleanup();
      if (partial && onLine) onLine(partial);
      if (stdoutPartial && onStdoutLine) onStdoutLine(stdoutPartial);
      if (signal?.aborted) return reject(aborted());
      if (stopped) return reject(Object.assign(new Error('External tool exceeded its time or output limit'), { code: 'TOOL_LIMIT' }));
      if (code !== 0) return reject(Object.assign(new Error(redact(`${binary} exited with code ${code}: ${stderr.trim().slice(-4096) || 'No diagnostic output'}`, secrets)), { code: 'TOOL_FAILED', exitCode: code }));
      resolve({ stdout, stderr, code });
    });
  });
}

export async function probe(binary, args = ['--version']) {
  try {
    const result = await runProcess(binary, args, { timeoutMs: 10000 });
    return { available: true, version: (result.stdout || result.stderr).trim().split(/\r?\n/).find(Boolean) ?? binary };
  } catch (error) {
    return { available: false, version: null, error: error.message };
  }
}
