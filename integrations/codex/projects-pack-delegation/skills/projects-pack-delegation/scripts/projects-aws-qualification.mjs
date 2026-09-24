#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AwsQualificationError, runAwsQualification } from './lib/aws-qualification-runner.mjs';

const HELP = `projects-aws-qualification (inactive source candidate)

Usage:
  projects-aws-qualification start --pack-id ID --policy PATH --policy-sha256 SHA256 --profile NAME --aws-cli ABSOLUTE_PATH --expected-version NUMBER
  projects-aws-qualification status --pack-id ID --approval-id UUID

The operator supplies an explicitly reviewed local policy and AWS SSO profile.
The deployed Projects policy must match its digest. StartBuild is never retried;
ambiguous results consume the approved attempt. Status does not dispatch.
`;
const FIELDS = Object.freeze({ '--pack-id': 'packId', '--policy': 'policyPath',
  '--policy-sha256': 'policySha256', '--profile': 'profile', '--aws-cli': 'awsCliPath',
  '--expected-version': 'expectedVersion',
  '--approval-id': 'approvalId' });

export function parseAwsQualificationArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') return { help: true };
  const command = argv[0], options = {};
  if (!['start', 'status'].includes(command)) throw new AwsQualificationError('invalid_input');
  for (let i = 1; i < argv.length; i += 2) {
    const field = FIELDS[argv[i]], value = argv[i + 1];
    if (!field || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(options, field)) {
      throw new AwsQualificationError('invalid_input');
    }
    options[field] = field === 'expectedVersion' && /^[0-9]+$/u.test(value) ? Number(value) : value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2), io = console, dependencies = {}) {
  let command = null;
  try {
    const parsed = parseAwsQualificationArgs(argv);
    if (parsed.help) { io.log(HELP); return 0; }
    command = parsed.command;
    const receipt = await runAwsQualification(command, parsed.options, dependencies);
    io.log(JSON.stringify(receipt, null, 2));
    return receipt.state === 'consumed-uncertain' || receipt.state === 'uncertain' ? 2 : 0;
  } catch (error) {
    io.error(JSON.stringify({ schemaVersion: 1, kind: 'aws-qualification-local-cli', command,
      status: 'failed', error: { code: error instanceof AwsQualificationError ? error.code : 'qualification_failed' },
      recovery: { nextCommand: 'status' } }, null, 2));
    return 1;
  }
}

let entry = false;
if (process.argv[1]) {
  try { entry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { /* Imported tests never execute a qualification. */ }
}
if (entry) process.exitCode = await main();
