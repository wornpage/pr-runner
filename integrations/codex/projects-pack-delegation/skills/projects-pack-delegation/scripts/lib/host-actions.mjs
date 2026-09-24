import fs from 'node:fs/promises';
import path from 'node:path';
import { assertActionAuthority } from './action-authority.mjs';
import { sha256, validateAction } from './protocol.mjs';

const COMMIT = /^[a-f0-9]{40}$/u;

export class ActionExecutionError extends Error {
  constructor(code, { uncertain = false } = {}) {
    super('The bounded local action failed.');
    this.name = 'ActionExecutionError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

const fail = (code, options) => { throw new ActionExecutionError(code, options); };
const samePath = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;
const oid = value => {
  const match = String(value ?? '').trim().match(/^([a-f0-9]{40})(?:\s|$)/u);
  return match?.[1] ?? null;
};

function shellVersionForReport(platform, result) {
  if (result?.exitCode !== 0) return null;
  if (platform !== 'win32') return 'POSIX';
  const version = String(result.stdout ?? '').trim().slice(0, 80);
  return version || null;
}

function exactUpToDatePushDryRun(result, baseSha, baseBranch, expectedUrl) {
  if (result?.exitCode !== 0 || typeof result.stdout !== 'string'
      || !result.stdout.endsWith('\n') || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(result.stdout)
      || !repositoryFromRemote(expectedUrl)) return false;
  const lines = result.stdout.slice(0, -1).split('\n');
  if (lines.length !== 1 && (lines.length !== 3
      || lines[0] !== `To ${expectedUrl}` || lines[2] !== 'Done')) return false;
  const fields = lines[lines.length === 1 ? 0 : 1].split('\t');
  return fields.length === 3 && fields[0] === '=' && fields[2].length > 0
    && fields[1] === `${baseSha}:refs/heads/${baseBranch}`;
}

async function run(runner, executable, args, cwd, code = 'host_action_failed', credentialScope = 'none', credentialUrl) {
  const result = await runner({ executable, args, cwd, shell: false, timeoutMs: 30_000, credentialScope, credentialUrl });
  if (result?.processUncertain) fail('subprocess_uncertain', { uncertain: true });
  if (result?.exitCode !== 0) fail(code);
  return result.stdout;
}

async function optional(runner, executable, args, cwd, credentialScope = 'none', credentialUrl) {
  const result = await runner({ executable, args, cwd, shell: false, timeoutMs: 30_000, credentialScope, credentialUrl });
  if (result?.processUncertain) fail('subprocess_uncertain', { uncertain: true });
  return result;
}

export function repositoryFromRemote(value) {
  const text = String(value ?? '').trim();
  let match;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
        || url.username || url.password || url.search || url.hash) return null;
    match = url.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u);
    return match?.[1] ?? null;
  } catch { return null; }
}

async function assertRepositoryIdentity(state, params, runner) {
  if (params.repository !== state.repository) fail('repository_mismatch');
  const remote = params.remote ?? state.remote;
  const urls = (await run(runner, 'git', ['remote', 'get-url', '--all', remote], state.repositoryRoot,
    'remote_unavailable')).split(/\r?\n/gu).filter(Boolean);
  const pushUrls = (await run(runner, 'git', ['remote', 'get-url', '--push', '--all', remote], state.repositoryRoot,
    'remote_unavailable')).split(/\r?\n/gu).filter(Boolean);
  if (urls.length !== 1 || pushUrls.length !== 1
      || repositoryFromRemote(urls[0])?.toLowerCase() !== state.repository.toLowerCase()
      || repositoryFromRemote(pushUrls[0])?.toLowerCase() !== state.repository.toLowerCase()) {
    fail('repository_mismatch');
  }
  const config = await run(runner, 'git', ['config', '--local', '--null', '--list'], state.repositoryRoot,
    'repository_unavailable');
  if (!state.gitConfigSha256 || sha256(config) !== state.gitConfigSha256) fail('git_config_changed');
  return { fetchUrl: urls[0], pushUrl: pushUrls[0] };
}

async function gitCommon(state, runner) {
  const value = (await run(runner, 'git', ['rev-parse', '--git-common-dir'], state.repositoryRoot,
    'repository_unavailable')).trim();
  try { return await fs.realpath(path.resolve(state.repositoryRoot, value)); }
  catch { fail('repository_unavailable'); }
}

async function worktreeRecords(state, runner) {
  const output = await run(runner, 'git', ['worktree', 'list', '--porcelain'], state.repositoryRoot,
    'repository_unavailable');
  const records = [];
  let record = null;
  for (const line of output.split(/\r?\n/gu)) {
    if (line.startsWith('worktree ')) {
      if (record) records.push(record);
      record = { path: line.slice(9), branch: null, head: null };
    } else if (record && line.startsWith('HEAD ')) record.head = line.slice(5);
    else if (record && line.startsWith('branch refs/heads/')) record.branch = line.slice(18);
  }
  if (record) records.push(record);
  return records;
}

async function ensureWorktreeBase(state) {
  const repositoryParent = await fs.realpath(path.dirname(state.repositoryRoot));
  if (samePath(repositoryParent, path.parse(repositoryParent).root)) fail('unsafe_worktree_path');
  const base = path.join(repositoryParent, '.projects-pr-worktrees');
  try { await fs.mkdir(base, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') fail('unsafe_worktree_path'); }
  const stat = await fs.lstat(base);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_worktree_path');
  const real = await fs.realpath(base);
  if (!samePath(real, base)) fail('unsafe_worktree_path');
  return real;
}

async function derivedWorktreePath(state, worktreeName) {
  const base = await ensureWorktreeBase(state);
  const target = path.resolve(base, worktreeName);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe_worktree_path');
  return target;
}

async function observedWorktreePath(state, worktreeName) {
  const repositoryParent = await fs.realpath(path.dirname(state.repositoryRoot));
  if (samePath(repositoryParent, path.parse(repositoryParent).root)) fail('unsafe_worktree_path');
  const base = path.join(repositoryParent, '.projects-pr-worktrees');
  try {
    const stat = await fs.lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(base), base)) {
      fail('unsafe_worktree_path');
    }
  } catch (error) {
    if (error instanceof ActionExecutionError) throw error;
    if (error?.code !== 'ENOENT') fail('unsafe_worktree_path');
  }
  const target = path.resolve(base, worktreeName);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe_worktree_path');
  return target;
}

async function localRef(state, runner, branch) {
  const result = await optional(runner, 'git', ['rev-parse', '--verify', `refs/heads/${branch}`], state.repositoryRoot);
  return result.exitCode === 0 ? oid(result.stdout) : null;
}

async function remoteRef(state, runner, remote, branch) {
  const result = await optional(runner, 'git', ['ls-remote', '--heads', remote, `refs/heads/${branch}`], state.repositoryRoot,
    'github-git', remote);
  if (result.exitCode !== 0) return { reachable: false, sha: null };
  return { reachable: true, sha: oid(result.stdout) };
}

async function inspectWorktree(state, runner, branch, target = state.worktreePath) {
  const records = await worktreeRecords(state, runner);
  const record = records.find(item => item.branch === branch)
    ?? (target ? records.find(item => samePath(path.resolve(item.path), path.resolve(target))) : null);
  let exists = false;
  if (target) {
    try {
      const stat = await fs.lstat(target);
      exists = true;
      if (record && (!stat.isDirectory() || stat.isSymbolicLink())) fail('unsafe_worktree_path');
    } catch (error) { if (error?.code !== 'ENOENT') fail('unsafe_worktree_path'); }
  }
  if (!record || !exists) return { registered: Boolean(record), exists, clean: null, headSha: null };
  const root = await fs.realpath(target);
  if (!samePath(root, target)) fail('unsafe_worktree_path');
  const clean = !(await run(runner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], target,
    'candidate_unavailable')).trim();
  const headSha = oid(await run(runner, 'git', ['rev-parse', 'HEAD'], target, 'candidate_unavailable'));
  return { registered: true, exists: true, clean, headSha };
}

async function defaultListPullRequests(state, runner, branch) {
  const result = await optional(runner, 'gh', ['pr', 'list', '--repo', state.repository, '--head', branch,
    '--state', 'all', '--limit', '3', '--json',
    'number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository'], state.repositoryRoot,
  'github-api');
  if (result.exitCode !== 0) fail('provider_unavailable');
  let values;
  try { values = JSON.parse(result.stdout); } catch { fail('provider_response_invalid'); }
  if (!Array.isArray(values) || values.length > 2) fail('provider_response_invalid');
  return values.map(value => normalizePullRequest(value, state.repository));
}

function normalizePullRequest(value, repository) {
  const state = String(value?.state ?? '').toLowerCase();
  const result = {
    number: value?.number,
    url: value?.url,
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'open' ? 'open' : null,
    draft: value?.isDraft,
    baseRef: value?.baseRefName,
    baseSha: value?.baseRefOid,
    headRef: value?.headRefName,
    headSha: value?.headRefOid,
    baseRepository: repository,
    headRepository: value?.headRepository?.nameWithOwner
  };
  if (!Number.isInteger(result.number) || result.number < 1
      || result.url !== `https://github.com/${repository}/pull/${result.number}`
      || !result.state || typeof result.draft !== 'boolean' || typeof result.baseRef !== 'string'
      || !COMMIT.test(result.baseSha) || typeof result.headRef !== 'string' || !COMMIT.test(result.headSha)
      || result.baseRepository !== repository || result.headRepository !== repository) fail('provider_response_invalid');
  return result;
}

async function listPullRequests(state, runner, provider, branch) {
  const values = provider?.listPullRequests
    ? await provider.listPullRequests({ repository: state.repository, branch })
    : await defaultListPullRequests(state, runner, branch);
  if (!Array.isArray(values) || values.length > 2) fail('provider_response_invalid');
  return values.map(value => {
    if (!value.baseRepository) return normalizePullRequest(value, state.repository);
    if (value.baseRepository !== state.repository) fail('provider_response_invalid');
    return normalizePullRequest({ number: value.number, url: value.url, state: String(value.state).toUpperCase(),
      isDraft: value.draft, baseRefName: value.baseRef, baseRefOid: value.baseSha,
      headRefName: value.headRef, headRefOid: value.headSha,
      headRepository: { nameWithOwner: value.headRepository } }, state.repository);
  });
}

async function observeRepository(state, params, runner, provider) {
  const identity = await assertRepositoryIdentity(state, params, runner);
  const baseBranch = params.baseBranch;
  const remote = params.remote;
  const branch = params.branch ?? baseBranch;
  const status = await run(runner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], state.repositoryRoot,
    'repository_unavailable');
  const currentBranch = (await run(runner, 'git', ['branch', '--show-current'], state.repositoryRoot,
    'repository_unavailable')).trim();
  const headSha = oid(await run(runner, 'git', ['rev-parse', 'HEAD'], state.repositoryRoot, 'repository_unavailable'));
  const localBaseSha = await localRef(state, runner, baseBranch);
  const remoteBase = await remoteRef(state, runner, identity.fetchUrl, baseBranch);
  const localBranchSha = await localRef(state, runner, branch);
  const remoteBranch = await remoteRef(state, runner, identity.fetchUrl, branch);
  const pushUrls = (await run(runner, 'git', ['remote', 'get-url', '--push', '--all', remote], state.repositoryRoot,
    'remote_unavailable')).split(/\r?\n/gu).filter(Boolean);
  const config = await run(runner, 'git', ['config', '--local', '--null', '--list'], state.repositoryRoot,
    'repository_unavailable');
  const plannedTarget = params.worktreeName ? await observedWorktreePath(state, params.worktreeName) : state.worktreePath;
  const worktree = params.branch ? await inspectWorktree(state, runner, branch, plannedTarget)
    : { registered: false, exists: false, clean: null, headSha: null };
  const pulls = params.branch ? await listPullRequests(state, runner, provider, branch) : [];
  if (!currentBranch || !headSha || !localBaseSha || !remoteBase.sha || pushUrls.length > 8) {
    fail('repository_observation_incomplete');
  }
  return {
    kind: 'repository', repositoryRootSha256: sha256(state.repositoryRoot), clean: !status.trim(),
    currentBranch, headSha, baseRef: baseBranch, localBaseSha, remoteBaseSha: remoteBase.sha,
    repository: state.repository, remote, pushUrlCount: pushUrls.length,
    pushUrlRepository: pushUrls.length === 1 ? repositoryFromRemote(pushUrls[0]) : null,
    gitConfigSha256: sha256(config), worktree,
    localBranch: { exists: Boolean(localBranchSha), sha: localBranchSha },
    remoteBranch: { reachable: remoteBranch.reachable, exists: Boolean(remoteBranch.sha), sha: remoteBranch.sha },
    pullRequests: pulls
  };
}

async function observeHost(state, params, runner, provider) {
  const identity = await assertRepositoryIdentity(state, { repository: params.repository, remote: state.remote }, runner);
  const git = await optional(runner, 'git', ['--version'], state.repositoryRoot);
  const shellKind = process.platform === 'win32' ? 'pwsh' : 'sh';
  const shell = process.platform === 'win32'
    ? await optional(runner, 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], state.repositoryRoot)
    : await optional(runner, '/bin/sh', ['-c', 'printf %s POSIX'], state.repositoryRoot);
  let github = null; let stack = null;
  if (provider?.observeHost) ({ github, stack } = await provider.observeHost({ repository: state.repository }));
  else {
    const version = await optional(runner, 'gh', ['--version'], state.repositoryRoot);
    const installation = runner.githubPublisherMode === 'github_app_installation_token'
      ? await optional(runner, 'gh', ['api', '--method', 'GET', 'installation/repositories?per_page=1'],
        state.repositoryRoot, 'github-api') : null;
    const view = await optional(runner, 'gh', ['api', '--method', 'GET', `repos/${state.repository}`],
      state.repositoryRoot, 'github-api');
    let viewed = null;
    try { if (view.exitCode === 0) viewed = JSON.parse(view.stdout); } catch { /* unavailable */ }
    let installedRepository = null;
    try {
      if (installation?.exitCode === 0) {
        const installed = JSON.parse(installation.stdout);
        if (installed?.total_count === 1 && Array.isArray(installed.repositories) && installed.repositories.length === 1
            && Number.isSafeInteger(installed.repositories[0]?.id) && installed.repositories[0].id > 0
            && installed.repositories[0].full_name?.toLowerCase() === state.repository.toLowerCase()) {
          installedRepository = installed.repositories[0];
        }
      }
    } catch { /* unavailable */ }
    const repositoryVerified = view.exitCode === 0 && Number.isSafeInteger(viewed?.id) && viewed.id > 0
      && viewed.full_name?.toLowerCase() === state.repository.toLowerCase();
    const installationVerified = installation === null || (installedRepository?.id === viewed?.id
      && installedRepository.full_name.toLowerCase() === viewed.full_name.toLowerCase());
    const appPublisher = runner.githubPublisherMode === 'github_app_installation_token';
    // App installation tokens expose false repository user-permission flags even
    // with contents:write. A dry-run push selects receive-pack but sends no update.
    const writeProbe = appPublisher && installationVerified && repositoryVerified
      ? await optional(runner, 'git', ['push', '--dry-run', '--porcelain', '--no-verify', identity.pushUrl,
        `${state.baseSha}:refs/heads/${state.baseBranch}`], state.repositoryRoot, 'github-git', identity.pushUrl)
      : null;
    const appPushPermission = exactUpToDatePushDryRun(writeProbe, state.baseSha, state.baseBranch, identity.pushUrl);
    github = { version: version.exitCode === 0 ? version.stdout.split(/\r?\n/u)[0].slice(0, 80) : null,
      authenticated: installationVerified && repositoryVerified, repository: viewed?.full_name ?? null,
      pushPermission: appPublisher ? appPushPermission : viewed?.permissions?.push === true };
    const extensions = await optional(runner, 'gh', ['extension', 'list'], state.repositoryRoot);
    const matches = extensions.exitCode === 0 ? extensions.stdout.split(/\r?\n/gu)
      .filter(line => /(?:^|\s)github\/gh-stack(?:\s|$)/u.test(line)) : [];
    stack = { extensionCount: Math.min(matches.length, 32), publisher: matches.length === 1 ? 'github' : null,
      commandAvailable: matches.length === 1 };
  }
  return { kind: 'host', platform: process.platform, nodeVersion: process.versions.node,
    gitVersion: git.exitCode === 0 ? git.stdout.trim().slice(0, 80) : '',
    shell: { kind: shellKind, available: shell.exitCode === 0,
      version: shellVersionForReport(process.platform, shell) }, github, stack };
}

async function createWorktree(state, params, runner, { recovery, persist }) {
  const identity = await assertRepositoryIdentity(state, params, runner);
  const rootStatus = await run(runner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], state.repositoryRoot,
    'repository_unavailable');
  const base = await localRef(state, runner, params.baseBranch);
  if (rootStatus.trim() || base !== params.baseSha || params.headSha !== params.baseSha) {
    fail('repository_mismatch');
  }
  const remoteBase = await remoteRef(state, runner, identity.fetchUrl, params.baseBranch);
  const remoteBranch = await remoteRef(state, runner, identity.fetchUrl, params.branch);
  if (!remoteBase.reachable || remoteBase.sha !== params.baseSha || !remoteBranch.reachable || remoteBranch.sha
      || await localRef(state, runner, params.branch)) fail('repository_mismatch');
  const target = await derivedWorktreePath(state, params.worktreeName);
  if (state.worktreePath && !samePath(state.worktreePath, target)) fail('worktree_mismatch');
  const records = await worktreeRecords(state, runner);
  let exists = false;
  try { await fs.lstat(target); exists = true; } catch (error) { if (error?.code !== 'ENOENT') fail('unsafe_worktree_path'); }
  state.worktreePath = target;
  state.createdBranch = params.branch;
  await persist();
  const existing = records.find(record => samePath(path.resolve(record.path), target));
  if (recovery && existing && exists && existing.branch === params.branch && existing.head === params.headSha) {
    const observed = await inspectWorktree(state, runner, params.branch);
    if (observed.clean) return { kind: 'worktree', repositoryRootSha256: sha256(state.repositoryRoot),
      branch: params.branch, headSha: observed.headSha, clean: true, registered: true };
  }
  if (existing || exists) fail('worktree_exists');
  try {
    await run(runner, 'git', ['worktree', 'add', '-b', params.branch, target, params.headSha], state.repositoryRoot,
      'worktree_create_failed');
  } catch (error) {
    if (error instanceof ActionExecutionError && error.uncertain) throw error;
    const reconciled = await inspectWorktree(state, runner, params.branch).catch(() => null);
    if (reconciled?.registered || reconciled?.exists) fail('worktree_effect_uncertain', { uncertain: true });
    throw error;
  }
  let observed;
  try { observed = await inspectWorktree(state, runner, params.branch); }
  catch { fail('worktree_effect_uncertain', { uncertain: true }); }
  if (!observed.registered || !observed.exists || !observed.clean || observed.headSha !== params.headSha) {
    fail('worktree_effect_uncertain', { uncertain: true });
  }
  return { kind: 'worktree', repositoryRootSha256: sha256(state.repositoryRoot), branch: params.branch,
    headSha: observed.headSha, clean: observed.clean, registered: observed.registered };
}

async function observeCandidate(state, params, runner) {
  await assertRepositoryIdentity(state, params, runner);
  if (state.createdBranch !== params.branch || !state.worktreePath) fail('worktree_mismatch');
  const observed = await inspectWorktree(state, runner, params.branch);
  if (!observed.registered || !observed.exists || observed.headSha !== params.headSha) fail('candidate_mismatch');
  return { kind: 'worktree', repositoryRootSha256: sha256(state.repositoryRoot), branch: params.branch,
    headSha: observed.headSha, clean: observed.clean, registered: observed.registered };
}

async function pushBranch(state, params, runner) {
  const identity = await assertRepositoryIdentity(state, params, runner);
  if (state.createdBranch !== params.branch || !state.worktreePath) fail('candidate_mismatch');
  const candidate = await inspectWorktree(state, runner, params.branch);
  if (!candidate.registered || !candidate.exists || !candidate.clean || candidate.headSha !== params.headSha) fail('candidate_mismatch');
  const before = await remoteRef(state, runner, identity.pushUrl, params.branch);
  if (!before.reachable) fail('remote_unavailable');
  if (before.sha && before.sha !== params.headSha) fail('remote_branch_mismatch');
  if (!before.sha) {
    try {
      await run(runner, 'git', ['push', `--force-with-lease=refs/heads/${params.branch}:`, identity.pushUrl,
        `${params.headSha}:refs/heads/${params.branch}`], state.worktreePath, 'push_failed', 'github-git', identity.pushUrl);
    } catch (error) {
      if (error instanceof ActionExecutionError && error.uncertain) throw error;
      const raced = await remoteRef(state, runner, identity.pushUrl, params.branch);
      if (raced.sha) fail('remote_branch_raced');
      throw error;
    }
  }
  let after;
  try { after = await remoteRef(state, runner, identity.pushUrl, params.branch); }
  catch { fail('push_effect_uncertain', { uncertain: true }); }
  if (!after.reachable || after.sha !== params.headSha) fail('push_effect_uncertain', { uncertain: true });
  return { kind: 'push', branch: params.branch, headSha: params.headSha, remoteSha: after.sha };
}

async function createPullRequest(state, params, runner, provider) {
  await assertRepositoryIdentity(state, { repository: params.repository, remote: state.remote }, runner);
  if (params.repository !== state.repository || params.branch !== state.createdBranch) fail('candidate_mismatch');
  let pulls = await listPullRequests(state, runner, provider, params.branch);
  if (pulls.length > 1 || (pulls.length === 1 && (pulls[0].headSha !== params.headSha
      || pulls[0].baseRef !== params.baseBranch || !pulls[0].draft))) fail('pull_request_mismatch');
  if (pulls.length === 0) {
    const body = `Created from a reported Projects worker handoff. Acceptance is pending trusted verification and independent owner review.\n\nRequired verification run name: \`projects-acceptance:${params.providerBindingSha256}\`\nPublic publication binding: \`${params.bindingSha256}\``;
    try {
      if (provider?.createPullRequest) await provider.createPullRequest({ repository: state.repository,
        baseBranch: params.baseBranch, branch: params.branch, headSha: params.headSha, title: params.title,
        draft: true, body });
      else await run(runner, 'gh', ['pr', 'create', '--repo', state.repository, '--base', params.baseBranch,
        '--head', params.branch, '--title', params.title, '--body', body, '--draft'],
      state.repositoryRoot, 'pull_request_create_failed', 'github-api');
      pulls = await listPullRequests(state, runner, provider, params.branch);
    } catch (error) {
      if (error instanceof ActionExecutionError && error.uncertain) throw error;
      fail('pull_request_effect_uncertain', { uncertain: true });
    }
  }
  if (pulls.length !== 1 || pulls[0].headSha !== params.headSha || !pulls[0].draft) fail('pull_request_verification_failed');
  return { kind: 'pull_request', pullRequest: pulls[0] };
}

async function observePullRequest(state, params, runner, provider) {
  await assertRepositoryIdentity(state, params, runner);
  const pulls = await listPullRequests(state, runner, provider, params.branch);
  if (!Object.hasOwn(params, 'pullRequest')) return observeRepository(state, params, runner, provider);
  const pull = pulls.find(item => item.number === params.pullRequest);
  if (!pull || pull.headSha !== params.headSha || pull.baseRef !== params.baseBranch) fail('pull_request_mismatch');
  return { kind: 'pull_request', pullRequest: pull };
}

async function removeWorktree(state, params, runner) {
  await assertRepositoryIdentity(state, { repository: params.repository, remote: state.remote }, runner);
  if (params.repository !== state.repository || params.branch !== state.createdBranch || !state.worktreePath) fail('cleanup_refused');
  const observed = await inspectWorktree(state, runner, params.branch);
  if (!observed.registered && !observed.exists) {
    return { kind: 'cleanup', worktreeRemoved: true,
      localBranchPresent: Boolean(await localRef(state, runner, params.branch)), headSha: params.headSha };
  }
  if (!observed.registered || !observed.exists || !observed.clean || observed.headSha !== params.headSha) fail('cleanup_refused');
  try { await run(runner, 'git', ['worktree', 'remove', state.worktreePath], state.repositoryRoot, 'cleanup_failed'); }
  catch (error) {
    if (error instanceof ActionExecutionError && error.uncertain) throw error;
    const reconciled = await inspectWorktree(state, runner, params.branch).catch(() => null);
    if (reconciled && !reconciled.registered && !reconciled.exists) return { kind: 'cleanup',
      worktreeRemoved: true, localBranchPresent: Boolean(await localRef(state, runner, params.branch)), headSha: params.headSha };
    throw error;
  }
  const after = await inspectWorktree(state, runner, params.branch).catch(() => null);
  if (!after || after.registered || after.exists) fail('cleanup_effect_uncertain', { uncertain: true });
  return { kind: 'cleanup', worktreeRemoved: true,
    localBranchPresent: Boolean(await localRef(state, runner, params.branch)), headSha: params.headSha };
}

async function removeLocalBranch(state, params, runner) {
  await assertRepositoryIdentity(state, { repository: params.repository, remote: state.remote }, runner);
  if (params.repository !== state.repository || params.branch !== state.createdBranch || !state.worktreePath) fail('cleanup_refused');
  const worktree = await inspectWorktree(state, runner, params.branch);
  if (worktree.registered || worktree.exists) fail('cleanup_refused');
  const before = await localRef(state, runner, params.branch);
  if (before && before !== params.headSha) fail('cleanup_refused');
  if (before) {
    try { await run(runner, 'git', ['branch', '--delete', '--force', params.branch], state.repositoryRoot, 'cleanup_failed'); }
    catch (error) {
      if (error instanceof ActionExecutionError && error.uncertain) throw error;
      if (!await localRef(state, runner, params.branch)) return { kind: 'cleanup', worktreeRemoved: true,
        localBranchPresent: false, headSha: params.headSha };
      throw error;
    }
  }
  if (await localRef(state, runner, params.branch)) fail('cleanup_effect_uncertain', { uncertain: true });
  return { kind: 'cleanup', worktreeRemoved: true, localBranchPresent: false, headSha: params.headSha };
}

async function stackPullRequests(state, params, runner, provider, journals) {
  await assertRepositoryIdentity(state, params, runner);
  if (params.repository !== state.repository || !Array.isArray(journals) || journals.length !== params.packIds.length) {
    fail('stack_mismatch');
  }
  const pulls = [];
  for (let index = 0; index < journals.length; index += 1) {
    const journal = journals[index];
    if (journal.packId !== params.packIds[index] || journal.repository !== state.repository
        || !journal.createdBranch) fail('stack_mismatch');
    const matches = await listPullRequests(journal, runner, provider, journal.createdBranch);
    const pull = matches.find(item => item.number === params.pullRequests[index]);
    const expectedBase = index === 0 ? params.baseBranch : journals[index - 1].createdBranch;
    if (!pull || pull.url !== `https://github.com/${state.repository}/pull/${params.pullRequests[index]}`
        || pull.state !== 'open' || pull.draft !== true || pull.baseRef !== expectedBase
        || pull.baseSha !== journal.baseSha || pull.headRef !== journal.createdBranch
        || pull.headSha !== journal.candidateHead || pull.baseRepository !== state.repository
        || pull.headRepository !== state.repository) fail('stack_mismatch');
    pulls.push(pull);
  }
  return pulls;
}

async function stackMembership(state, params, runner, provider) {
  if (provider?.observeStackMembership) {
    const value = await provider.observeStackMembership({ repository: state.repository, pullRequests: params.pullRequests });
    if (value === null) return null;
    if (!value || !Number.isInteger(value.number) || value.number < 1
        || !Array.isArray(value.pullRequests) || value.pullRequests.length !== params.pullRequests.length
        || value.pullRequests.some((number, index) => number !== params.pullRequests[index])) {
      fail('stack_membership_mismatch');
    }
    return { number: value.number, pullRequests: [...value.pullRequests] };
  }
  const observed = [];
  for (const number of params.pullRequests) {
    const output = await run(runner, 'gh', ['api', '--method', 'GET',
      `repos/${state.repository}/stacks`, '-f', `pull_request=${number}`, '-f', 'per_page=2', '-f', 'page=1'],
    state.repositoryRoot, 'stack_observation_failed', 'github-api');
    let values;
    try { values = JSON.parse(output); } catch { fail('stack_observation_failed'); }
    if (!Array.isArray(values) || values.length > 1) fail('stack_membership_ambiguous');
    observed.push(values[0] ?? null);
  }
  if (observed.every(value => value === null)) return null;
  if (observed.some(value => value === null)) fail('stack_membership_mismatch');
  const numbers = observed.map(value => value?.number);
  if (!numbers.every(number => Number.isInteger(number) && number === numbers[0])) fail('stack_membership_mismatch');
  const stack = observed[0];
  if (stack?.open !== true || stack?.base?.ref !== params.baseBranch || !Array.isArray(stack.pull_requests)
      || stack.pull_requests.length !== params.pullRequests.length
      || stack.pull_requests.some((pull, index) => pull?.number !== params.pullRequests[index])) {
    fail('stack_membership_mismatch');
  }
  return { number: stack.number, pullRequests: [...params.pullRequests] };
}

async function observeStack(state, params, runner, provider, journals) {
  const pulls = await stackPullRequests(state, params, runner, provider, journals);
  if (!await stackMembership(state, params, runner, provider)) fail('stack_verification_failed');
  return { kind: 'stack', pullRequests: pulls };
}

async function linkStack(state, params, runner, provider, journals, recovery) {
  if (recovery) fail('stack_effect_uncertain', { uncertain: true });
  const pulls = await stackPullRequests(state, params, runner, provider, journals);
  await stackMembership(state, params, runner, provider);
  const urls = pulls.map(pull => pull.url);
  try {
    if (provider?.linkStack) await provider.linkStack({ repository: state.repository, baseBranch: params.baseBranch,
      remote: params.remote, pullRequestUrls: urls });
    else await run(runner, 'gh', ['stack', 'link', '--base', params.baseBranch, '--remote', params.remote,
      ...urls], state.repositoryRoot, 'stack_link_failed', 'github-api');
  } catch (error) {
    if (error instanceof ActionExecutionError && error.uncertain) throw error;
    fail('stack_effect_uncertain', { uncertain: true });
  }
  let membership;
  try { membership = await stackMembership(state, params, runner, provider); }
  catch { fail('stack_effect_uncertain', { uncertain: true }); }
  if (!membership) fail('stack_verification_failed');
  const after = await stackPullRequests(state, params, runner, provider, journals);
  return { kind: 'stack', pullRequests: after };
}

export async function executeAction(action, context) {
  action = validateAction(action);
  assertActionAuthority(context?.operation, action.kind);
  const { state, runner, provider, journals, recovery = false, persist = async () => {} } = context;
  switch (action.kind) {
    case 'observe_host': return observeHost(state, action.params, runner, provider);
    case 'observe_repository': return observeRepository(state, action.params, runner, provider);
    case 'create_worktree': return createWorktree(state, action.params, runner, { recovery, persist });
    case 'observe_candidate': return observeCandidate(state, action.params, runner);
    case 'push_branch': return pushBranch(state, action.params, runner);
    case 'create_pull_request': return createPullRequest(state, action.params, runner, provider);
    case 'observe_pull_request': return observePullRequest(state, action.params, runner, provider);
    case 'remove_worktree': return removeWorktree(state, action.params, runner);
    case 'remove_local_branch': return removeLocalBranch(state, action.params, runner);
    case 'link_stack': return linkStack(state, action.params, runner, provider, journals, recovery);
    case 'observe_stack': return observeStack(state, action.params, runner, provider, journals);
    default: fail('invalid_action');
  }
}
