import { createHash } from 'node:crypto';

export const WIRE_SCHEMA_VERSION = 1;
export const TOOL_NAME = 'projects_pr_machine';
export const SCHEMA_SHA256 = '11099c77af68e28def6203586b8a54328550926c0d1c667a24114fe9602648dd';
export const FIXTURES_SHA256 = 'fe27a1639d2ed086a8fa2298570c9e79051f772b16c5aef25ce7c6ca0ab539a3';
export const OPERATIONS = Object.freeze(['doctor', 'prepare', 'publish', 'finalize', 'status', 'abort', 'stack']);
export const ACTION_KINDS = Object.freeze([
  'observe_host', 'observe_repository', 'create_worktree', 'observe_candidate',
  'push_branch', 'create_pull_request', 'observe_pull_request', 'remove_worktree',
  'remove_local_branch', 'link_stack', 'observe_stack'
]);

const OPERATION_ID = /^[A-Za-z0-9._:+/-]{1,160}$/u;
const PACK_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REMOTE = /^[A-Za-z0-9._-]{1,80}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,180}$/u;
const ERROR_CODE = /^[a-z0-9_]{1,120}$/u;

export class ProtocolError extends Error {
  constructor(code = 'invalid_protocol') {
    super('The Projects PR Machine protocol message was refused.');
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const refuse = code => { throw new ProtocolError(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, required, optional = []) => {
  if (!plain(value)) refuse('invalid_protocol');
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.has(key))) {
    refuse('invalid_protocol');
  }
};
const text = (value, max) => typeof value === 'string' && value.length >= 1
  && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
const branch = value => text(value, 240) && !value.startsWith('-')
  && !/\.\.|\/\/|@\{|[~^:?*\[\]\\]|\s/u.test(value);
const positive = value => Number.isSafeInteger(value) && value >= 1;
const packList = value => Array.isArray(value) && value.length >= 2 && value.length <= 8
  && new Set(value).size === value.length && value.every(item => PACK_ID.test(item));
const prList = value => Array.isArray(value) && value.length >= 2 && value.length <= 8
  && new Set(value).size === value.length && value.every(positive);

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

export function digestJson(value) {
  return sha256(stableJson(value));
}

const ACTION_SHAPES = Object.freeze({
  observe_host: [['repository']],
  observe_repository: [
    ['repository', 'baseBranch', 'remote'],
    ['repository', 'baseBranch', 'remote', 'baseSha'],
    ['repository', 'baseBranch', 'remote', 'baseSha', 'branch', 'headSha', 'worktreeName']
  ],
  create_worktree: [['repository', 'baseBranch', 'remote', 'branch', 'worktreeName', 'headSha', 'baseSha', 'verificationCommandSha256']],
  observe_candidate: [['repository', 'baseBranch', 'remote', 'baseSha', 'branch', 'headSha']],
  push_branch: [['repository', 'remote', 'branch', 'headSha', 'expectedRemoteAbsent']],
  create_pull_request: [['repository', 'baseBranch', 'branch', 'headSha', 'title', 'draft', 'bindingSha256', 'providerBindingSha256', 'verificationCommandSha256']],
  observe_pull_request: [
    ['repository', 'baseBranch', 'remote', 'branch', 'headSha'],
    ['repository', 'baseBranch', 'remote', 'branch', 'headSha', 'pullRequest']
  ],
  remove_worktree: [['repository', 'branch', 'headSha']],
  remove_local_branch: [['repository', 'branch', 'headSha']],
  link_stack: [['repository', 'baseBranch', 'remote', 'packIds', 'pullRequests']],
  observe_stack: [['repository', 'baseBranch', 'remote', 'packIds', 'pullRequests']]
});

function validateParams(kind, params) {
  if (!plain(params)) refuse('invalid_action');
  const keys = Object.keys(params).sort();
  if (!ACTION_SHAPES[kind].some(shape => [...shape].sort().every((key, index) => keys[index] === key)
      && shape.length === keys.length)) refuse('invalid_action');
  if ('repository' in params && (!REPOSITORY.test(params.repository) || params.repository.length > 200)) refuse('invalid_action');
  if ('baseBranch' in params && !branch(params.baseBranch)) refuse('invalid_action');
  if ('branch' in params && !branch(params.branch)) refuse('invalid_action');
  if ('remote' in params && !REMOTE.test(params.remote)) refuse('invalid_action');
  for (const key of ['headSha', 'baseSha']) if (key in params && !COMMIT.test(params[key])) refuse('invalid_action');
  for (const key of ['bindingSha256', 'providerBindingSha256', 'verificationCommandSha256']) {
    if (key in params && !SHA256.test(params[key])) refuse('invalid_action');
  }
  if ('worktreeName' in params && (!WORKTREE_NAME.test(params.worktreeName)
      || params.worktreeName === '.' || params.worktreeName === '..')) refuse('invalid_action');
  if ('title' in params && !text(params.title, 200)) refuse('invalid_action');
  if ('draft' in params && params.draft !== true) refuse('invalid_action');
  if ('expectedRemoteAbsent' in params && params.expectedRemoteAbsent !== true) refuse('invalid_action');
  if ('pullRequest' in params && !positive(params.pullRequest)) refuse('invalid_action');
  if ('packIds' in params && !packList(params.packIds)) refuse('invalid_action');
  if ('pullRequests' in params && !prList(params.pullRequests)) refuse('invalid_action');
  if ('packIds' in params && params.packIds.length !== params.pullRequests.length) refuse('invalid_action');
  return Object.freeze({ ...params });
}

export function validateAction(action) {
  exactKeys(action, ['actionId', 'kind', 'params']);
  if (!SHA256.test(action.actionId) || !ACTION_KINDS.includes(action.kind)) refuse('invalid_action');
  return Object.freeze({ actionId: action.actionId, kind: action.kind,
    params: validateParams(action.kind, action.params) });
}

export function validateBinding(binding) {
  exactKeys(binding, ['workspaceId', 'packId', 'attempt', 'revision', 'repository', 'base', 'head', 'verificationCommandSha256']);
  if (!text(binding.workspaceId, 120) || !PACK_ID.test(binding.packId)
      || !positive(binding.attempt) || binding.attempt > 100
      || !positive(binding.revision) || binding.revision > 100
      || !REPOSITORY.test(binding.repository) || binding.repository.length > 200
      || !COMMIT.test(binding.base) || !COMMIT.test(binding.head)
      || !SHA256.test(binding.verificationCommandSha256)) refuse('invalid_binding');
  return Object.freeze({ ...binding });
}

function validatePullRequest(pull) {
  exactKeys(pull, ['number', 'url', 'state', 'draft', 'baseRef', 'baseSha', 'headRef', 'headSha', 'baseRepository', 'headRepository']);
  let url;
  try { url = new URL(pull.url); } catch { refuse('invalid_response'); }
  if (!positive(pull.number) || url.protocol !== 'https:' || url.username || url.password
      || pull.url.length > 2048 || !['open', 'closed', 'merged'].includes(pull.state)
      || typeof pull.draft !== 'boolean' || !branch(pull.baseRef) || !COMMIT.test(pull.baseSha)
      || !branch(pull.headRef) || !COMMIT.test(pull.headSha)
      || !REPOSITORY.test(pull.baseRepository) || !REPOSITORY.test(pull.headRepository)) refuse('invalid_response');
  return pull;
}

export function validateActionResult(result) {
  if (!plain(result) || typeof result.kind !== 'string') refuse('invalid_report');
  if (result.kind === 'host') {
    exactKeys(result, ['kind', 'platform', 'nodeVersion', 'gitVersion', 'shell', 'github', 'stack']);
    if (!['win32', 'linux', 'darwin'].includes(result.platform) || !text(result.nodeVersion, 40)
        || !text(result.gitVersion, 80)) refuse('invalid_report');
    exactKeys(result.shell, ['kind', 'available', 'version']);
    exactKeys(result.github, ['version', 'authenticated', 'repository', 'pushPermission']);
    exactKeys(result.stack, ['extensionCount', 'publisher', 'commandAvailable']);
    if (!['pwsh', 'sh'].includes(result.shell.kind) || typeof result.shell.available !== 'boolean'
        || !(result.shell.version === null || text(result.shell.version, 80))
        || !(result.github.version === null || text(result.github.version, 80))
        || typeof result.github.authenticated !== 'boolean'
        || !(result.github.repository === null || REPOSITORY.test(result.github.repository))
        || typeof result.github.pushPermission !== 'boolean'
        || !Number.isInteger(result.stack.extensionCount) || result.stack.extensionCount < 0 || result.stack.extensionCount > 32
        || !(result.stack.publisher === null || text(result.stack.publisher, 120))
        || typeof result.stack.commandAvailable !== 'boolean') refuse('invalid_report');
  } else if (result.kind === 'repository') {
    exactKeys(result, ['kind', 'repositoryRootSha256', 'clean', 'currentBranch', 'headSha', 'baseRef', 'localBaseSha',
      'remoteBaseSha', 'repository', 'remote', 'pushUrlCount', 'pushUrlRepository', 'gitConfigSha256', 'worktree',
      'localBranch', 'remoteBranch', 'pullRequests']);
    if (!SHA256.test(result.repositoryRootSha256) || typeof result.clean !== 'boolean' || !branch(result.currentBranch)
        || !COMMIT.test(result.headSha) || !branch(result.baseRef) || !COMMIT.test(result.localBaseSha)
        || !COMMIT.test(result.remoteBaseSha) || !REPOSITORY.test(result.repository) || !REMOTE.test(result.remote)
        || !Number.isInteger(result.pushUrlCount) || result.pushUrlCount < 0 || result.pushUrlCount > 8
        || !(result.pushUrlRepository === null || REPOSITORY.test(result.pushUrlRepository))
        || !SHA256.test(result.gitConfigSha256)) refuse('invalid_report');
    exactKeys(result.worktree, ['registered', 'exists', 'clean', 'headSha']);
    exactKeys(result.localBranch, ['exists', 'sha']);
    exactKeys(result.remoteBranch, ['reachable', 'exists', 'sha']);
    if (typeof result.worktree.registered !== 'boolean' || typeof result.worktree.exists !== 'boolean'
        || !(result.worktree.clean === null || typeof result.worktree.clean === 'boolean')
        || !(result.worktree.headSha === null || COMMIT.test(result.worktree.headSha))
        || typeof result.localBranch.exists !== 'boolean'
        || !(result.localBranch.sha === null || COMMIT.test(result.localBranch.sha))
        || typeof result.remoteBranch.reachable !== 'boolean' || typeof result.remoteBranch.exists !== 'boolean'
        || !(result.remoteBranch.sha === null || COMMIT.test(result.remoteBranch.sha))
        || !Array.isArray(result.pullRequests) || result.pullRequests.length > 2) refuse('invalid_report');
    result.pullRequests.forEach(validatePullRequest);
  } else if (result.kind === 'worktree') {
    exactKeys(result, ['kind', 'repositoryRootSha256', 'branch', 'headSha', 'clean', 'registered']);
    if (!SHA256.test(result.repositoryRootSha256) || !branch(result.branch) || !COMMIT.test(result.headSha)
        || typeof result.clean !== 'boolean' || typeof result.registered !== 'boolean') refuse('invalid_report');
  } else if (result.kind === 'push') {
    exactKeys(result, ['kind', 'branch', 'headSha', 'remoteSha']);
    if (!branch(result.branch) || !COMMIT.test(result.headSha) || !COMMIT.test(result.remoteSha)) refuse('invalid_report');
  } else if (result.kind === 'pull_request') {
    exactKeys(result, ['kind', 'pullRequest']); validatePullRequest(result.pullRequest);
  } else if (result.kind === 'cleanup') {
    exactKeys(result, ['kind', 'worktreeRemoved', 'localBranchPresent', 'headSha']);
    if (typeof result.worktreeRemoved !== 'boolean' || typeof result.localBranchPresent !== 'boolean'
        || !COMMIT.test(result.headSha)) refuse('invalid_report');
  } else if (result.kind === 'stack') {
    exactKeys(result, ['kind', 'pullRequests']);
    if (!Array.isArray(result.pullRequests) || result.pullRequests.length < 2 || result.pullRequests.length > 8) refuse('invalid_report');
    result.pullRequests.forEach(validatePullRequest);
  } else refuse('invalid_report');
  return result;
}

export function makeSuccessReport(actionId, result) {
  if (!SHA256.test(actionId)) refuse('invalid_report');
  return { actionId, status: 'succeeded', result: validateActionResult(result) };
}

function validateReceipt(receipt) {
  exactKeys(receipt, ['phase', 'summary'], ['candidatePullRequest', 'acceptance', 'cleanup', 'pullRequests', 'error']);
  if (!['ready', 'prepared', 'candidate_published', 'awaiting_owner_readiness', 'awaiting_provider_evidence', 'accepted', 'completed', 'aborted', 'stacked', 'refused'].includes(receipt.phase)
      || !text(receipt.summary, 500)) refuse('invalid_response');
  if ('candidatePullRequest' in receipt) validatePullRequest(receipt.candidatePullRequest);
  if ('acceptance' in receipt) {
    exactKeys(receipt.acceptance, ['status', 'auditEventId']);
    if (!['not_requested', 'awaiting_owner_readiness', 'awaiting_provider_evidence', 'accepted'].includes(receipt.acceptance.status)
        || !(receipt.acceptance.auditEventId === null || text(receipt.acceptance.auditEventId, 120))) refuse('invalid_response');
  }
  if ('cleanup' in receipt) {
    exactKeys(receipt.cleanup, ['worktreeRemoved', 'localBranchPreserved']);
    if (typeof receipt.cleanup.worktreeRemoved !== 'boolean' || typeof receipt.cleanup.localBranchPreserved !== 'boolean') refuse('invalid_response');
  }
  if ('pullRequests' in receipt) {
    if (!Array.isArray(receipt.pullRequests) || receipt.pullRequests.length < 2 || receipt.pullRequests.length > 8) refuse('invalid_response');
    receipt.pullRequests.forEach(validatePullRequest);
  }
  if ('error' in receipt) {
    exactKeys(receipt.error, ['code']);
    if (!ERROR_CODE.test(receipt.error.code)) refuse('invalid_response');
  }
  return receipt;
}

export function validateResponse(value, request) {
  exactKeys(value, ['schemaVersion', 'operationId', 'operation', 'status'], ['binding', 'action', 'receipt']);
  if (value.schemaVersion !== 1 || value.operationId !== request.operationId
      || value.operation !== request.operation || ![
        'needs_action', 'ready', 'prepared', 'observed', 'candidate_published',
        'awaiting_owner_readiness', 'awaiting_provider_evidence', 'accepted',
        'completed', 'aborted', 'stacked', 'refused'
      ].includes(value.status)) refuse('invalid_response');
  if (value.status === 'needs_action') {
    if (!Object.hasOwn(value, 'action') || Object.hasOwn(value, 'receipt')) refuse('invalid_response');
  } else if (Object.hasOwn(value, 'action')) refuse('invalid_response');
  if ('binding' in value) validateBinding(value.binding);
  if ('action' in value) validateAction(value.action);
  if ('receipt' in value) validateReceipt(value.receipt);
  return value;
}

export function validateRequest(request) {
  if (!plain(request) || request.schemaVersion !== 1 || !OPERATION_ID.test(request.operationId)
      || !OPERATIONS.includes(request.operation)) refuse('invalid_request');
  const common = ['schemaVersion', 'operationId', 'operation', 'request'];
  const required = request.operation === 'doctor' ? common
    : request.operation === 'stack' ? [...common, 'packIds'] : [...common, 'packId'];
  exactKeys(request, required, ['report']);
  if ('packId' in request && !PACK_ID.test(request.packId)) refuse('invalid_request');
  if ('packIds' in request && !packList(request.packIds)) refuse('invalid_request');
  if (!plain(request.request)) refuse('invalid_request');
  const value = request.request;
  if (request.operation === 'doctor') {
    exactKeys(value, ['repository', 'baseBranch', 'remote', 'stack']);
    if (!REPOSITORY.test(value.repository) || !branch(value.baseBranch) || !REMOTE.test(value.remote)
        || typeof value.stack !== 'boolean') refuse('invalid_request');
  } else if (request.operation === 'prepare') {
    exactKeys(value, ['title', 'baseBranch', 'remote', 'verificationCommandSha256']);
    if (!text(value.title, 200) || !branch(value.baseBranch) || !REMOTE.test(value.remote)
        || !SHA256.test(value.verificationCommandSha256)) refuse('invalid_request');
  } else if (request.operation === 'publish') {
    exactKeys(value, ['headSha', 'handoffSha256']);
    if (!COMMIT.test(value.headSha) || !SHA256.test(value.handoffSha256)) refuse('invalid_request');
  } else if (request.operation === 'finalize') {
    exactKeys(value, [], ['githubEvidence']);
    if ('githubEvidence' in value) {
      exactKeys(value.githubEvidence, ['pullRequest', 'runId', 'runAttempt', 'artifactId', 'reviewId']);
      if (Object.values(value.githubEvidence).some(item => !positive(item))) refuse('invalid_request');
    }
  } else if (request.operation === 'status' || request.operation === 'abort') exactKeys(value, []);
  else if (request.operation === 'stack') {
    exactKeys(value, ['baseBranch', 'remote']);
    if (!branch(value.baseBranch) || !REMOTE.test(value.remote)) refuse('invalid_request');
  }
  if ('report' in request) validateReport(request.report);
  return request;
}

export function validateReport(report) {
  if (!plain(report) || !SHA256.test(report.actionId ?? '') || !['succeeded', 'failed', 'uncertain'].includes(report.status)) {
    refuse('invalid_report');
  }
  if (report.status === 'succeeded') {
    exactKeys(report, ['actionId', 'status', 'result']);
    validateActionResult(report.result);
  } else {
    exactKeys(report, ['actionId', 'status', 'error']);
    exactKeys(report.error, ['code']);
    if (!ERROR_CODE.test(report.error.code)) refuse('invalid_report');
  }
  return report;
}

export function makeFailureReport(actionId, status, code) {
  if (!SHA256.test(actionId) || !['failed', 'uncertain'].includes(status) || !ERROR_CODE.test(code)) refuse('invalid_report');
  return { actionId, status, error: { code } };
}
