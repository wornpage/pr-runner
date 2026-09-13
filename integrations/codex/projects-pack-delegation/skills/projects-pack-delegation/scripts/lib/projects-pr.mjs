import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ActionAuthorityError, assertActionAuthority } from './action-authority.mjs';
import { createProcessSession, defaultProjectsPrRunner } from './bounded-process.mjs';
import { ActionExecutionError, executeAction, repositoryFromRemote } from './host-actions.mjs';
import { discoverJournal, newJournal, readJournal, writeJournal } from './journal.mjs';
import {
  ProtocolError, digestJson, makeFailureReport, makeSuccessReport, sha256,
  validateAction, validateBinding, validateRequest, validateResponse
} from './protocol.mjs';
import { LifecycleLockError, withRepositoryLifecycleLock } from './repository-lock.mjs';
import { createProjectsTransport, TransportError } from './transport.mjs';

export const PROJECTS_PR_CLIENT_VERSION = 1;
export const PROJECTS_PR_RECEIPT_VERSION = 1;
const PACK_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REMOTE = /^[A-Za-z0-9._-]{1,80}$/u;

export class ProjectsPrClientError extends Error {
  constructor(code, command = null) {
    super('projects-pr local runner failed.');
    this.name = 'ProjectsPrClientError';
    this.code = code;
    this.command = command;
  }
}

const fail = (code, command) => { throw new ProjectsPrClientError(code, command); };
const safeText = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max
  && value.trim() === value && value.isWellFormed() && !/[\u0000\r\n\u2028\u2029]/u.test(value);
const branch = value => safeText(value, 240) && !value.startsWith('-')
  && !/\.\.|\/\/|@\{|[~^:?*\[\]\\]|\s/u.test(value);

async function invoke(runner, executable, args, cwd, code = 'repository_unavailable') {
  const result = await runner({ executable, args, cwd, shell: false, timeoutMs: 30_000 });
  if (result?.processUncertain) fail('subprocess_uncertain');
  if (result?.exitCode !== 0 || typeof result.stdout !== 'string') fail(code);
  return result.stdout;
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('invalid_input');
  }
  return path.resolve(value);
}

async function discoverRepository(input, runner, dependencies) {
  const requested = normalizeRoot(input.repositoryRoot ?? process.cwd());
  let root;
  try { root = await fs.realpath(requested); } catch { fail('repository_unavailable'); }
  const top = (await invoke(runner, 'git', ['rev-parse', '--show-toplevel'], root)).replace(/\r?\n$/u, '');
  let realTop;
  try { realTop = await fs.realpath(top); } catch { fail('unsafe_repository'); }
  const same = process.platform === 'win32' ? realTop.toLowerCase() === root.toLowerCase() : realTop === root;
  if (!same) fail('unsafe_repository');
  const remote = input.remote ?? 'origin';
  if (!REMOTE.test(remote)) fail('invalid_input');
  const urls = (await invoke(runner, 'git', ['remote', 'get-url', '--all', remote], root,
    'remote_unavailable')).split(/\r?\n/gu).filter(Boolean);
  const pushUrls = (await invoke(runner, 'git', ['remote', 'get-url', '--push', '--all', remote], root,
    'remote_unavailable')).split(/\r?\n/gu).filter(Boolean);
  if (urls.length !== 1 || pushUrls.length !== 1) fail('repository_mismatch');
  const repository = dependencies.repositoryIdentity ?? repositoryFromRemote(urls[0]);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') || repository.length > 200) {
    fail('repository_mismatch');
  }
  if (!dependencies.repositoryIdentity && (repositoryFromRemote(pushUrls[0])?.toLowerCase() !== repository.toLowerCase())) {
    fail('repository_mismatch');
  }
  const currentBranch = (await invoke(runner, 'git', ['branch', '--show-current'], root)).trim();
  const baseBranch = input.baseBranch ?? currentBranch;
  if (!branch(baseBranch)) fail('invalid_input');
  const baseSha = (await invoke(runner, 'git', ['rev-parse', '--verify', `refs/heads/${baseBranch}`], root,
    'base_reference_missing')).trim();
  if (!COMMIT.test(baseSha)) fail('base_reference_missing');
  const gitConfigSha256 = sha256(await invoke(runner, 'git', ['config', '--local', '--null', '--list'], root));
  return { root, repository, remote, baseBranch, baseSha, currentBranch, gitConfigSha256 };
}

function commandRequest(command, input, operationId, state, report) {
  let request;
  if (command === 'doctor') request = { repository: state.repository, baseBranch: state.baseBranch,
    remote: state.remote, stack: input.stack === true };
  if (command === 'prepare') request = { title: input.title, baseBranch: state.baseBranch,
    remote: state.remote, verificationCommandSha256: state.verificationCommandSha256 };
  if (command === 'publish') request = { headSha: input.headSha, handoffSha256: input.handoffSha256 };
  if (command === 'finalize') request = input.githubEvidence ? { githubEvidence: input.githubEvidence } : {};
  if (command === 'status' || command === 'abort') request = {};
  if (command === 'stack') request = { baseBranch: state.baseBranch, remote: state.remote };
  const value = { schemaVersion: 1, operationId, operation: command, request };
  if (command === 'stack') value.packIds = input.packIds;
  else if (command !== 'doctor') value.packId = input.packId;
  if (report) value.report = report;
  return validateRequest(value);
}

function validateInput(command, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_input', command);
  if (!['doctor', 'prepare', 'publish', 'finalize', 'status', 'abort', 'stack'].includes(command)) fail('invalid_input', command);
  if (command !== 'doctor' && command !== 'stack' && !PACK_ID.test(input.packId ?? '')) fail('invalid_input', command);
  if (command === 'stack' && (!Array.isArray(input.packIds) || input.packIds.length < 2 || input.packIds.length > 8
      || new Set(input.packIds).size !== input.packIds.length || input.packIds.some(id => !PACK_ID.test(id)))) fail('invalid_input', command);
  if (command === 'prepare' && (!safeText(input.title, 200) || !safeText(input.verificationCommand, 4096))) fail('invalid_input', command);
  if (command === 'publish' && (!COMMIT.test(input.headSha ?? '') || !SHA256.test(input.handoffSha256 ?? ''))) fail('invalid_input', command);
  if (command === 'finalize' && input.githubEvidence) {
    const evidence = input.githubEvidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
        || Object.keys(evidence).sort().join(',') !== 'artifactId,pullRequest,reviewId,runAttempt,runId'
        || Object.values(evidence).some(value => !Number.isSafeInteger(value) || value < 1)) fail('invalid_input', command);
  }
}

function assertBinding(state, binding) {
  validateBinding(binding);
  if (binding.packId !== state.packId || binding.repository.toLowerCase() !== state.repository.toLowerCase()
      || binding.base !== state.baseSha || binding.head !== state.assignmentHead
      || binding.verificationCommandSha256 !== state.verificationCommandSha256) fail('binding_mismatch');
  if (state.binding) {
    if (digestJson(state.binding) !== digestJson(binding)) fail('binding_mismatch');
  } else state.binding = { ...binding };
}

function assertActionContext(state, action, input) {
  validateAction(action);
  const params = action.params;
  if (params.repository !== state.repository) fail('action_context_mismatch');
  if ('baseBranch' in params && params.baseBranch !== state.baseBranch) fail('action_context_mismatch');
  if ('remote' in params && params.remote !== state.remote) fail('action_context_mismatch');
  if ('baseSha' in params && params.baseSha !== state.baseSha) fail('action_context_mismatch');
  if ('verificationCommandSha256' in params && params.verificationCommandSha256 !== state.verificationCommandSha256) {
    fail('action_context_mismatch');
  }
  if (action.kind === 'create_worktree') {
    if (params.headSha !== state.assignmentHead || params.headSha !== state.baseSha) fail('action_context_mismatch');
    if (!state.targetObservation || state.targetObservation.branch !== params.branch
        || state.targetObservation.headSha !== params.headSha
        || state.targetObservation.worktreeName !== params.worktreeName
        || state.targetObservation.absent !== true) {
      fail('target_not_observed');
    }
  }
  if (['observe_candidate', 'push_branch', 'create_pull_request', 'remove_worktree', 'remove_local_branch'].includes(action.kind)) {
    if (state.createdBranch && params.branch !== state.createdBranch) fail('action_context_mismatch');
    const expected = state.candidateHead ?? state.assignmentHead;
    if (params.headSha !== expected) fail('action_context_mismatch');
  }
  if (action.kind === 'create_pull_request') {
    const publicationBinding = digestJson({ command: 'projects-pr-machine-publication',
      args: { binding: state.binding, handoffSha256: input.handoffSha256, headSha: input.headSha } });
    if (params.bindingSha256 !== publicationBinding) fail('action_context_mismatch');
    if (state.providerBindingSha256 && state.providerBindingSha256 !== params.providerBindingSha256) {
      fail('action_context_mismatch');
    }
    state.providerBindingSha256 = params.providerBindingSha256;
  }
  if (['link_stack', 'observe_stack'].includes(action.kind)
      && digestJson(params.packIds) !== digestJson(input.packIds)) fail('action_context_mismatch');
}

function operationIdentity(command, input, state) {
  const material = { command, packId: input.packId, packIds: input.packIds, repository: state.repository,
    baseBranch: state.baseBranch, remote: state.remote, title: input.title,
    verificationCommandSha256: state.verificationCommandSha256, headSha: input.headSha,
    handoffSha256: input.handoffSha256, githubEvidence: input.githubEvidence };
  return digestJson(material);
}

function beginOperation(state, command, input) {
  const inputDigest = operationIdentity(command, input, state);
  if (state.activeOperation && state.activeOperation.command === command
      && state.activeOperation.inputDigest === inputDigest && state.activeOperation.terminal !== true) {
    return state.activeOperation;
  }
  state.activeOperation = { command, inputDigest, operationId: `${command}:${input.packId ?? 'repository'}:${randomUUID()}`,
    terminal: false, report: null };
  return state.activeOperation;
}

async function loadStackJournals(location, input) {
  const journals = [];
  for (const packId of input.packIds) journals.push(await readJournal(location, packId));
  const first = journals[0];
  if (journals.some(state => state.repositoryRoot !== first.repositoryRoot || state.repository !== first.repository
      || state.remote !== first.remote || !state.binding || !state.createdBranch || !state.candidateHead)) fail('stack_mismatch');
  for (let index = 1; index < journals.length; index += 1) {
    if (journals[index].baseBranch !== journals[index - 1].createdBranch
        || journals[index].baseSha !== journals[index - 1].candidateHead) fail('stack_mismatch');
  }
  return journals;
}

function publicReceipt(command, response, state) {
  const result = { schemaVersion: PROJECTS_PR_RECEIPT_VERSION, kind: 'projects-pr-local-runner', command,
    status: response.status, operationId: response.operationId, receipt: response.receipt ?? null };
  if (command === 'doctor') result.capability = { available: response.status === 'ready' };
  if (state && ['prepare', 'publish', 'status', 'finalize', 'abort'].includes(command)) {
    result.plan = { branch: state.createdBranch, worktreePath: state.worktreePath,
      verificationCommandSha256: state.verificationCommandSha256 };
  }
  return result;
}

async function runLoop(command, input, state, location, journals, session, transport, dependencies) {
  const operation = beginOperation(state, command, input);
  if (location) await writeJournal(location, state);
  for (let step = 0; step < 24; step += 1) {
    const request = commandRequest(command, input, operation.operationId, state, operation.report);
    const raw = await transport(request);
    const response = validateResponse(raw, request);
    if (response.binding) assertBinding(state, response.binding);
    if (response.status !== 'needs_action') {
      operation.terminal = true;
      operation.report = null;
      state.updatedAt = new Date().toISOString();
      if (location) await writeJournal(location, state);
      return publicReceipt(command, response, state);
    }
    if (!state.binding && command !== 'doctor') fail('binding_missing');
    const action = validateAction(response.action);
    assertActionAuthority(command, action.kind);
    assertActionContext(state, action, input);
    const actionDigest = digestJson(action);
    let record = state.actions.find(item => item.actionId === action.actionId);
    if (record && (record.actionDigest !== actionDigest || record.operationId !== operation.operationId)) {
      fail('action_replay_mismatch');
    }
    if (!record) {
      record = { actionId: action.actionId, actionDigest, operationId: operation.operationId,
        action, status: 'intent', report: null,
        recordedAt: new Date().toISOString() };
      state.actions.push(record);
      if (state.actions.length > 64) fail('journal_capacity_exceeded');
      if (location) await writeJournal(location, state);
    }
    if (['succeeded', 'failed', 'uncertain'].includes(record.status)) {
      operation.report = record.report;
      continue;
    }
    const recovery = record.status === 'executing';
    if (!recovery) {
      if (record.status !== 'intent') fail('journal_unavailable');
      record.status = 'executing';
      if (location) await writeJournal(location, state);
    }
    try {
      const result = await executeAction(action, { state, runner: session.runner,
        operation: command, provider: dependencies.provider, journals, recovery,
        persist: location ? () => writeJournal(location, state) : async () => {} });
      record.report = makeSuccessReport(action.actionId, result);
      record.status = 'succeeded';
      if (action.kind === 'observe_repository' && Object.hasOwn(action.params, 'branch')) {
        state.targetObservation = { branch: action.params.branch, headSha: action.params.headSha,
          worktreeName: action.params.worktreeName,
          absent: result.worktree.registered === false && result.worktree.exists === false
            && result.localBranch.exists === false && result.remoteBranch.reachable === true
            && result.remoteBranch.exists === false };
      }
    } catch (error) {
      const uncertain = error instanceof ActionExecutionError && error.uncertain;
      const code = error instanceof ActionExecutionError ? error.code : 'host_action_failed';
      record.report = makeFailureReport(action.actionId, uncertain ? 'uncertain' : 'failed', code);
      record.status = uncertain ? 'uncertain' : 'failed';
      if (location) await writeJournal(location, state);
      if (uncertain) fail('subprocess_uncertain');
    }
    operation.report = record.report;
    state.updatedAt = new Date().toISOString();
    if (location) await writeJournal(location, state);
  }
  fail('protocol_step_limit');
}

export async function runProjectsPr(command, input = {}, dependencies = {}) {
  validateInput(command, input);
  const session = createProcessSession(dependencies.runner ?? defaultProjectsPrRunner);
  let transport;
  try { transport = dependencies.transport ?? createProjectsTransport(dependencies.transportOptions); }
  catch (error) {
    if (error instanceof TransportError) throw new ProjectsPrClientError(error.code, command);
    throw error;
  }
  let discovered;
  try { discovered = await discoverRepository(input, session.runner, dependencies); }
  catch (error) { if (error instanceof ProjectsPrClientError) { error.command = command; throw error; } throw error; }
  if (command === 'doctor') {
    const state = { packId: 'doctor', repositoryRoot: discovered.root, repository: discovered.repository,
      baseBranch: discovered.baseBranch, remote: discovered.remote, baseSha: discovered.baseSha,
      assignmentHead: discovered.baseSha, verificationCommandSha256: sha256('doctor'), binding: null,
      gitConfigSha256: discovered.gitConfigSha256, actions: [], activeOperation: null };
    try { return await runLoop(command, input, state, null, null, session, transport, dependencies); }
    catch (error) {
      if (error instanceof ProjectsPrClientError) { error.command = command; throw error; }
      if (error instanceof ProtocolError || error instanceof TransportError || error instanceof ActionAuthorityError) {
        throw new ProjectsPrClientError(error.code, command);
      }
      throw new ProjectsPrClientError('runner_failed', command);
    }
  }
  try {
    return await withRepositoryLifecycleLock(discovered.root, async () => {
      const create = command === 'prepare';
      const location = await discoverJournal(discovered.root, session.runner, { create });
      let state; let journals = null;
      if (command === 'prepare') {
        const existing = await readJournal(location, input.packId, { required: false });
        const commandHash = sha256(input.verificationCommand);
        state = existing ?? newJournal({ packId: input.packId, repositoryRoot: discovered.root,
          repository: discovered.repository, baseBranch: discovered.baseBranch, remote: discovered.remote,
          baseSha: discovered.baseSha, assignmentHead: discovered.baseSha,
          verificationCommand: input.verificationCommand, verificationCommandSha256: commandHash,
          gitConfigSha256: discovered.gitConfigSha256 });
        if (existing && (existing.repository !== discovered.repository || existing.baseSha !== discovered.baseSha
            || existing.verificationCommandSha256 !== commandHash || existing.verificationCommand !== input.verificationCommand)) {
          fail('assignment_changed');
        }
      } else if (command === 'stack') {
        journals = await loadStackJournals(location, input);
        state = journals[0];
      } else state = await readJournal(location, input.packId);
      if (state.repository !== discovered.repository || state.repositoryRoot !== discovered.root
          || (command !== 'stack' && state.baseBranch !== discovered.baseBranch) || state.remote !== discovered.remote
          || state.baseSha !== discovered.baseSha || state.gitConfigSha256 !== discovered.gitConfigSha256) fail('repository_changed');
      if (command === 'publish') {
        if (state.candidateHead && state.candidateHead !== input.headSha) fail('candidate_changed');
        if (!state.worktreePath) fail('candidate_unavailable');
        const candidate = await invoke(session.runner, 'git', ['rev-parse', 'HEAD'], state.worktreePath,
          'candidate_unavailable');
        if (candidate.trim() !== input.headSha) fail('candidate_changed');
        state.candidateHead = input.headSha;
      }
      return runLoop(command, input, state, location, journals, session, transport, dependencies);
    }, { runner: session.runner, canRelease: session.canRelease });
  } catch (error) {
    if (error instanceof LifecycleLockError) throw new ProjectsPrClientError(error.code, command);
    if (error instanceof ProjectsPrClientError) { error.command = command; throw error; }
    if (error instanceof ProtocolError || error instanceof TransportError || error instanceof ActionAuthorityError) {
      throw new ProjectsPrClientError(error.code, command);
    }
    throw new ProjectsPrClientError('runner_failed', command);
  }
}

export const runProjectsPrDoctor = (input, dependencies) => runProjectsPr('doctor', input, dependencies);
export const prepareProjectsPr = (input, dependencies) => runProjectsPr('prepare', input, dependencies);
export const publishProjectsPr = (input, dependencies) => runProjectsPr('publish', input, dependencies);
export const finalizeProjectsPr = (input, dependencies) => runProjectsPr('finalize', input, dependencies);
export const statusProjectsPr = (input, dependencies) => runProjectsPr('status', input, dependencies);
export const abortProjectsPr = (input, dependencies) => runProjectsPr('abort', input, dependencies);
export const stackProjectsPr = (input, dependencies) => runProjectsPr('stack', input, dependencies);
