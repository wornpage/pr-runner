// Local-only, single-dispatch operator. No candidate repository module is
// loaded here, and no Projects credential reaches an AWS subprocess.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProjectsTransport } from './transport.mjs';
import { awsClosedQualificationRequest, validateAwsDispatchPolicy,
  validateAwsDispatchPreflight } from './aws-qualification-contract.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const PACK = /^[A-Za-z0-9._:-]{1,120}$/u;
const PROFILE = /^[A-Za-z0-9_.-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const OUTPUT_LIMIT = 256 * 1024;
const PROCESS_LIMIT_MS = 30_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const refuse = code => { throw new AwsQualificationError(code); };

export class AwsQualificationError extends Error {
  constructor(code) { super(`AWS qualification: ${code}`); this.name = 'AwsQualificationError'; this.code = code; }
}

export function canonicalAwsJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAwsJson).join(',')}]`;
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAwsJson(value[key])}`).join(',')}}`;
  }
  refuse('invalid_json');
}

export function qualificationFingerprint(command, args) {
  return createHash('sha256').update(canonicalAwsJson({ command, args }), 'utf8').digest('hex');
}

export function awsSubprocessEnvironment(env = process.env) {
  const safe = {};
  // The installed AWS CLI may use the operator's standard SSO profile cache.
  // Deliberately do not pass Projects, GitHub, Cloudflare or raw AWS keys.
  for (const key of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP']) {
    if (typeof env[key] === 'string') safe[key] = env[key];
  }
  Object.assign(safe, {
    AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off',
    PYTHONNOUSERSITE: '1'
  });
  return safe;
}

export function createAwsCliRunner({ executablePath, spawnProcess = spawn, env = process.env,
  resolveExecutable = realpathSync, inspectExecutable = statSync,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
    || executablePath.includes('\0') || path.basename(executablePath).toLowerCase() !==
      (process.platform === 'win32' ? 'aws.exe' : 'aws')) refuse('aws_executable_invalid');
  let executable;
  try {
    executable = resolveExecutable(executablePath);
    if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !==
        (process.platform === 'win32' ? 'aws.exe' : 'aws') || !inspectExecutable(executable).isFile()) {
      refuse('aws_executable_invalid');
    }
  } catch { refuse('aws_executable_invalid'); }
  return async ({ profile, region, service, action, args = [] }) => {
    if (!matches(PROFILE, profile) || !matches(/^[a-z]{2}(?:-[a-z]+){1,3}-[0-9]$/u, region)
      || !['sts', 'codebuild', 's3api'].includes(service)
      || !matches(/^[a-z][a-z-]{1,60}$/u, action)
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) refuse('invalid_aws_invocation');
    const endpoint = `https://${service === 's3api' ? 's3' : service}.${region}.amazonaws.com`;
    const argv = ['--profile', profile, '--region', region, '--endpoint-url', endpoint,
      service, action, ...args, '--output', 'json', '--no-cli-pager'];
    return new Promise((resolve, reject) => {
      let child, timer, finished = false, size = 0, stdout = '', stderrSize = 0;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimer(timer);
        if (error) { try { child?.kill('SIGKILL'); } catch { /* Uncertain remains consumed after reserve. */ } reject(error); }
        else resolve(value);
      };
      try {
        child = spawnProcess(executable, argv, { cwd: tmpdir(), shell: false, windowsHide: true,
          env: awsSubprocessEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { finish(new AwsQualificationError('aws_spawn_failed')); return; }
      timer = setTimer(() => finish(new AwsQualificationError('aws_timeout')), PROCESS_LIMIT_MS);
      child.stdout?.on('data', chunk => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) finish(new AwsQualificationError('aws_output_too_large'));
        else stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', chunk => {
        stderrSize += chunk.length;
        if (stderrSize > OUTPUT_LIMIT) finish(new AwsQualificationError('aws_output_too_large'));
      });
      child.on('error', () => finish(new AwsQualificationError('aws_spawn_failed')));
      child.on('close', code => {
        if (code !== 0) { finish(new AwsQualificationError('aws_command_failed')); return; }
        try { finish(null, JSON.parse(stdout)); } catch { finish(new AwsQualificationError('aws_response_invalid')); }
      });
    });
  };
}

export async function readLocalDispatchPolicy(path, read = readFile) {
  if (typeof path !== 'string' || !path || path.includes('\0')) refuse('policy_path_invalid');
  const bytes = await read(path);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16384) refuse('policy_file_invalid');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { refuse('policy_file_invalid'); }
  return validateAwsDispatchPolicy(parsed);
}

function validateOptions(command, options) {
  const startFields = ['packId', 'policyPath', 'policySha256', 'profile', 'awsCliPath', 'expectedVersion'];
  const statusFields = ['packId', 'approvalId'];
  if (command === 'start' && exact(options, startFields)
    && matches(PACK, options.packId) && matches(HASH, options.policySha256)
    && matches(PROFILE, options.profile) && typeof options.awsCliPath === 'string'
    && path.isAbsolute(options.awsCliPath) && Number.isSafeInteger(options.expectedVersion)
    && options.expectedVersion >= 0) return;
  if (command === 'status' && exact(options, statusFields)
    && matches(PACK, options.packId) && matches(UUID, options.approvalId)) return;
  refuse('invalid_input');
}

function envelope(operation, packId, request) {
  return { schemaVersion: 1, operationId: randomUUID(), operation, packId, request };
}

function validateReservation(response, policy, policySha256, expectedVersion) {
  if (!exact(response, ['schemaVersion', 'kind', 'approvalId', 'packId', 'reservationId',
    'workspaceVersion', 'policySha256', 'requestSha256', 'startRequest'])
    || response.schemaVersion !== 1 || response.kind !== 'aws-qualification-reservation'
    || response.approvalId !== policy.approvalId || response.packId !== policy.packId
    || !matches(UUID, response.reservationId) || response.workspaceVersion !== expectedVersion + 1
    || response.policySha256 !== policySha256 || !matches(HASH, response.requestSha256)
    || !object(response.startRequest) || !matches(HASH, response.startRequest.idempotencyToken)
    || response.requestSha256 !== qualificationFingerprint('aws-qualification-start-build', response.startRequest)
    || canonicalAwsJson(response.startRequest) !== canonicalAwsJson(
      awsClosedQualificationRequest(policy, response.startRequest.idempotencyToken))) refuse('reservation_response_invalid');
  return response;
}

function reportedBuild(policy, result) {
  const build = result?.build;
  const id = build?.id;
  if (typeof id !== 'string' || !id.startsWith(`${policy.projectName}:`)
    || !matches(UUID, id.slice(policy.projectName.length + 1))
    || build.arn !== `arn:aws:codebuild:${policy.region}:${policy.accountId}:build/${id}`
    || build.initiator !== policy.dispatchInitiator) refuse('aws_build_identity_invalid');
  return { kind: 'operator-reported-build', buildId: id, buildArn: build.arn, initiator: build.initiator };
}

function resultStatus(status, { packId, approvalId, reservationId } ) {
  const base = ['schemaVersion', 'kind', 'approvalId', 'packId', 'state', 'reservationId', 'workspaceVersion'];
  if (!(exact(status, base) || exact(status, [...base, 'buildId', 'buildArn']))
    || status.schemaVersion !== 1 || status.kind !== 'aws-qualification-status'
    || status.packId !== packId || status.approvalId !== approvalId
    || !matches(UUID, status.reservationId)
    || reservationId !== undefined && status.reservationId !== reservationId
    || !Number.isSafeInteger(status.workspaceVersion) || status.workspaceVersion < 1
    || !['consumed-uncertain', 'uncertain', 'reported'].includes(status.state)
    || (status.state === 'reported') !== (typeof status.buildId === 'string' && typeof status.buildArn === 'string')) {
    refuse('status_response_invalid');
  }
  return status;
}

export async function runAwsQualification(command, options, {
  transport = createProjectsTransport(), runAws, readPolicy = readLocalDispatchPolicy,
  now = Date.now
} = {}) {
  validateOptions(command, options);
  if (command === 'status') return resultStatus(await transport(envelope('aws_qualification_status',
    options.packId, { approvalId: options.approvalId })), options);
  const policy = await readPolicy(options.policyPath);
  const provider = runAws ?? createAwsCliRunner({ executablePath: options.awsCliPath });
  const policySha256 = qualificationFingerprint('aws-dispatch-policy', policy);
  if (policy.packId !== options.packId || policySha256 !== options.policySha256
    || now() >= Date.parse(policy.approvalExpiresAt)) refuse('local_policy_mismatch');
  const invoke = (service, action, args) => provider({ profile: options.profile, region: policy.region, service, action, args });
  const preflightStartedAt = now();
  const caller = await invoke('sts', 'get-caller-identity', []);
  const projectResult = await invoke('codebuild', 'batch-get-projects', ['--names', policy.projectName]);
  if (!Array.isArray(projectResult?.projects) || projectResult.projects.length !== 1
    || !Array.isArray(projectResult.projectsNotFound) || projectResult.projectsNotFound.length !== 0) refuse('project_preflight_invalid');
  const bucketArgs = ['--bucket', policy.artifactBucket, '--expected-bucket-owner', policy.accountId];
  const lockConfiguration = await invoke('s3api', 'get-object-lock-configuration', bucketArgs);
  const versioning = await invoke('s3api', 'get-bucket-versioning', bucketArgs);
  const preflight = { caller, project: projectResult.projects[0], lockConfiguration, versioning,
    observedAt: new Date(preflightStartedAt).toISOString() };
  validateAwsDispatchPreflight(policy, preflight, now());
  // No retry: response loss may mean the reservation committed. A new client
  // operation ID cannot issue another StartBuild capability for this pack.
  const response = await transport(envelope('aws_qualification_reserve', options.packId,
    { policySha256, expectedVersion: options.expectedVersion, preflight }));
  if (response?.kind === 'aws-qualification-status') return resultStatus(response, policy);
  const reservation = validateReservation(response, policy, policySha256, options.expectedVersion);
  let observation;
  if (now() >= Date.parse(policy.approvalExpiresAt)) {
    observation = { kind: 'uncertain', reasonCode: 'approval_expired_before_dispatch' };
  } else if (now() - Date.parse(preflight.observedAt) > 15000) {
    observation = { kind: 'uncertain', reasonCode: 'preflight_stale_before_dispatch' };
  } else {
    try {
      const started = await invoke('codebuild', 'start-build',
        ['--cli-input-json', JSON.stringify(reservation.startRequest)]);
      observation = reportedBuild(policy, started);
    } catch {
      observation = { kind: 'uncertain', reasonCode: 'start_build_ambiguous' };
    }
  }
  try {
    return resultStatus(await transport(envelope('aws_qualification_report', options.packId,
      { approvalId: policy.approvalId, reservationId: reservation.reservationId,
        expectedVersion: reservation.workspaceVersion, observation })),
    { ...policy, reservationId: reservation.reservationId });
  } catch {
    return { schemaVersion: 1, kind: 'aws-qualification-local-uncertain', approvalId: policy.approvalId,
      packId: policy.packId, state: 'consumed-uncertain', reasonCode: 'report_response_unavailable',
      ...(observation.kind === 'operator-reported-build' ? { unconfirmedObservation: observation } : {}) };
  }
}
