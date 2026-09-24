import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBoundedProcessRunner, safeSubprocessEnvironment }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';
import { ACTION_AUTHORITY, MUTATING_ACTIONS, ActionAuthorityError, assertActionAuthority, isActionAuthorized }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/action-authority.mjs';
import { executeAction }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/host-actions.mjs';
import { runProjectsPr, ProjectsPrClientError, runProjectsPrDoctor, prepareProjectsPr, publishProjectsPr,
  finalizeProjectsPr, statusProjectsPr, abortProjectsPr, stackProjectsPr }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';
import {
  ACTION_KINDS, FIXTURES_SHA256, SCHEMA_SHA256, ProtocolError, digestJson, sha256, validateAction,
  validateRequest, validateResponse
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/protocol.mjs';
import { createProjectsTransport, TransportError }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/transport.mjs';
import { verifyInstalledAws } from './verify-installed-aws.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRelative = 'integrations/codex/projects-pack-delegation/skills/projects-pack-delegation';
const skillRoot = path.join(root, skillRelative);
const runtimeManifestPath = path.join(skillRoot, 'scripts', 'runtime-manifest.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeAgentTemplates = Object.freeze([
  'integrations/codex/projects-pack-delegation/agents/projects-pack-coordinator.toml',
  'integrations/codex/projects-pack-delegation/agents/projects-pack-worker.toml',
  'integrations/codex/projects-pack-delegation/agents/projects-pack-reviewer.toml'
]);

async function exec(executable, args, cwd, { env = process.env, expected = 0 } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on('data', value => chunks.stdout.push(value));
    child.stderr.on('data', value => chunks.stderr.push(value));
    child.once('error', reject);
    child.once('close', code => resolve({ code,
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8') }));
  });
  assert.equal(result.code, expected,
    `${executable} ${args.join(' ')} exited ${result.code}\n${result.stderr.slice(0, 2000)}`);
  return result;
}

async function npmCli() {
  const executableDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return path.resolve(candidate); } catch { /* next */ }
  }
  throw new Error('npm-cli.js is required for the package boundary test');
}

async function walk(directory, prefix = '') {
  const values = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) values.push(...await walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) values.push(relative);
  }
  return values.sort();
}

function boundaryGuard(paths, readText) {
  const bannedPaths = [
    /projects-pr-core\.mjs$/u, /mutation-input\.mjs$/u, /verification-command\.mjs$/u,
    /code-review-(?:snapshot|report)\.mjs$/u,
    /hosted-rehearsal/u, /readiness-data\.mjs$/u, /github-review-evidence\.mjs$/u
  ];
  for (const name of paths) {
    if (bannedPaths.some(pattern => pattern.test(name))) throw new Error(`old public engine path: ${name}`);
    if (/agents\/projects-pack-/u.test(name) && !nativeAgentTemplates.includes(name)) {
      throw new Error(`old public engine path: ${name}`);
    }
    if (name.endsWith('.mjs')) {
      const text = readText(name);
      for (const marker of ['authorizeAdminProjectsPr', 'finishProjectsPr', 'PROJECTS_PR_DELIVERY_POLICY',
        'reviewedMerge:', 'adminOverride:']) {
        if (text.includes(marker)) throw new Error(`old public engine marker: ${marker}`);
      }
    }
  }
}

async function verifyPortableUnixHostReport(platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const config = 'core.repositoryformatversion\u00000\u0000';
  const invocations = [];
  const runner = async invocation => {
    invocations.push(structuredClone(invocation));
    if (invocation.executable === 'git' && invocation.args[0] === 'remote') {
      return { exitCode: 0, stdout: 'https://github.com/example/projects.git\n', stderr: '' };
    }
    if (invocation.executable === 'git' && invocation.args[0] === 'config') {
      return { exitCode: 0, stdout: config, stderr: '' };
    }
    if (invocation.executable === 'git' && invocation.args[0] === '--version') {
      return { exitCode: 0, stdout: 'git version 2.55.0\n', stderr: '' };
    }
    if (invocation.executable === '/bin/sh') {
      assert.deepEqual(invocation.args, ['-c', 'printf %s POSIX']);
      return { exitCode: 0, stdout: 'POSIX', stderr: '' };
    }
    throw new Error(`unexpected portable host probe: ${invocation.executable}`);
  };
  const provider = { observeHost: async () => ({
    github: { version: 'gh version test', authenticated: true,
      repository: 'example/projects', pushPermission: true },
    stack: { extensionCount: 1, publisher: 'github', commandAvailable: true }
  }) };
  let result;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    result = await executeAction(action(`portable-host:${platform}`, 'observe_host', {
      repository: 'example/projects'
    }), { operation: 'doctor', state: { repository: 'example/projects', remote: 'origin',
      repositoryRoot: '/local/repository', gitConfigSha256: sha256(config) }, runner, provider });
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
  assert.deepEqual(result.shell, { kind: 'sh', available: true, version: 'POSIX' });
  const strings = [];
  const collect = value => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(result);
  assert.equal(strings.some(value => path.posix.isAbsolute(value)), false,
    `${platform} host report exposed an absolute local path`);
  assert.equal(invocations.some(item => item.executable === '/bin/sh'), true);
}

async function verifyProtocolAndTransport() {
  const schemaPath = path.join(skillRoot, 'scripts', 'protocol', 'projects-pr-machine.schema.json');
  const fixturesPath = path.join(skillRoot, 'scripts', 'protocol', 'projects-pr-machine.fixtures.json');
  assert.equal(sha(await fs.readFile(schemaPath)), SCHEMA_SHA256);
  assert.equal(sha(await fs.readFile(fixturesPath)), FIXTURES_SHA256);
  const fixtures = JSON.parse(await fs.readFile(fixturesPath, 'utf8'));
  for (const value of fixtures.valid) {
    if (Object.hasOwn(value, 'status')) validateResponse(value,
      { operationId: value.operationId, operation: value.operation });
    else validateRequest(value);
  }
  for (const fixture of fixtures.invalid) assert.throws(() => validateRequest(fixture.value), ProtocolError,
    fixture.reason);

  const common = { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
    baseSha: '1'.repeat(40), branch: 'projects-pr/task-a', headSha: '2'.repeat(40) };
  const validActions = {
    observe_host: { repository: common.repository },
    observe_repository: { ...common, worktreeName: 'task-a' },
    create_worktree: { ...common, worktreeName: 'task-a', verificationCommandSha256: 'a'.repeat(64) },
    observe_candidate: common,
    push_branch: { repository: common.repository, remote: common.remote, branch: common.branch,
      headSha: common.headSha, expectedRemoteAbsent: true },
    create_pull_request: { repository: common.repository, baseBranch: common.baseBranch, branch: common.branch,
      headSha: common.headSha, title: 'Title', draft: true, bindingSha256: 'a'.repeat(64),
      providerBindingSha256: 'b'.repeat(64), verificationCommandSha256: 'c'.repeat(64) },
    observe_pull_request: { repository: common.repository, baseBranch: common.baseBranch, remote: common.remote,
      branch: common.branch, headSha: common.headSha, pullRequest: 1 },
    remove_worktree: { repository: common.repository, branch: common.branch, headSha: common.headSha },
    remove_local_branch: { repository: common.repository, branch: common.branch, headSha: common.headSha },
    link_stack: { repository: common.repository, baseBranch: common.baseBranch, remote: common.remote,
      packIds: ['task-a', 'task-b'], pullRequests: [1, 2] },
    observe_stack: { repository: common.repository, baseBranch: common.baseBranch, remote: common.remote,
      packIds: ['task-a', 'task-b'], pullRequests: [1, 2] }
  };
  for (const [kind, params] of Object.entries(validActions)) {
    const action = { actionId: sha256(kind), kind, params };
    validateAction(action);
    assert.throws(() => validateAction({ ...action, params: { ...params, shell: 'pwsh' } }), ProtocolError);
  }
  assert.throws(() => validateAction({ actionId: 'a'.repeat(64), kind: 'create_worktree',
    params: { ...validActions.create_worktree, worktreeName: '..' } }), ProtocolError);
  assert.throws(() => validateAction({ actionId: 'a'.repeat(64), kind: 'observe_repository',
    params: { repository: common.repository, baseBranch: 'main', remote: 'origin', baseSha: common.baseSha,
      branch: common.branch, headSha: common.headSha } }), ProtocolError,
  'a target observation without worktreeName cannot authorize absence');

  const calls = [];
  const responseFor = (options, contentType = 'application/json') => {
    const rpc = JSON.parse(options.body);
    calls.push(options);
    const envelope = { jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { accepted: true } } };
    return new Response(contentType === 'text/event-stream'
      ? `event: message\ndata: ${JSON.stringify(envelope)}\n\n` : JSON.stringify(envelope),
    { status: 200, headers: { 'content-type': contentType } });
  };
  const env = { PROJECTS_MCP_ENDPOINT: 'https://projectsdemo.org/mcp', PROJECTS_MCP_TOKEN: 'SECRET_TOKEN' };
  assert.deepEqual(await createProjectsTransport({ env, fetchImpl: async (_url, options) => responseFor(options) })({}),
    { accepted: true });
  assert.deepEqual(await createProjectsTransport({ env,
    fetchImpl: async (_url, options) => responseFor(options, 'text/event-stream') })({}), { accepted: true });
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.Authorization, 'Bearer SECRET_TOKEN');
  assert.equal(JSON.parse(calls[0].body).params.name, 'projects_pr_machine');
  assert.throws(() => createProjectsTransport({ env: {} }), TransportError);
  assert.throws(() => createProjectsTransport({ env: { ...env, PROJECTS_MCP_ENDPOINT: 'http://projectsdemo.org/mcp' } }),
    TransportError);
  await assert.rejects(createProjectsTransport({ env,
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://other.example/mcp' } }) })({}),
  error => error.code === 'service_redirect_refused');
  await assert.rejects(createProjectsTransport({ env,
    fetchImpl: async () => new Response('{}', { status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '9999999' } }) })({}),
  error => error.code === 'service_response_too_large');
  await assert.rejects(createProjectsTransport({ env,
    fetchImpl: async () => { throw new TypeError('offline'); } })({}),
  error => error.code === 'service_unavailable');
  const scrubbed = safeSubprocessEnvironment({ ...env, GH_REPO: 'attacker/repo', GH_HOST: 'evil.example',
    GIT_DIR: '/tmp/evil', SAFE: 'yes' });
  assert.equal(scrubbed.PROJECTS_MCP_TOKEN, undefined);
  assert.equal(scrubbed.PROJECTS_MCP_ENDPOINT, undefined);
  assert.equal(scrubbed.GH_REPO, undefined);
  assert.equal(scrubbed.GH_HOST, undefined);
  assert.equal(scrubbed.GIT_DIR, undefined);
  assert.equal(scrubbed.SAFE, 'yes');
  await verifyPortableUnixHostReport('linux');
  await verifyPortableUnixHostReport('darwin');
}

function scriptedTransport({ operation, binding = null, actions = [], terminal, dropReportOnce = false,
  onDroppedReport = () => {} }) {
  let index = 0;
  let waiting = null;
  let dropped = false;
  const requests = [];
  const transport = async request => {
    validateRequest(request);
    assert.equal(request.operation, operation);
    const strings = [];
    const collect = value => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(request);
    assert.equal(strings.some(value => path.isAbsolute(value)), false, 'absolute local path crossed MCP');
    assert.equal(strings.some(value => value.includes('SECRET_TOKEN')), false, 'credential crossed MCP');
    requests.push(structuredClone(request));
    if (waiting && request.report) {
      assert.equal(request.report.actionId, waiting.actionId);
      if (dropReportOnce && !dropped) {
        dropped = true;
        onDroppedReport(structuredClone(request));
        throw new Error('simulated dropped response');
      }
      waiting = null;
      index += 1;
    }
    if (index < actions.length) {
      const action = typeof actions[index] === 'function' ? actions[index](request) : actions[index];
      waiting = action;
      const response = { schemaVersion: 1, operationId: request.operationId, operation, status: 'needs_action', action };
      if (binding) response.binding = binding;
      return response;
    }
    return { schemaVersion: 1, operationId: request.operationId, operation,
      status: terminal.status, ...(binding ? { binding } : {}),
      receipt: { phase: terminal.phase, summary: terminal.summary ?? `${operation} terminal receipt` } };
  };
  return { transport, requests };
}

function action(label, kind, params) {
  return { actionId: sha256(label), kind, params };
}

function bindingFor(packId, baseSha, verificationCommandSha256) {
  return { workspaceId: 'workspace-test', packId, attempt: 1, revision: 1,
    repository: 'example/projects', base: baseSha, head: baseSha, verificationCommandSha256 };
}

async function git(executableArgs, cwd) {
  return (await exec('git', executableArgs, cwd)).stdout.trim();
}

async function createGitFixture(temp) {
  const bare = path.join(temp, 'remote.git');
  const repository = path.join(temp, 'repository');
  await fs.mkdir(bare); await fs.mkdir(repository);
  await git(['init', '--bare', '--template='], bare);
  await git(['init', '--initial-branch=main', '--template='], repository);
  await git(['config', 'user.name', 'Boundary Test'], repository);
  await git(['config', 'user.email', 'boundary@example.invalid'], repository);
  await fs.writeFile(path.join(repository, 'README.md'), 'base\n');
  await git(['add', 'README.md'], repository);
  await git(['commit', '-m', 'base'], repository);
  await git(['remote', 'add', 'origin', bare], repository);
  await git(['push', '-u', 'origin', 'main'], repository);
  const baseSha = await git(['rev-parse', 'HEAD'], repository);

  const realRunner = createBoundedProcessRunner();
  const invocations = [];
  const githubUrl = 'https://github.com/example/projects.git';
  const runner = async invocation => {
    invocations.push({ executable: invocation.executable, args: [...invocation.args], cwd: invocation.cwd });
    if (invocation.executable === 'git' && invocation.args[0] === 'remote' && invocation.args[1] === 'get-url') {
      return { exitCode: 0, stdout: `${githubUrl}\n`, stderr: '' };
    }
    const copy = { ...invocation, args: [...invocation.args] };
    if (copy.executable === 'git') {
      copy.args = copy.args.map(value => value === githubUrl ? bare : value);
    }
    return realRunner(copy);
  };
  return { bare, repository, baseSha, runner, invocations, githubUrl };
}

function createProvider(baseSha) {
  const pulls = new Map();
  const branchHeads = new Map([['main', baseSha]]);
  const bodies = new Map();
  const links = [];
  let nextNumber = 10;
  let membership = null;
  let listCount = 0;
  const clone = value => structuredClone(value);
  const provider = {
    branchHeads,
    bodies,
    links,
    get listCount() { return listCount; },
    async observeHost() {
      return { github: { version: 'gh version test', authenticated: true,
        repository: 'example/projects', pushPermission: true },
      stack: { extensionCount: 1, publisher: 'github', commandAvailable: true } };
    },
    async listPullRequests({ branch }) {
      listCount += 1;
      return [...pulls.values()].filter(value => value.headRef === branch).map(clone);
    },
    async createPullRequest(input) {
      assert.equal(input.draft, true);
      assert.equal(pulls.has(input.branch), false);
      const number = nextNumber++;
      bodies.set(input.branch, input.body);
      pulls.set(input.branch, {
        number, url: `https://github.com/example/projects/pull/${number}`, state: 'open', draft: true,
        baseRef: input.baseBranch, baseSha: branchHeads.get(input.baseBranch), headRef: input.branch,
        headSha: input.headSha, baseRepository: 'example/projects', headRepository: 'example/projects'
      });
    },
    async linkStack(input) {
      links.push(clone(input));
      const numbers = input.pullRequestUrls.map(url => Number(url.split('/').at(-1)));
      membership = { number: 7, pullRequests: numbers };
    },
    async observeStackMembership({ pullRequests }) {
      if (!membership) return null;
      return { number: membership.number, pullRequests: [...membership.pullRequests] };
    },
    setReady(branch) { pulls.get(branch).draft = false; },
    setMembership(value) { membership = value; },
    pullFor(branch) { return clone(pulls.get(branch)); }
  };
  return provider;
}

function prepareActions({ packId, baseBranch, baseSha, branch, worktreeName, verificationHash }) {
  const common = { repository: 'example/projects', baseBranch, remote: 'origin', baseSha };
  return [
    action(`${packId}:host`, 'observe_host', { repository: 'example/projects' }),
    action(`${packId}:source`, 'observe_repository', common),
    action(`${packId}:target`, 'observe_repository', { ...common, branch, headSha: baseSha, worktreeName }),
    action(`${packId}:create`, 'create_worktree', { ...common, branch, worktreeName, headSha: baseSha,
      verificationCommandSha256: verificationHash })
  ];
}

async function preparePack(fixture, provider, { packId, baseBranch, baseSha, branch, worktreeName,
  verificationCommand = 'node test/worker-check.mjs', dropReportOnce = false }) {
  const verificationHash = sha256(verificationCommand);
  const binding = bindingFor(packId, baseSha, verificationHash);
  const script = scriptedTransport({ operation: 'prepare', binding,
    actions: prepareActions({ packId, baseBranch, baseSha, branch, worktreeName, verificationHash }),
    terminal: { status: 'prepared', phase: 'prepared' }, dropReportOnce });
  const input = { repositoryRoot: fixture.repository, remote: 'origin', baseBranch,
    packId, title: `Title ${packId}`, verificationCommand };
  let receipt;
  if (dropReportOnce) {
    await assert.rejects(runProjectsPr('prepare', input, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: script.transport }), ProjectsPrClientError);
  }
  receipt = await runProjectsPr('prepare', input, { runner: fixture.runner,
    repositoryIdentity: 'example/projects', provider, transport: script.transport });
  assert.equal(receipt.status, 'prepared');
  assert.equal(receipt.plan.branch, branch);
  return { receipt, binding, verificationHash, input, script };
}

async function commitCandidate(fixture, provider, prepared, message) {
  const worktree = prepared.receipt.plan.worktreePath;
  await fs.writeFile(path.join(worktree, `${message}.txt`), `${message}\n`);
  await git(['add', '.'], worktree);
  await git(['commit', '-m', message], worktree);
  const headSha = await git(['rev-parse', 'HEAD'], worktree);
  provider.branchHeads.set(prepared.receipt.plan.branch, headSha);
  return headSha;
}

async function publishPack(fixture, provider, prepared, { packId, baseBranch, baseSha, branch, headSha }) {
  const handoffSha256 = sha256(`handoff:${packId}`);
  const publicationBinding = digestJson({ command: 'projects-pr-machine-publication',
    args: { binding: prepared.binding, handoffSha256, headSha } });
  const providerBindingSha256 = sha256(`provider:${packId}:${headSha}`);
  const common = { repository: 'example/projects', baseBranch, remote: 'origin', baseSha, branch, headSha };
  const script = scriptedTransport({ operation: 'publish', binding: prepared.binding, actions: [
    action(`${packId}:observe-candidate`, 'observe_candidate', common),
    action(`${packId}:observe-bound-state`, 'observe_repository', { ...common,
      worktreeName: path.basename(prepared.receipt.plan.worktreePath) }),
    action(`${packId}:push`, 'push_branch', { repository: common.repository, remote: common.remote,
      branch, headSha, expectedRemoteAbsent: true }),
    action(`${packId}:pr`, 'create_pull_request', { repository: common.repository, baseBranch, branch, headSha,
      title: `Title ${packId}`, draft: true, bindingSha256: publicationBinding, providerBindingSha256,
      verificationCommandSha256: prepared.verificationHash }),
    action(`${packId}:observe-pr`, 'observe_pull_request', {
      repository: common.repository, baseBranch, remote: common.remote, branch, headSha })
  ], terminal: { status: 'candidate_published', phase: 'candidate_published' } });
  const receipt = await runProjectsPr('publish', { repositoryRoot: fixture.repository, remote: 'origin',
    baseBranch, packId, headSha, handoffSha256 }, { runner: fixture.runner,
    repositoryIdentity: 'example/projects', provider, transport: script.transport });
  assert.equal(receipt.status, 'candidate_published');
  assert.match(provider.bodies.get(branch), new RegExp(`projects-acceptance:${providerBindingSha256}`, 'u'));
  return { receipt, script, handoffSha256, publicationBinding, providerBindingSha256 };
}

async function verifyAuthorityMatrix(fixture, provider, context) {
  const { bottomId, topId, bottomBranch, bottomHead, bottomPrepared, bottomPull, topPull } = context;
  const verificationHash = bottomPrepared.verificationHash;
  const params = {
    observe_host: { repository: 'example/projects' },
    observe_repository: { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      baseSha: fixture.baseSha, branch: bottomBranch, headSha: bottomHead, worktreeName: 'task-stack-bottom' },
    create_worktree: { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      baseSha: fixture.baseSha, branch: 'projects-pr/matrix-new', headSha: fixture.baseSha,
      worktreeName: 'matrix-new', verificationCommandSha256: verificationHash },
    observe_candidate: { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      baseSha: fixture.baseSha, branch: bottomBranch, headSha: bottomHead },
    push_branch: { repository: 'example/projects', remote: 'origin', branch: bottomBranch,
      headSha: bottomHead, expectedRemoteAbsent: true },
    create_pull_request: { repository: 'example/projects', baseBranch: 'main', branch: bottomBranch,
      headSha: bottomHead, title: 'Matrix probe', draft: true, bindingSha256: 'a'.repeat(64),
      providerBindingSha256: 'b'.repeat(64), verificationCommandSha256: verificationHash },
    observe_pull_request: { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      branch: bottomBranch, headSha: bottomHead, pullRequest: bottomPull.number },
    remove_worktree: { repository: 'example/projects', branch: bottomBranch, headSha: bottomHead },
    remove_local_branch: { repository: 'example/projects', branch: bottomBranch, headSha: bottomHead },
    link_stack: { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      packIds: [bottomId, topId], pullRequests: [bottomPull.number, topPull.number] },
    observe_stack: { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      packIds: [bottomId, topId], pullRequests: [bottomPull.number, topPull.number] }
  };
  const expectedAuthority = {
    doctor: ['observe_host', 'observe_repository'],
    prepare: ['observe_host', 'observe_repository', 'create_worktree'],
    publish: ['observe_candidate', 'observe_repository', 'push_branch', 'create_pull_request', 'observe_pull_request'],
    finalize: ['observe_pull_request', 'remove_worktree', 'observe_repository'],
    status: ['observe_repository', 'observe_pull_request'],
    abort: ['observe_repository', 'remove_worktree', 'remove_local_branch'],
    stack: ['observe_host', 'link_stack', 'observe_stack']
  };
  assert.deepEqual(ACTION_AUTHORITY, expectedAuthority);
  const operations = Object.keys(expectedAuthority);
  assert.deepEqual(operations, ['doctor', 'prepare', 'publish', 'finalize', 'status', 'abort', 'stack']);
  assert.equal(ACTION_KINDS.length, 11);
  assert.equal(ACTION_AUTHORITY.doctor.some(kind => MUTATING_ACTIONS.includes(kind)), false);
  assert.equal(ACTION_AUTHORITY.status.some(kind => MUTATING_ACTIONS.includes(kind)), false);
  let pairs = 0; let directRefusals = 0;
  for (const operation of operations) {
    for (const kind of ACTION_KINDS) {
      pairs += 1;
      const expected = expectedAuthority[operation].includes(kind);
      assert.equal(isActionAuthorized(operation, kind), expected, `${operation}/${kind}`);
      if (expected) assert.doesNotThrow(() => assertActionAuthority(operation, kind));
      else {
        assert.throws(() => assertActionAuthority(operation, kind), ActionAuthorityError);
        let dispatched = false;
        await assert.rejects(executeAction(action(`direct:${operation}:${kind}`, kind, params[kind]), {
          operation, runner: async () => { dispatched = true; throw new Error('dispatched'); }
        }), ActionAuthorityError);
        assert.equal(dispatched, false, `direct dispatcher reached host for ${operation}/${kind}`);
        directRefusals += 1;
      }
    }
  }
  assert.equal(pairs, 77);

  const inputs = {
    doctor: { repositoryRoot: fixture.repository, baseBranch: 'main', remote: 'origin' },
    prepare: { ...bottomPrepared.input },
    publish: { repositoryRoot: fixture.repository, baseBranch: 'main', remote: 'origin', packId: bottomId,
      headSha: bottomHead, handoffSha256: sha256(`handoff:${bottomId}`) },
    finalize: { repositoryRoot: fixture.repository, baseBranch: 'main', remote: 'origin', packId: bottomId },
    status: { repositoryRoot: fixture.repository, baseBranch: 'main', remote: 'origin', packId: bottomId },
    abort: { repositoryRoot: fixture.repository, baseBranch: 'main', remote: 'origin', packId: bottomId },
    stack: { repositoryRoot: fixture.repository, baseBranch: 'main', remote: 'origin', packIds: [bottomId, topId] }
  };
  const aliases = { doctor: runProjectsPrDoctor, prepare: prepareProjectsPr, publish: publishProjectsPr,
    finalize: finalizeProjectsPr, status: statusProjectsPr, abort: abortProjectsPr, stack: stackProjectsPr };
  const journalPath = path.join(fixture.repository, '.git', 'projects-pr-client-v1', `${bottomId}.json`);
  let wrapperRefusals = 0;
  const mutationInvocationCount = () => fixture.invocations.filter(item => item.executable === 'git'
    && ((item.args[0] === 'worktree' && ['add', 'remove'].includes(item.args[1]))
      || item.args[0] === 'push'
      || (item.args[0] === 'branch' && item.args.includes('--delete')))).length;
  const beforeMutationInvocations = mutationInvocationCount();
  const beforeProviderBodies = provider.bodies.size;
  const beforeProviderLinks = provider.links.length;
  const beforeWorktrees = await git(['worktree', 'list', '--porcelain'], fixture.repository);
  const beforeBranches = await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'], fixture.repository);
  const baselineJournal = await fs.readFile(journalPath);
  for (const operation of operations) {
    for (const kind of ACTION_KINDS.filter(value => !expectedAuthority[operation].includes(value))) {
      // Each refusal starts from the same valid prepared state. The client
      // deliberately retains an unfinished operation after a refused response,
      // so a different command cannot bypass its recovery lock.
      await fs.writeFile(journalPath, baselineJournal);
      const before = JSON.parse(await fs.readFile(journalPath, 'utf8')).actions.length;
      const malicious = action(`wrapper:${operation}:${kind}`, kind, params[kind]);
      const transport = async request => ({ schemaVersion: 1, operationId: request.operationId,
        operation, status: 'needs_action', ...(operation === 'doctor' ? {} : { binding: bottomPrepared.binding }),
        action: malicious });
      await assert.rejects(aliases[operation](inputs[operation], { runner: fixture.runner,
        repositoryIdentity: 'example/projects', provider, transport }),
      error => error.code === 'action_not_authorized', `${operation}/${kind} wrapper refusal`);
      const after = JSON.parse(await fs.readFile(journalPath, 'utf8')).actions.length;
      assert.equal(after, before, `unauthorized action was journaled for ${operation}/${kind}`);
      wrapperRefusals += 1;
    }
  }
  await fs.writeFile(journalPath, baselineJournal);
  assert.equal(wrapperRefusals, directRefusals);
  assert.equal(mutationInvocationCount(), beforeMutationInvocations,
    'cross-verb wrapper matrix reached a Git mutation');
  assert.equal(provider.bodies.size, beforeProviderBodies, 'cross-verb matrix created a pull request');
  assert.equal(provider.links.length, beforeProviderLinks, 'cross-verb matrix linked a stack');
  assert.equal(await git(['worktree', 'list', '--porcelain'], fixture.repository), beforeWorktrees);
  assert.equal(await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'], fixture.repository),
    beforeBranches);

  const cached = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const cachedPush = cached.actions.find(item => item.action?.kind === 'push_branch');
  assert.ok(cachedPush, 'published journal contains the exact push action');
  const cachedBefore = cached.actions.length;
  const cachedTransport = async request => ({ schemaVersion: 1, operationId: request.operationId,
    operation: 'status', status: 'needs_action', binding: bottomPrepared.binding, action: cachedPush.action });
  await assert.rejects(statusProjectsPr(inputs.status, { runner: fixture.runner,
    repositoryIdentity: 'example/projects', provider, transport: cachedTransport }),
  error => error.code === 'action_not_authorized');
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).actions.length, cachedBefore,
    'cached cross-verb action was rejected before journal replay');
  return { pairs, allowedPairs: pairs - directRefusals, refusedPairs: directRefusals,
    wrapperRefusals, cachedReplayRefusals: 1 };
}

async function verifyRealLifecycle() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-boundary-'));
  try {
    const fixture = await createGitFixture(temp);
    const provider = createProvider(fixture.baseSha);
    const doctor = scriptedTransport({ operation: 'doctor', actions: [
      action('doctor:host', 'observe_host', { repository: 'example/projects' }),
      action('doctor:repository', 'observe_repository', {
        repository: 'example/projects', baseBranch: 'main', remote: 'origin' })
    ], terminal: { status: 'ready', phase: 'ready' } });
    const doctorReceipt = await runProjectsPr('doctor', { repositoryRoot: fixture.repository,
      baseBranch: 'main', remote: 'origin' }, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: doctor.transport });
    assert.equal(doctorReceipt.capability.available, true);
    assert.equal(doctor.requests.every(request => !request.packId), true,
      'doctor runs without a delegated binding');

    const hooks = path.join(fixture.repository, '.git', 'hooks');
    const hookMarker = path.join(temp, 'hook-ran.txt');
    await fs.mkdir(hooks);
    for (const name of ['post-checkout', 'pre-push']) {
      const hook = path.join(hooks, name);
      await fs.writeFile(hook, `#!/bin/sh\nprintf hook > "${hookMarker.replaceAll('\\', '/')}"\n`);
      await fs.chmod(hook, 0o755);
    }

    const occupiedBase = path.join(temp, '.projects-pr-worktrees');
    await fs.mkdir(occupiedBase);
    await fs.writeFile(path.join(occupiedBase, 'occupied-target'), 'foreign\n');
    const occupiedId = 'task-occupied';
    const occupiedVerification = sha256('node test/worker-check.mjs');
    const occupiedBinding = bindingFor(occupiedId, fixture.baseSha, occupiedVerification);
    const occupiedScript = scriptedTransport({ operation: 'prepare', binding: occupiedBinding,
      actions: prepareActions({ packId: occupiedId, baseBranch: 'main', baseSha: fixture.baseSha,
        branch: 'projects-pr/task-occupied', worktreeName: 'occupied-target',
        verificationHash: occupiedVerification }), terminal: { status: 'prepared', phase: 'prepared' } });
    await assert.rejects(runProjectsPr('prepare', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packId: occupiedId, title: 'Occupied', verificationCommand: 'node test/worker-check.mjs' },
    { runner: fixture.runner, repositoryIdentity: 'example/projects', provider,
      transport: occupiedScript.transport }), error => error.code === 'target_not_observed');
    assert.equal(await fs.readFile(path.join(occupiedBase, 'occupied-target'), 'utf8'), 'foreign\n');

    const outside = path.join(temp, 'outside-target');
    await fs.mkdir(outside);
    const linked = path.join(occupiedBase, 'linked-target');
    try { await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { assert.fail(`symlink/junction fixture unavailable: ${error.code}`); }
    const linkedId = 'task-linked';
    const linkedBinding = bindingFor(linkedId, fixture.baseSha, occupiedVerification);
    const linkedScript = scriptedTransport({ operation: 'prepare', binding: linkedBinding,
      actions: prepareActions({ packId: linkedId, baseBranch: 'main', baseSha: fixture.baseSha,
        branch: 'projects-pr/task-linked', worktreeName: 'linked-target',
        verificationHash: occupiedVerification }), terminal: { status: 'prepared', phase: 'prepared' } });
    await assert.rejects(runProjectsPr('prepare', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packId: linkedId, title: 'Linked', verificationCommand: 'node test/worker-check.mjs' },
    { runner: fixture.runner, repositoryIdentity: 'example/projects', provider,
      transport: linkedScript.transport }), error => error.code === 'target_not_observed');
    assert.equal((await fs.stat(outside)).isDirectory(), true);

    const packId = 'task-one';
    const branch = 'projects-pr/task-one-boundary';
    const markerFromVerification = path.join(temp, 'candidate-verification-ran.txt');
    const verificationCommand = `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerFromVerification)},'ran')"`;
    const prepared = await preparePack(fixture, provider, { packId, baseBranch: 'main',
      baseSha: fixture.baseSha, branch, worktreeName: 'task-one-boundary', verificationCommand,
      dropReportOnce: true });
    assert.equal(await fs.stat(prepared.receipt.plan.worktreePath).then(value => value.isDirectory()), true);
    await assert.rejects(fs.stat(hookMarker), { code: 'ENOENT' });
    assert.equal(prepared.input.verificationCommand, verificationCommand);
    await assert.rejects(fs.stat(markerFromVerification), { code: 'ENOENT' });
    const headSha = await commitCandidate(fixture, provider, prepared, 'candidate-one');
    const published = await publishPack(fixture, provider, prepared,
      { packId, baseBranch: 'main', baseSha: fixture.baseSha, branch, headSha });
    assert.notEqual(published.publicationBinding, published.providerBindingSha256);
    await assert.rejects(fs.stat(markerFromVerification), { code: 'ENOENT' });
    await assert.rejects(fs.stat(hookMarker), { code: 'ENOENT' });

    const pull = provider.pullFor(branch);
    const draftFinalize = scriptedTransport({ operation: 'finalize', binding: prepared.binding, actions: [
      action('task-one:finalize-draft', 'observe_pull_request', { repository: 'example/projects',
        baseBranch: 'main', remote: 'origin', branch, headSha, pullRequest: pull.number })
    ], terminal: { status: 'awaiting_owner_readiness', phase: 'awaiting_owner_readiness' } });
    const awaiting = await runProjectsPr('finalize', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packId }, { runner: fixture.runner, repositoryIdentity: 'example/projects',
      provider, transport: draftFinalize.transport });
    assert.equal(awaiting.status, 'awaiting_owner_readiness');

    const runTitle = provider.bodies.get(branch).match(/projects-acceptance:[a-f0-9]{64}/u)?.[0];
    assert.equal(runTitle, `projects-acceptance:${published.providerBindingSha256}`,
      'operator obtains exact provider run title from PR metadata');
    provider.setReady(branch);
    let backendAcceptanceCommitted = false;
    const acceptedFinalize = scriptedTransport({ operation: 'finalize', binding: prepared.binding, actions: [
      action('task-one:finalize-ready', 'observe_pull_request', { repository: 'example/projects',
        baseBranch: 'main', remote: 'origin', branch, headSha, pullRequest: pull.number }),
      action('task-one:remove-worktree', 'remove_worktree', { repository: 'example/projects', branch, headSha })
    ], terminal: { status: 'completed', phase: 'completed' }, dropReportOnce: true,
    onDroppedReport: () => { backendAcceptanceCommitted = true; } });
    const evidence = { pullRequest: pull.number, runId: 101, runAttempt: 1, artifactId: 202, reviewId: 303 };
    const acceptedInput = { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packId, githubEvidence: evidence };
    await assert.rejects(runProjectsPr('finalize', acceptedInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: acceptedFinalize.transport }),
    error => error.code === 'runner_failed');
    assert.equal(backendAcceptanceCommitted, true);
    const completed = await runProjectsPr('finalize', acceptedInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: acceptedFinalize.transport });
    /* Same exact request/report identity recovers backend acceptance after the lost response. */
    assert.equal(new Set(acceptedFinalize.requests.map(request => request.operationId)).size, 1);
    assert.deepEqual(acceptedFinalize.requests[1].report, acceptedFinalize.requests[2].report);
    assert.equal(completed.status, 'completed');
    await assert.rejects(fs.stat(prepared.receipt.plan.worktreePath), { code: 'ENOENT' });
    assert.equal(await git(['rev-parse', '--verify', `refs/heads/${branch}`], fixture.repository), headSha,
      'finalize preserves the local branch');
    await assert.rejects(fs.stat(hookMarker), { code: 'ENOENT' });

    const abortPack = 'task-abort';
    const abortBranch = 'projects-pr/task-abort-boundary';
    const abortPrepared = await preparePack(fixture, provider, { packId: abortPack, baseBranch: 'main',
      baseSha: fixture.baseSha, branch: abortBranch, worktreeName: 'task-abort-boundary' });
    const abortScript = scriptedTransport({ operation: 'abort', binding: abortPrepared.binding, actions: [
      action('task-abort:remove-worktree', 'remove_worktree', { repository: 'example/projects',
        branch: abortBranch, headSha: fixture.baseSha }),
      action('task-abort:remove-branch', 'remove_local_branch', { repository: 'example/projects',
        branch: abortBranch, headSha: fixture.baseSha })
    ], terminal: { status: 'aborted', phase: 'aborted' } });
    const aborted = await runProjectsPr('abort', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packId: abortPack }, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: abortScript.transport });
    assert.equal(aborted.status, 'aborted');

    const bottomId = 'task-stack-bottom';
    const bottomBranch = 'projects-pr/task-stack-bottom';
    const bottomPrepared = await preparePack(fixture, provider, { packId: bottomId, baseBranch: 'main',
      baseSha: fixture.baseSha, branch: bottomBranch, worktreeName: 'task-stack-bottom' });
    const bottomHead = await commitCandidate(fixture, provider, bottomPrepared, 'stack-bottom');
    await publishPack(fixture, provider, bottomPrepared, { packId: bottomId, baseBranch: 'main',
      baseSha: fixture.baseSha, branch: bottomBranch, headSha: bottomHead });

    const topId = 'task-stack-top';
    const topBranch = 'projects-pr/task-stack-top';
    const topPrepared = await preparePack(fixture, provider, { packId: topId, baseBranch: bottomBranch,
      baseSha: bottomHead, branch: topBranch, worktreeName: 'task-stack-top' });
    const topHead = await commitCandidate(fixture, provider, topPrepared, 'stack-top');
    await publishPack(fixture, provider, topPrepared, { packId: topId, baseBranch: bottomBranch,
      baseSha: bottomHead, branch: topBranch, headSha: topHead });

    const bottomPull = provider.pullFor(bottomBranch);
    const topPull = provider.pullFor(topBranch);
    const stackParams = { repository: 'example/projects', baseBranch: 'main', remote: 'origin',
      packIds: [bottomId, topId], pullRequests: [bottomPull.number, topPull.number] };
    const stackScript = scriptedTransport({ operation: 'stack', binding: bottomPrepared.binding, actions: [
      action('stack:host', 'observe_host', { repository: 'example/projects' }),
      action('stack:link', 'link_stack', stackParams),
      action('stack:observe', 'observe_stack', stackParams)
    ], terminal: { status: 'stacked', phase: 'stacked' } });
    const stacked = await runProjectsPr('stack', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packIds: [bottomId, topId] }, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: stackScript.transport });
    assert.equal(stacked.status, 'stacked');
    assert.deepEqual(provider.links[0].pullRequestUrls,
      [bottomPull.url, topPull.url], 'stack uses exact PR URLs in bottom-to-top order');
    assert.equal(Object.hasOwn(provider.links[0], 'branches'), false);
    assert.equal(provider.pullFor(bottomBranch).draft, true);
    assert.equal(provider.pullFor(topBranch).draft, true);

    const authority = await verifyAuthorityMatrix(fixture, provider, { bottomId, topId, bottomBranch,
      bottomHead, bottomPrepared, bottomPull, topPull });

    const countBeforeStatus = provider.listCount;
    const statusAction = action('status:replay', 'observe_repository', { repository: 'example/projects',
      baseBranch: 'main', remote: 'origin', baseSha: fixture.baseSha, branch: bottomBranch,
      headSha: bottomHead, worktreeName: 'task-stack-bottom' });
    const replay = scriptedTransport({ operation: 'status', binding: bottomPrepared.binding,
      actions: [statusAction], terminal: { status: 'observed', phase: 'candidate_published' }, dropReportOnce: true });
    const statusInput = { repositoryRoot: fixture.repository, remote: 'origin', baseBranch: 'main', packId: bottomId };
    await assert.rejects(runProjectsPr('status', statusInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: replay.transport }), ProjectsPrClientError);
    const countAfterDrop = provider.listCount;
    const observed = await runProjectsPr('status', statusInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: replay.transport });
    assert.equal(observed.status, 'observed');
    assert.equal(provider.listCount, countAfterDrop, 'recorded action report replay does not repeat observation');
    assert.ok(countAfterDrop > countBeforeStatus);

    const missingHeadAction = action('status:missing-head-repository', 'observe_pull_request', {
      repository: 'example/projects', baseBranch: 'main', remote: 'origin', branch: bottomBranch,
      headSha: bottomHead, pullRequest: bottomPull.number });
    let missingHeadStep = 0;
    const missingHeadTransport = async request => {
      if (missingHeadStep++ === 0) return { schemaVersion: 1, operationId: request.operationId,
        operation: 'status', status: 'needs_action', binding: bottomPrepared.binding, action: missingHeadAction };
      assert.equal(request.report.status, 'failed');
      assert.equal(request.report.error.code, 'provider_response_invalid');
      return { schemaVersion: 1, operationId: request.operationId, operation: 'status', status: 'refused',
        binding: bottomPrepared.binding, receipt: { phase: 'refused', summary: 'Provider identity unavailable.' } };
    };
    const missingHeadProvider = { ...provider, async listPullRequests() {
      return [{ number: bottomPull.number, url: bottomPull.url, state: 'OPEN', isDraft: true,
        baseRefName: 'main', baseRefOid: fixture.baseSha, headRefName: bottomBranch, headRefOid: bottomHead,
        headRepository: null }];
    } };
    const missingHead = await runProjectsPr('status', statusInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider: missingHeadProvider, transport: missingHeadTransport });
    assert.equal(missingHead.status, 'refused');

    const bottomJournalPath = path.join(fixture.repository, '.git', 'projects-pr-client-v1', `${bottomId}.json`);
    const beforeBindingMismatch = await fs.readFile(bottomJournalPath);
    let workspaceStep = 0;
    const changedBinding = { ...bottomPrepared.binding, workspaceId: 'workspace-other' };
    const workspaceTransport = async request => {
      if (workspaceStep++ === 0) return { schemaVersion: 1, operationId: request.operationId,
        operation: 'status', status: 'needs_action', binding: bottomPrepared.binding,
        action: action('status:workspace-source', 'observe_repository', { repository: 'example/projects',
          baseBranch: 'main', remote: 'origin', baseSha: fixture.baseSha }) };
      return { schemaVersion: 1, operationId: request.operationId, operation: 'status', status: 'needs_action',
        binding: changedBinding, action: action('status:workspace-target', 'observe_repository', {
          repository: 'example/projects', baseBranch: 'main', remote: 'origin', baseSha: fixture.baseSha,
          branch: bottomBranch, headSha: bottomHead, worktreeName: 'task-stack-bottom' }) };
    };
    await assert.rejects(runProjectsPr('status', statusInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: workspaceTransport }),
    error => error.code === 'binding_mismatch');
    const mismatchedJournal = JSON.parse(await fs.readFile(bottomJournalPath, 'utf8'));
    assert.equal(mismatchedJournal.activeOperation?.terminal, false,
      'changed binding leaves the operation locked for explicit reconciliation');
    await fs.writeFile(bottomJournalPath, beforeBindingMismatch);

    const interruptProvider = { ...provider };
    delete interruptProvider.linkStack;
    let interruptedLinks = 0;
    const interruptedRunner = async invocation => {
      if (invocation.executable === 'gh' && invocation.args[0] === 'stack' && invocation.args[1] === 'link') {
        interruptedLinks += 1;
        return { exitCode: 1, stdout: '', stderr: '', processUncertain: true };
      }
      return fixture.runner(invocation);
    };
    const uncertainAction = action('stack:uncertain', 'link_stack', stackParams);
    const uncertainScript = scriptedTransport({ operation: 'stack', binding: bottomPrepared.binding,
      actions: [uncertainAction], terminal: { status: 'refused', phase: 'refused' } });
    await assert.rejects(runProjectsPr('stack', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packIds: [bottomId, topId] }, { runner: interruptedRunner,
      repositoryIdentity: 'example/projects', provider: interruptProvider, transport: uncertainScript.transport }),
    error => error.code === 'lifecycle_process_uncertain');
    assert.equal(interruptedLinks, 1);
    const lock = path.join(fixture.repository, '.git', 'projects-pr-client-v1.lock');
    assert.equal((await fs.stat(lock)).isDirectory(), true);
    const journal = JSON.parse(await fs.readFile(path.join(fixture.repository, '.git',
      'projects-pr-client-v1', `${bottomId}.json`), 'utf8'));
    assert.equal(journal.actions.find(item => item.actionId === uncertainAction.actionId).status, 'uncertain');
    await fs.rm(lock, { recursive: true });
    const refused = await runProjectsPr('stack', { repositoryRoot: fixture.repository, remote: 'origin',
      baseBranch: 'main', packIds: [bottomId, topId] }, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: uncertainScript.transport });
    assert.equal(refused.status, 'refused');
    assert.equal(interruptedLinks, 1, 'matching pre-existing chain cannot synthesize link success after uncertainty');

    const originalConfig = await fs.readFile(path.join(fixture.repository, '.git', 'config'), 'utf8');
    await git(['config', 'remote.origin.url', 'https://github.com/attacker/other.git'], fixture.repository);
    const changedRemote = scriptedTransport({ operation: 'status', binding: bottomPrepared.binding,
      terminal: { status: 'observed', phase: 'candidate_published' } });
    await assert.rejects(runProjectsPr('status', statusInput, { runner: fixture.runner,
      repositoryIdentity: 'example/projects', provider, transport: changedRemote.transport }),
    error => error.code === 'repository_changed' || error.code === 'repository_mismatch');
    await fs.writeFile(path.join(fixture.repository, '.git', 'config'), originalConfig);

    const pushCalls = fixture.invocations.filter(item => item.executable === 'git' && item.args[0] === 'push');
    assert.ok(pushCalls.length >= 3);
    for (const call of pushCalls) {
      assert.ok(call.args.some(value => value.startsWith('--force-with-lease=refs/heads/') && value.endsWith(':')),
        'push uses an explicit absence lease');
      assert.ok(call.args.some(value => /^[a-f0-9]{40}:refs\/heads\//u.test(value)),
        'push uses immutable candidate SHA, not HEAD');
      assert.equal(call.args.includes('HEAD'), false);
    }
    await assert.rejects(fs.stat(hookMarker), { code: 'ENOENT' });
    return { verbs: ['doctor', 'prepare', 'publish', 'finalize', 'status', 'abort', 'stack'],
      pullRequests: 3, stackLinks: 1, replayedReports: 1, recoveredLostAcceptance: 1,
      uncertainEffects: 1, authority };
  } finally {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())) && path.basename(resolved).startsWith('projects-pr-boundary-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function verifyPackageBoundary() {
  await exec(process.execPath, [path.join(root, 'scripts', 'runtime-manifest.mjs'), '--check'], root);
  const manifest = JSON.parse(await fs.readFile(runtimeManifestPath, 'utf8'));
  assert.equal(manifest.kind, 'projects-pr-public-runtime-manifest');
  assert.equal(manifest.entrypoint, 'scripts/projects-pr.mjs');
  assert.equal(manifest.files.length, 14);
  const runtimeText = new Map();
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(skillRoot, entry.path));
    assert.equal(sha(bytes), entry.sha256, `runtime hash mismatch: ${entry.path}`);
    assert.equal(bytes.length, entry.bytes, `runtime size mismatch: ${entry.path}`);
    if (entry.path.endsWith('.mjs')) runtimeText.set(entry.path, bytes.toString('utf8'));
  }
  boundaryGuard(manifest.files.map(entry => entry.path), name => runtimeText.get(name) ?? '');
  assert.throws(() => boundaryGuard(['scripts/lib/projects-pr-core.mjs'], () => ''),
    /old public engine path/u, 'boundary guard positive control must reject an old engine file');
  assert.throws(() => boundaryGuard(['integrations/codex/projects-pack-delegation/agents/projects-pack-legacy.toml'], () => ''),
    /old public engine path/u, 'boundary guard must reject unknown agent templates');
  assert.throws(() => boundaryGuard(['scripts/lib/fake.mjs'], () => 'export const x = finishProjectsPr;'),
    /old public engine marker/u, 'boundary guard positive control must reject old policy APIs');
  for (const [name, text] of runtimeText) {
    for (const match of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/gu)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      assert.equal(resolved.startsWith('../'), false, `runtime import escapes skill tree: ${name}`);
      assert.ok(manifest.files.some(entry => entry.path === resolved), `unmanifested runtime import: ${resolved}`);
    }
  }

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-package-'));
  try {
    const artifacts = path.join(temp, 'artifacts');
    const consumer = path.join(temp, 'consumer');
    await fs.mkdir(artifacts); await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, 'package.json'), '{"name":"boundary-consumer","private":true}\n');
    const npm = await npmCli();
    const packedResult = await exec(process.execPath,
      [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], root);
    const packed = JSON.parse(packedResult.stdout)[0];
    assert.equal(packed.name, '@wornpage/projects-pr');
    assert.equal(packed.version, '3.0.0-beta.3');
    const packedPaths = packed.files.map(entry => entry.path.replaceAll('\\', '/'));
    for (const path of nativeAgentTemplates) assert.ok(packedPaths.includes(path), `missing native agent template: ${path}`);
    assert.ok(packedPaths.includes(`${skillRelative}/scripts/projects-aws-qualification.mjs`),
      'missing local qualification sibling');
    const sourceTexts = new Map();
    for (const name of packedPaths.filter(name => name.endsWith('.mjs'))) {
      sourceTexts.set(name, await fs.readFile(path.join(root, name), 'utf8'));
    }
    boundaryGuard(packedPaths, name => sourceTexts.get(name) ?? '');
    const tarball = path.join(artifacts, packed.filename);
    await exec(process.execPath, [npm, 'install', '--ignore-scripts', '--no-save', '--package-lock=false', tarball], consumer,
      { env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_userconfig: path.join(temp, 'empty.npmrc') } });
    const installed = path.join(consumer, 'node_modules', '@wornpage', 'projects-pr');
    const installedManifest = JSON.parse(await fs.readFile(path.join(installed, skillRelative,
      'scripts', 'runtime-manifest.json'), 'utf8'));
    assert.deepEqual(installedManifest, manifest);
    for (const entry of manifest.files) {
      assert.equal(sha(await fs.readFile(path.join(installed, skillRelative, entry.path))), entry.sha256,
        `installed runtime hash mismatch: ${entry.path}`);
    }
    const installedPaths = await walk(installed);
    const trustGuide = await fs.readFile(path.join(installed, 'docs', 'agent-trust.md'), 'utf8');
    assert.match(trustGuide, /https:\/\/projectsdemo\.org\/mcp`/u,
      'trust guide must use the exact accepted MCP endpoint');
    assert.doesNotMatch(trustGuide, /https:\/\/projectsdemo\.org\/mcp\//u,
      'trust guide must not instruct a rejected trailing-slash endpoint');
    const installedTexts = new Map();
    for (const name of installedPaths.filter(name => name.endsWith('.mjs'))) {
      installedTexts.set(name, await fs.readFile(path.join(installed, ...name.split('/')), 'utf8'));
    }
    boundaryGuard(installedPaths, name => installedTexts.get(name) ?? '');
    const cli = path.join(installed, skillRelative, 'scripts', 'projects-pr.mjs');
    const help = await exec(process.execPath, [cli, '--help'], consumer);
    for (const verb of ['doctor', 'prepare', 'publish', 'finalize', 'status', 'abort', 'stack']) {
      assert.match(help.stdout, new RegExp(`\\b${verb}\\b`, 'u'));
    }
    assert.doesNotMatch(help.stdout, /authorize-admin|\bfinish\b/u);
    const awsCli = path.join(installed, skillRelative, 'scripts', 'projects-aws-qualification.mjs');
    const awsHelp = await exec(process.execPath, [awsCli, '--help'], consumer);
    assert.match(awsHelp.stdout, /StartBuild is never retried/u);
    const installedAws = await verifyInstalledAws(installed);
    const module = await import(`${pathToFileURL(path.join(installed, skillRelative,
      'scripts', 'lib', 'projects-pr.mjs')).href}?test=${Date.now()}`);
    for (const name of ['runProjectsPr', 'runProjectsPrDoctor', 'prepareProjectsPr', 'publishProjectsPr',
      'finalizeProjectsPr', 'statusProjectsPr', 'abortProjectsPr', 'stackProjectsPr']) {
      assert.equal(typeof module[name], 'function');
    }
    for (const removed of ['authorizeProjectsPr', 'authorizeAdminProjectsPr', 'finishProjectsPr']) {
      assert.equal(Object.hasOwn(module, removed), false);
    }
    const failed = await exec(process.execPath, [cli, 'doctor', '--repo', consumer], consumer, { expected: 1 });
    const failure = JSON.parse(failed.stderr);
    assert.equal(failure.status, 'failed');
    assert.equal(JSON.stringify(failure).includes('PROJECTS_MCP_TOKEN'), false);
    return { tarballSha256: sha(await fs.readFile(tarball)), packedFiles: packed.files.length,
      runtimeFiles: manifest.files.length, installedFiles: installedPaths.length,
      installedAws };
  } finally {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())) && path.basename(resolved).startsWith('projects-pr-package-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

await verifyProtocolAndTransport();
const lifecycle = await verifyRealLifecycle();
const packageEvidence = await verifyPackageBoundary();
console.log(JSON.stringify({ schemaVersion: 1, kind: 'private-engine-boundary-verification',
  passed: true, protocol: { schemaSha256: SCHEMA_SHA256, fixturesSha256: FIXTURES_SHA256,
    exactActionKinds: 11, transport: ['json', 'sse'], redirectsFollowed: false },
  lifecycle, package: packageEvidence }, null, 2));
