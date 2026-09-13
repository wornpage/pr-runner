#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProjectsPrClientError, runProjectsPr } from './lib/projects-pr.mjs';

const HELP = `projects-pr v3

Bounded local host runner for the private Projects PR Machine service.

Usage:
  projects-pr doctor [--repo PATH] [--base BRANCH] [--remote NAME] [--stack]
  projects-pr prepare --pack-id ID --title TEXT --base BRANCH \\
    --verify-command COMMAND [--repo PATH] [--remote NAME]
  projects-pr publish --pack-id ID --head SHA --handoff-sha256 SHA [--repo PATH]
  projects-pr finalize --pack-id ID [--repo PATH] [provider evidence options]
  projects-pr status --pack-id ID [--repo PATH]
  projects-pr abort --pack-id ID [--repo PATH]
  projects-pr stack --pack-id BOTTOM --pack-id NEXT [--pack-id TOP ...] \\
    --base BRANCH [--repo PATH] [--remote NAME]

Provider evidence options for finalize (supply all five or none):
  --github-pr NUMBER
  --github-run NUMBER
  --github-attempt NUMBER
  --github-artifact NUMBER
  --github-review NUMBER

The runner reads PROJECTS_MCP_ENDPOINT and PROJECTS_MCP_TOKEN from its local
environment. It sends only the frozen v1 protocol to the authenticated /mcp
endpoint. It never executes candidate verification, marks a draft ready,
merges, deploys, accepts server-selected paths, or accepts server-selected shell.
`;

const OPTIONS = Object.freeze({
  doctor: new Map([['--repo', 'repositoryRoot'], ['--base', 'baseBranch'], ['--remote', 'remote'], ['--stack', 'stack']]),
  prepare: new Map([['--pack-id', 'packId'], ['--title', 'title'], ['--base', 'baseBranch'],
    ['--verify-command', 'verificationCommand'], ['--repo', 'repositoryRoot'], ['--remote', 'remote']]),
  publish: new Map([['--pack-id', 'packId'], ['--head', 'headSha'], ['--handoff-sha256', 'handoffSha256'],
    ['--repo', 'repositoryRoot']]),
  finalize: new Map([['--pack-id', 'packId'], ['--repo', 'repositoryRoot'], ['--github-pr', 'pullRequest'],
    ['--github-run', 'runId'], ['--github-attempt', 'runAttempt'], ['--github-artifact', 'artifactId'],
    ['--github-review', 'reviewId']]),
  status: new Map([['--pack-id', 'packId'], ['--repo', 'repositoryRoot']]),
  abort: new Map([['--pack-id', 'packId'], ['--repo', 'repositoryRoot']]),
  stack: new Map([['--pack-id', 'packIds'], ['--base', 'baseBranch'], ['--repo', 'repositoryRoot'], ['--remote', 'remote']])
});

export function parseProjectsPrArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') return { help: true };
  const command = argv[0];
  const allowed = OPTIONS[command];
  if (!allowed) throw new ProjectsPrClientError('invalid_input', command);
  const output = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    const field = allowed.get(argument);
    if (!field) throw new ProjectsPrClientError('invalid_input', command);
    if (field === 'stack') {
      if (output.stack === true) throw new ProjectsPrClientError('invalid_input', command);
      output.stack = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ProjectsPrClientError('invalid_input', command);
    if (field === 'packIds') {
      output.packIds ??= [];
      output.packIds.push(value);
    } else {
      if (Object.hasOwn(output, field)) throw new ProjectsPrClientError('invalid_input', command);
      output[field] = value;
    }
    index += 1;
  }
  output.repositoryRoot = path.resolve(output.repositoryRoot ?? process.cwd());
  const evidenceFields = ['pullRequest', 'runId', 'runAttempt', 'artifactId', 'reviewId'];
  const supplied = evidenceFields.filter(field => Object.hasOwn(output, field));
  if (supplied.length && supplied.length !== evidenceFields.length) throw new ProjectsPrClientError('invalid_input', command);
  if (supplied.length) {
    output.githubEvidence = Object.fromEntries(evidenceFields.map(field => [field, Number(output[field])]));
    for (const field of evidenceFields) delete output[field];
  }
  return output;
}

export async function main(argv = process.argv.slice(2), io = console, dependencies = {}) {
  let command = null;
  try {
    const parsed = parseProjectsPrArgs(argv);
    if (parsed.help) { io.log(HELP); return 0; }
    command = parsed.command;
    const receipt = await runProjectsPr(command, parsed, dependencies);
    io.log(JSON.stringify(receipt, null, 2));
    return receipt.status === 'refused' ? 2 : 0;
  } catch (error) {
    const code = error instanceof ProjectsPrClientError ? error.code : 'runner_failed';
    io.error(JSON.stringify({ schemaVersion: 1, kind: 'projects-pr-local-runner', command,
      status: 'failed', error: { code }, recovery: { nextCommand: command === 'doctor' ? 'doctor' : 'status' } }, null, 2));
    return 1;
  }
}

let entry = false;
if (process.argv[1]) {
  try { entry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { /* Imported modules remain side-effect free. */ }
}
if (entry) process.exitCode = await main();
