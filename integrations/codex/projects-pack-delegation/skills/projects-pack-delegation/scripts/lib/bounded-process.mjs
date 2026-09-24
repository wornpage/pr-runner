import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROCESS_TIMEOUT_MS = 30_000;
export const VERIFICATION_TIMEOUT_MS = 15 * 60_000;
export const PROCESS_OUTPUT_BYTES = 1024 * 1024; // Per stream, as in the original runner.

export const GITHUB_PUBLISHER_MODES = Object.freeze({
  installationToken: 'github_app_installation_token',
  ambientHumanCompatibility: 'ambient_human_compatibility_v1'
});

const GITHUB_CREDENTIAL_ENV = Object.freeze([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'GH_DEBUG', 'GITHUB_DEBUG', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK'
]);

function githubCredentialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

export function githubPublisherAuthentication(env = process.env) {
  const entry = Object.entries(env).find(([key]) => key.toUpperCase() === 'GH_TOKEN');
  if (!entry) return Object.freeze({
    mode: GITHUB_PUBLISHER_MODES.ambientHumanCompatibility, token: null, valid: true
  });
  const token = entry[1];
  const valid = typeof token === 'string' && token.length > 0 && token.length <= 4096
    && !/[\u0000-\u0020\u007f]/u.test(token);
  return Object.freeze({ mode: GITHUB_PUBLISHER_MODES.installationToken,
    token: valid ? token : null, valid });
}

export function safeSubprocessEnvironment(env = process.env, credentialScope = 'none', credentialUrl = null) {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    const upper = key.toUpperCase();
    if (['PROJECTS_MCP_ENDPOINT', 'GH_REPO', 'GH_HOST'].includes(upper)
      || GITHUB_CREDENTIAL_ENV.includes(upper)
      || (upper.startsWith('PROJECTS_') && (upper.endsWith('_TOKEN') || upper.endsWith('_POLICY')))
      || upper.startsWith('AWS_')
      || upper.startsWith('GIT_CONFIG_') || upper.startsWith('GIT_TRACE') || upper.startsWith('GIT_REDIRECT_')
      || upper === 'GIT_CURL_VERBOSE' || upper === 'GCM_TRACE' || [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SSH_COMMAND'
    ].includes(upper)) delete safe[key];
  }
  safe.GH_PROMPT_DISABLED = '1';
  safe.GH_PAGER = 'cat';
  safe.GIT_PAGER = 'cat';
  safe.PAGER = 'cat';
  const authentication = githubPublisherAuthentication(env);
  if (credentialScope !== 'none' && !authentication.valid) throw new Error('github_credential_invalid');
  if (credentialScope === 'github-api' && authentication.token) safe.GH_TOKEN = authentication.token;
  if (credentialScope === 'github-git') {
    safe.GIT_TERMINAL_PROMPT = '0';
    safe.GCM_INTERACTIVE = 'Never';
    if (authentication.token) {
      const authorization = Buffer.from(`x-access-token:${authentication.token}`, 'utf8').toString('base64');
      safe.GIT_CONFIG_COUNT = '6';
      safe.GIT_CONFIG_KEY_0 = 'credential.helper';
      safe.GIT_CONFIG_VALUE_0 = '';
      safe.GIT_CONFIG_KEY_1 = 'credential.interactive';
      safe.GIT_CONFIG_VALUE_1 = 'never';
      safe.GIT_CONFIG_KEY_2 = 'http.extraHeader';
      safe.GIT_CONFIG_VALUE_2 = '';
      safe.GIT_CONFIG_KEY_3 = 'http.https://github.com/.extraHeader';
      safe.GIT_CONFIG_VALUE_3 = '';
      safe.GIT_CONFIG_KEY_4 = `http.${credentialUrl}.extraHeader`;
      safe.GIT_CONFIG_VALUE_4 = '';
      safe.GIT_CONFIG_KEY_5 = `http.${credentialUrl}.extraHeader`;
      safe.GIT_CONFIG_VALUE_5 = `AUTHORIZATION: basic ${authorization}`;
    }
  }
  return safe;
}

const failure = (reason, processUncertain = false) => ({
  exitCode: 1, stdout: '', stderr: '', terminationReason: reason, processUncertain
});

/** Internal policy; no CLI/environment override or worker-supplied runner options. */
export function processOptions(invocation, platform = process.platform) {
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) throw Error();
  const { executable, args = [], cwd, shell = false, timeoutMs, credentialScope = 'none', credentialUrl } = invocation;
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || typeof shell !== 'boolean' || !['none', 'github-api', 'github-git'].includes(credentialScope)
      || (credentialScope === 'github-api' && executable !== 'gh')
      || (credentialScope === 'github-git' && executable !== 'git')
      || (credentialScope === 'github-git' && !githubCredentialUrl(credentialUrl))
      || (credentialScope !== 'github-git' && credentialUrl !== undefined)
      || (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0')))) throw Error();
  // Validate the original spelling: normalization could hide './node' or 'x/../node'
  // while spawn would still receive that path. PATH and installed tools remain trusted.
  // The fixed Unix doctor probe is the sole non-shell absolute-path exception.
  const unixShell = !shell && platform !== 'win32' && executable === '/bin/sh';
  if (!shell && !unixShell && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(executable)) throw Error();
  const timeout = timeoutMs === undefined
    ? (shell ? VERIFICATION_TIMEOUT_MS : PROCESS_TIMEOUT_MS) : timeoutMs;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > VERIFICATION_TIMEOUT_MS) throw Error();
  return {
    executable: shell ? (platform === 'win32' ? 'pwsh' : '/bin/sh') : (unixShell ? '/bin/sh' : executable),
    args: shell ? (platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', executable]
      : ['-c', executable]) : [...args],
    cwd, timeoutMs: timeout, credentialScope,
    credentialUrl: credentialScope === 'github-git' ? githubCredentialUrl(credentialUrl) : null
  };
}

/** Trusted dependency seams are for tests only, never accepted from CLI/JSON input. */
export function createBoundedProcessRunner({ spawnProcess = spawn, setTimer = setTimeout, clearTimer = clearTimeout,
  env = process.env } = {}) {
  const sessionEnvironment = { ...env };
  const publisherAuthentication = githubPublisherAuthentication(sessionEnvironment);
  let safeHooksPath = null;
  const boundedRunner = async invocation => {
    let options;
    try { options = processOptions(invocation); }
    catch { return failure('invalid_invocation'); }
    return new Promise(resolve => {
      let child; let timer; let settled = false; let spawned = false; let exited = false;
      const chunks = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (result.processUncertain) {
          // Killing this child is an attempt, not evidence of descendant quiescence.
          // Never signal an already observed exited PID (it may have been reused).
          if (!exited && (spawned || Number.isInteger(child?.pid))) {
            try { child.kill('SIGKILL'); } catch { /* Retain uncertainty. */ }
          }
          // Descendants may hold inherited pipes after exit; do not await their EOF.
          child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
        }
        chunks.stdout.length = 0; chunks.stderr.length = 0;
        resolve(result);
      };
      const interrupt = reason => finish(failure(reason, true));
      try {
        if (options.executable === 'git') {
          safeHooksPath ??= mkdtempSync(path.join(os.tmpdir(), 'projects-pr-no-hooks-'));
          // Derived worktrees can exceed Windows' legacy path limit. Keep this
          // on each Git command so checkout and inspection agree without edits to bound config.
          options.args = ['-c', 'core.longpaths=true', '-c', `core.hooksPath=${safeHooksPath}`, '-c', 'core.fsmonitor=false',
            '-c', 'core.untrackedCache=false', ...options.args];
        }
        let childEnvironment;
        try { childEnvironment = safeSubprocessEnvironment(sessionEnvironment, options.credentialScope, options.credentialUrl); }
        catch { finish(failure('github_credential_invalid')); return; }
        child = spawnProcess(options.executable, options.args, {
          cwd: options.cwd, env: childEnvironment, shell: false, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch { finish(failure('spawn_failed')); return; }
      child.once('spawn', () => { spawned = true; });
      child.on('error', () => {
        if (spawned || Number.isInteger(child.pid)) interrupt('process_error');
        else finish(failure('spawn_failed'));
      });
      child.once('exit', (_code, signal) => {
        exited = true;
        if (signal) interrupt('signal');
      });
      child.once('close', (code, signal) => {
        exited = true;
        if (settled) return;
        if (signal || !Number.isInteger(code) || code < 0) { interrupt('signal'); return; }
        finish({ exitCode: code,
          stdout: Buffer.concat(chunks.stdout, sizes.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr, sizes.stderr).toString('utf8') });
      });
      for (const name of ['stdout', 'stderr']) {
        child[name].on('error', () => interrupt('stream_error'));
        child[name].on('data', chunk => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { interrupt('stream_error'); return; }
          if (sizes[name] + chunk.length > PROCESS_OUTPUT_BYTES) { interrupt('output_limit'); return; }
          sizes[name] += chunk.length;
          chunks[name].push(chunk);
        });
      }
      // Includes process exit AND pipe completion, not just a child's exit event.
      timer = setTimer(() => interrupt('timeout'), options.timeoutMs);
    });
  };
  Object.defineProperty(boundedRunner, 'githubPublisherMode', {
    value: publisherAuthentication.mode, enumerable: false, writable: false
  });
  return boundedRunner;
}

export const defaultProjectsPrRunner = createBoundedProcessRunner();

/** Latch uncertainty outside the core, which may catch/normalize command results. */
export function createProcessSession(runner = defaultProjectsPrRunner) {
  let uncertain = false;
  const sessionRunner = async invocation => {
    if (uncertain) return failure('session_stopped', true);
    const result = await runner(invocation);
    if (result?.processUncertain === true) {
      uncertain = true;
      return failure('process_uncertain', true);
    }
    return result;
  };
  Object.defineProperty(sessionRunner, 'githubPublisherMode', {
    value: runner.githubPublisherMode, enumerable: false, writable: false
  });
  return Object.freeze({ canRelease: () => !uncertain, runner: sessionRunner });
}
