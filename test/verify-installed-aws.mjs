import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const skill = 'integrations/codex/projects-pack-delegation/skills/projects-pack-delegation';
const approvalId = '11111111-2222-4333-8444-555555555555';
const reservationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const accountId = '123456789012';
const region = 'us-east-1';
const projectName = 'projects-qualification';
const packId = 'task-synthetic-aws';
const buildId = `${projectName}:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const now = Date.parse('2026-09-24T21:00:00.000Z');

async function installedModule(root, relative) {
  return import(pathToFileURL(path.join(root, skill, 'scripts', relative)).href);
}

// All modules under test are loaded from the clean-installed archive, never
// from this repository's source tree or the private Projects repository.
export async function verifyInstalledAws(root) {
  const contract = await installedModule(root, 'lib/aws-qualification-contract.mjs');
  const runner = await installedModule(root, 'lib/aws-qualification-runner.mjs');
  const cli = await installedModule(root, 'projects-aws-qualification.mjs');
  const bounded = await installedModule(root, 'lib/bounded-process.mjs');
  const policy = contract.validateAwsDispatchPolicy({
    revision: 1, accountId, region, repository: 'wornpage/projects-web-demo-prod',
    repositoryId: 1302225643,
    sourceConnectionArn: `arn:aws:codeconnections:${region}:${accountId}:connection/${approvalId}`,
    projectName, controllerSha: 'a'.repeat(40),
    frozenSourceCommit: contract.AWS_QUALIFICATION_SOURCE.commit,
    frozenSourceTree: contract.AWS_QUALIFICATION_SOURCE.tree,
    hostImage: `${accountId}.dkr.ecr.${region}.amazonaws.com/projects/runner@sha256:${'b'.repeat(64)}`,
    computeType: 'BUILD_GENERAL1_LARGE',
    serviceRoleArn: `arn:aws:iam::${accountId}:role/projects-readiness-runner`,
    dispatchInitiator: 'synthetic-owner', artifactBucket: 'workspace-readiness-evidence',
    artifactPrefix: 'projects-readiness/workspace-one/qualification',
    minRetentionSeconds: 86400, maxAgeSeconds: 3600,
    verificationCommand: contract.AWS_QUALIFICATION_SOURCE.verificationCommand,
    workspaceId: 'workspace-synthetic', workspaceVersion: 41,
    privateHeadSha256: 'c'.repeat(64), generation: '2026-09-24T18:00:00.000Z',
    objectId: 'd'.repeat(64), principalId: 'synthetic-owner', packId,
    attempt: 2, assignmentRevision: 2, handoffSha256: 'e'.repeat(64),
    approvalId, approvalExpiresAt: '2026-09-24T22:00:00.000Z',
    dispatcherArn: `arn:aws:iam::${accountId}:user/SyntheticOperator`,
    timeoutInMinutes: 120, recoveryAnchor: { count: 0, sha256: null }
  });
  const policySha256 = runner.qualificationFingerprint('aws-dispatch-policy', policy);
  const options = { packId, policyPath: 'synthetic-policy.json', policySha256,
    profile: 'SyntheticSSO',
    awsCliPath: path.join(root, process.platform === 'win32' ? 'aws.exe' : 'aws'),
    expectedVersion: 41 };
  const startRequest = contract.awsClosedQualificationRequest(policy, 'f'.repeat(64));
  const source = { type: 'GITHUB', location: `https://github.com/${policy.repository}.git`,
    auth: { type: 'CODECONNECTIONS', resource: policy.sourceConnectionArn } };
  const project = { name: projectName,
    arn: `arn:aws:codebuild:${region}:${accountId}:project/${projectName}`,
    projectVisibility: 'PRIVATE', serviceRole: policy.serviceRoleArn,
    concurrentBuildLimit: 1, timeoutInMinutes: 120, autoRetryLimit: 0,
    source: { ...source, buildspec: 'ci/aws-readiness/qualification-buildspec.yml' },
    secondarySources: [{ ...structuredClone(source), sourceIdentifier: 'CANDIDATE' }],
    environment: { type: 'LINUX_CONTAINER', privilegedMode: true, image: policy.hostImage,
      computeType: policy.computeType, imagePullCredentialsType: 'SERVICE_ROLE', environmentVariables: [] },
    artifacts: { type: 'S3', location: policy.artifactBucket, path: policy.artifactPrefix,
      namespaceType: 'BUILD_ID', name: 'qualification.zip', packaging: 'ZIP' } };
  const lock = { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled',
    Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 30 } } } };

  function harness({ startResult, reserveResult, lostReserve, lostReport, projectResult } = {}) {
    const awsCalls = [], transportCalls = [];
    const runAws = async call => {
      awsCalls.push(call);
      if (call.action === 'get-caller-identity') return {
        Account: accountId, Arn: policy.dispatcherArn, UserId: 'synthetic-id' };
      if (call.action === 'batch-get-projects') return {
        projects: [projectResult ?? project], projectsNotFound: [] };
      if (call.action === 'get-object-lock-configuration') return lock;
      if (call.action === 'get-bucket-versioning') return { Status: 'Enabled' };
      if (call.action === 'start-build') {
        if (startResult instanceof Error) throw startResult;
        return startResult ?? { build: { id: buildId,
          arn: `arn:aws:codebuild:${region}:${accountId}:build/${buildId}`,
          initiator: policy.dispatchInitiator } };
      }
      throw Error('unexpected provider command');
    };
    const transport = async input => {
      assert.ok(['aws_qualification_reserve', 'aws_qualification_report',
        'aws_qualification_status'].includes(input.operation));
      transportCalls.push(input);
      if (input.operation === 'aws_qualification_reserve') {
        if (lostReserve) throw Error('synthetic lost reservation');
        return reserveResult ?? { schemaVersion: 1, kind: 'aws-qualification-reservation',
          approvalId, packId, reservationId, workspaceVersion: 42, policySha256,
          requestSha256: runner.qualificationFingerprint('aws-qualification-start-build', startRequest),
          startRequest };
      }
      if (input.operation === 'aws_qualification_report') {
        if (lostReport) throw Error('synthetic lost report');
        return { schemaVersion: 1, kind: 'aws-qualification-status',
          approvalId, packId, reservationId, workspaceVersion: 43,
          state: input.request.observation.kind === 'uncertain' ? 'uncertain' : 'reported',
          ...(input.request.observation.kind === 'operator-reported-build'
            ? { buildId, buildArn: `arn:aws:codebuild:${region}:${accountId}:build/${buildId}` } : {}) };
      }
      return { schemaVersion: 1, kind: 'aws-qualification-status',
        approvalId, packId, reservationId, workspaceVersion: 42, state: 'consumed-uncertain' };
    };
    return { awsCalls, transportCalls, runAws, transport, readPolicy: async () => policy,
      now: () => now };
  }

  const good = harness();
  assert.equal((await runner.runAwsQualification('start', options, good)).state, 'reported');
  assert.deepEqual(good.awsCalls.map(call => call.action), ['get-caller-identity',
    'batch-get-projects', 'get-object-lock-configuration', 'get-bucket-versioning', 'start-build']);
  assert.equal(good.awsCalls[4].args[1], JSON.stringify(startRequest));
  assert.deepEqual(good.transportCalls.map(call => call.operation),
    ['aws_qualification_reserve', 'aws_qualification_report']);

  const lost = harness({ lostReserve: true });
  await assert.rejects(runner.runAwsQualification('start', options, lost), /lost reservation/u);
  assert.equal(lost.awsCalls.some(call => call.action === 'start-build'), false);
  const malformed = harness({ reserveResult: { schemaVersion: 1,
    kind: 'aws-qualification-reservation', approvalId, packId, reservationId,
    workspaceVersion: 42, policySha256,
    requestSha256: runner.qualificationFingerprint('aws-qualification-start-build', startRequest),
    startRequest, executable: 'server-chosen-command' } });
  await assert.rejects(runner.runAwsQualification('start', options, malformed), /reservation_response_invalid/u);
  assert.equal(malformed.awsCalls.some(call => call.action === 'start-build'), false);
  const replay = harness({ reserveResult: { schemaVersion: 1, kind: 'aws-qualification-status',
    approvalId, packId, reservationId, workspaceVersion: 42, state: 'consumed-uncertain' } });
  assert.equal((await runner.runAwsQualification('start', options, replay)).state, 'consumed-uncertain');
  assert.equal(replay.awsCalls.some(call => call.action === 'start-build'), false);
  const wrongSource = structuredClone(project);
  wrongSource.source.auth.resource = `arn:aws:codeconnections:${region}:${accountId}:connection/00000000-0000-0000-0000-000000000000`;
  const badPreflight = harness({ projectResult: wrongSource });
  await assert.rejects(runner.runAwsQualification('start', options, badPreflight));
  assert.equal(badPreflight.transportCalls.length, 0);
  assert.equal(badPreflight.awsCalls.some(call => call.action === 'start-build'), false);
  const ambiguous = harness({ startResult: Error('synthetic timeout') });
  assert.equal((await runner.runAwsQualification('start', options, ambiguous)).state, 'uncertain');
  assert.equal(ambiguous.awsCalls.filter(call => call.action === 'start-build').length, 1);
  assert.equal(ambiguous.transportCalls[1].request.observation.reasonCode, 'start_build_ambiguous');
  const missingReport = harness({ lostReport: true });
  assert.equal((await runner.runAwsQualification('start', options, missingReport)).state, 'consumed-uncertain');
  assert.equal(missingReport.awsCalls.filter(call => call.action === 'start-build').length, 1);
  const status = harness();
  assert.equal((await runner.runAwsQualification('status', { packId, approvalId }, status)).state,
    'consumed-uncertain');
  assert.equal(status.awsCalls.length, 0);

  const spawned = [];
  const spawnProcess = (executable, args, settings) => {
    spawned.push({ executable, args, settings });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.end('{}'); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  const ambient = { PATH: 'synthetic-path', USERPROFILE: 'C:/Synthetic',
    PROJECTS_MCP_TOKEN: 'private', GH_TOKEN: 'github', AWS_ACCESS_KEY_ID: 'raw-key',
    AWS_ENDPOINT_URL: 'http://invalid', AWS_CA_BUNDLE: 'invalid', NODE_OPTIONS: '--require invalid' };
  const run = runner.createAwsCliRunner({ executablePath: options.awsCliPath, spawnProcess,
    env: ambient, resolveExecutable: value => value, inspectExecutable: () => ({ isFile: () => true }) });
  await run({ profile: 'SyntheticSSO', region, service: 's3api', action: 'get-bucket-versioning',
    args: ['--bucket', policy.artifactBucket, '--expected-bucket-owner', accountId] });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].executable, options.awsCliPath);
  assert.deepEqual(spawned[0].args.slice(0, 6), ['--profile', 'SyntheticSSO', '--region', region,
    '--endpoint-url', `https://s3.${region}.amazonaws.com`]);
  assert.equal(spawned[0].settings.shell, false);
  assert.equal(spawned[0].settings.env.AWS_MAX_ATTEMPTS, '1');
  for (const key of ['PATH', 'PROJECTS_MCP_TOKEN', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID',
    'AWS_ENDPOINT_URL', 'AWS_CA_BUNDLE', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(spawned[0].settings.env, key), false, `${key} leaked to AWS child`);
  }
  for (const scope of ['none', 'github-api', 'github-git']) {
    const safe = bounded.safeSubprocessEnvironment({ ...ambient, AWS_PROFILE: 'SyntheticSSO',
      AWS_SECRET_ACCESS_KEY: 'synthetic-secret' }, scope,
    scope === 'github-git' ? 'https://github.com/wornpage/projects-web-demo-prod.git' : null);
    for (const key of Object.keys(safe)) assert.equal(key.toUpperCase().startsWith('AWS_'), false);
  }
  assert.equal(cli.parseAwsQualificationArgs(['status', '--pack-id', packId,
    '--approval-id', approvalId]).command, 'status');
  assert.throws(() => cli.parseAwsQualificationArgs(['report', '--pack-id', packId]), /invalid_input/u);
  assert.throws(() => cli.parseAwsQualificationArgs(['start', '--profile', 'one', '--profile', 'two']), /invalid_input/u);
  const startBuildCount = calls => calls.filter(call => call.action === 'start-build').length;
  return {
    installedStartBuildCalls: [good, ambiguous, missingReport].reduce(
      (total, item) => total + startBuildCount(item.awsCalls), 0),
    refusedBeforeStartBuild: [lost, malformed, replay, badPreflight].filter(
      item => startBuildCount(item.awsCalls) === 0).length,
    ambiguousStartBuildCalls: startBuildCount(ambiguous.awsCalls),
    statusAwsCalls: status.awsCalls.length,
    awsChildCredentialLeakage: false
  };
}
