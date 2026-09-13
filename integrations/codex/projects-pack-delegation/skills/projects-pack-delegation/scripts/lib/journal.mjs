import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_DIRECTORY = 'projects-pr-client-v1';
export const JOURNAL_MAX_BYTES = 512 * 1024;
const PACK_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REMOTE = /^[A-Za-z0-9._-]{1,80}$/u;

export class JournalError extends Error {
  constructor(code) {
    super('The local Projects PR Machine recovery journal was refused.');
    this.name = 'JournalError';
    this.code = code;
  }
}

const fail = code => { throw new JournalError(code); };
const samePath = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;

async function checkedGitPath(runner, repositoryRoot, args) {
  const result = await runner({ executable: 'git', args, cwd: repositoryRoot, shell: false, timeoutMs: 10_000 });
  if (result?.exitCode !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 8192) {
    fail('repository_unavailable');
  }
  const value = result.stdout.replace(/\r?\n$/u, '');
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) fail('repository_unavailable');
  return value;
}

export async function discoverJournal(repositoryRoot, runner, { create = false, fsApi = fs } = {}) {
  let root;
  try {
    if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim() || repositoryRoot.length > 1000
        || /[\u0000-\u001f\u007f]/u.test(repositoryRoot)) fail('repository_unavailable');
    root = await fsApi.realpath(path.resolve(repositoryRoot));
    const topText = await checkedGitPath(runner, root, ['rev-parse', '--show-toplevel']);
    const top = await fsApi.realpath(topText);
    if (!samePath(root, top)) fail('unsafe_repository');
    const commonText = await checkedGitPath(runner, root, ['rev-parse', '--git-common-dir']);
    const common = await fsApi.realpath(path.resolve(root, commonText));
    const commonStat = await fsApi.lstat(common);
    if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) fail('unsafe_repository');
    const directory = path.join(common, JOURNAL_DIRECTORY);
    if (create) {
      try { await fsApi.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') fail('journal_write_failed'); }
    }
    let directoryStat;
    try { directoryStat = await fsApi.lstat(directory); }
    catch (error) {
      if (error?.code === 'ENOENT' && !create) return { root, common, directory, exists: false };
      fail('journal_unavailable');
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('journal_unavailable');
    const resolved = await fsApi.realpath(directory);
    if (!samePath(resolved, directory)) fail('journal_unavailable');
    return { root, common, directory, exists: true };
  } catch (error) {
    if (error instanceof JournalError) throw error;
    fail('repository_unavailable');
  }
}

function journalPath(location, packId) {
  if (!PACK_ID.test(packId)) fail('invalid_input');
  return path.join(location.directory, `${packId}.json`);
}

export async function readJournal(location, packId, { required = true, fsApi = fs } = {}) {
  if (!location.exists) {
    if (required) fail('state_not_found');
    return null;
  }
  const target = journalPath(location, packId);
  let stat;
  try { stat = await fsApi.lstat(target); }
  catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    fail(error?.code === 'ENOENT' ? 'state_not_found' : 'journal_unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > JOURNAL_MAX_BYTES) fail('journal_unavailable');
  let state;
  try { state = JSON.parse(await fsApi.readFile(target, 'utf8')); }
  catch { fail('journal_unavailable'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || state.schemaVersion !== JOURNAL_SCHEMA_VERSION || state.kind !== 'projects-pr-local-runner-journal'
      || state.packId !== packId || state.repositoryRoot !== location.root
      || !REPOSITORY.test(state.repository ?? '') || !REMOTE.test(state.remote ?? '')
      || typeof state.baseBranch !== 'string' || !COMMIT.test(state.baseSha ?? '')
      || !COMMIT.test(state.assignmentHead ?? '') || !SHA256.test(state.verificationCommandSha256 ?? '')
      || !SHA256.test(state.gitConfigSha256 ?? '') || typeof state.verificationCommand !== 'string'
      || !Array.isArray(state.actions) || state.actions.length > 64) fail('journal_unavailable');
  if (state.worktreePath !== null) {
    const base = path.join(path.dirname(location.root), '.projects-pr-worktrees');
    const relative = path.relative(base, state.worktreePath);
    if (!path.isAbsolute(state.worktreePath) || !relative || relative.startsWith('..') || path.isAbsolute(relative)
        || typeof state.createdBranch !== 'string') fail('journal_unavailable');
  }
  return state;
}

export async function writeJournal(location, state, { fsApi = fs } = {}) {
  if (!location.exists || !state || typeof state !== 'object' || Array.isArray(state)
      || state.schemaVersion !== JOURNAL_SCHEMA_VERSION || state.kind !== 'projects-pr-local-runner-journal'
      || !PACK_ID.test(state.packId) || state.repositoryRoot !== location.root
      || !Array.isArray(state.actions) || state.actions.length > 64) fail('journal_write_failed');
  const target = journalPath(location, state.packId);
  const temporary = path.join(location.directory, `.${state.packId}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (bytes.length > JOURNAL_MAX_BYTES) fail('journal_write_failed');
  let handle;
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await fsApi.rename(temporary, target);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await fsApi.unlink(temporary).catch(() => {});
    fail('journal_write_failed');
  }
}

export function newJournal({ packId, repositoryRoot, repository, baseBranch, remote,
  baseSha, assignmentHead, verificationCommand, verificationCommandSha256, gitConfigSha256 }) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    kind: 'projects-pr-local-runner-journal',
    packId,
    repositoryRoot,
    repository,
    baseBranch,
    remote,
    baseSha,
    assignmentHead,
    verificationCommand,
    verificationCommandSha256,
    gitConfigSha256,
    binding: null,
    worktreePath: null,
    createdBranch: null,
    activeOperation: null,
    actions: [],
    updatedAt: new Date().toISOString()
  };
}
