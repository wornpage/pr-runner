// Owner-approved, deployment-owned inputs for the first CodeBuild trust root.
// A proposed artifact pin cannot choose its own controller or paid host.
export const AWS_QUALIFICATION_SOURCE = Object.freeze({
  commit: '0266ffa7077a446c2f9133a79c331651edc7f3cc',
  tree: '4f13f7b4b847d2795fde56d64c6543d3d60eb19b',
  verificationCommand: 'node scripts/ship-check.mjs'
});
const COMMIT = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CONNECTION_ARN = /^arn:aws:codeconnections:([a-z0-9-]+):([0-9]{12}):connection\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const BASE_FIELDS = ['revision', 'accountId', 'region', 'repository', 'repositoryId', 'sourceConnectionArn', 'projectName',
  'controllerSha', 'frozenSourceCommit', 'frozenSourceTree', 'hostImage', 'computeType',
  'serviceRoleArn', 'dispatchInitiator', 'artifactBucket', 'artifactPrefix',
  'minRetentionSeconds', 'maxAgeSeconds', 'verificationCommand'];

export function matchesAwsCodeConnectionArn(value, region, accountId) {
  const match = typeof value === 'string' ? CONNECTION_ARN.exec(value) : null;
  return match !== null && match[0] === value && match[1] === region && match[2] === accountId;
}

export function validateAwsQualificationPolicy(value) {
  if (!exact(value, BASE_FIELDS) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !matches(/^[0-9]{12}$/u, value.accountId)
    || !matches(/^[a-z]{2}(?:-[a-z]+){1,3}-[0-9]$/u, value.region)
    || !matches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, value.repository)
    || !Number.isSafeInteger(value.repositoryId) || value.repositoryId < 1
    || !matchesAwsCodeConnectionArn(value.sourceConnectionArn, value.region, value.accountId)
    || !matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,149}$/u, value.projectName)
    || !matches(COMMIT, value.controllerSha) || !matches(COMMIT, value.frozenSourceCommit)
    || !matches(COMMIT, value.frozenSourceTree)
    || value.frozenSourceCommit !== AWS_QUALIFICATION_SOURCE.commit
    || value.frozenSourceTree !== AWS_QUALIFICATION_SOURCE.tree
    || typeof value.hostImage !== 'string'
    || !value.hostImage.startsWith(`${value.accountId}.dkr.ecr.${value.region}.amazonaws.com/`)
    || !matches(/@sha256:[a-f0-9]{64}$/u, value.hostImage)
    || !matches(/^BUILD_GENERAL1_[A-Z0-9_]+$/u, value.computeType)
    || value.serviceRoleArn !== `arn:aws:iam::${value.accountId}:role/projects-readiness-runner`
    || typeof value.dispatchInitiator !== 'string' || value.dispatchInitiator.length < 1
    || value.dispatchInitiator.length > 200
    || !matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u, value.artifactBucket)
    || !matches(/^projects-readiness\/[a-z0-9-]{1,48}\/qualification$/u, value.artifactPrefix)
    || !Number.isSafeInteger(value.minRetentionSeconds) || value.minRetentionSeconds < 86400
    || value.minRetentionSeconds > 31536000
    || !Number.isSafeInteger(value.maxAgeSeconds) || value.maxAgeSeconds < 60
    || value.maxAgeSeconds > 86400
    || value.verificationCommand !== AWS_QUALIFICATION_SOURCE.verificationCommand) {
    throw new Error('AWS qualification policy is incomplete or outside the owner-approved trust and cost boundary.');
  }
  return structuredClone(value);
}

const basePolicy = value => Object.fromEntries(BASE_FIELDS.map(field => [field, value[field]]));
const qualifiedPolicy = value => exact(value, BASE_FIELDS)
  ? validateAwsQualificationPolicy(value)
  : basePolicy(validateAwsDispatchPolicy(value));

// Both the current project and the completed build must prove source-level auth.
// Never infer it from the repository URL, service role, or account default.
export function matchesAwsQualificationSource(policy, source) {
  return source?.type === 'GITHUB' && source.location === `https://github.com/${policy.repository}.git`
    && exact(source.auth, ['type', 'resource']) && source.auth.type === 'CODECONNECTIONS'
    && source.auth.resource === policy.sourceConnectionArn
    && source.insecureSsl !== true && [undefined, 0].includes(source.gitCloneDepth)
    && source.gitSubmodulesConfig?.fetchSubmodules !== true;
}

export function validateAwsQualificationProject(policyInput, project) {
  const policy = qualifiedPolicy(policyInput);
  const projectArn = `arn:aws:codebuild:${policy.region}:${policy.accountId}:project/${policy.projectName}`;
  if (!object(project) || project.name !== policy.projectName || project.arn !== projectArn
    || project.projectVisibility !== 'PRIVATE' || project.webhook || project.serviceRole !== policy.serviceRoleArn
    || (project.autoRetryLimit !== undefined && project.autoRetryLimit !== 0)
    || project.concurrentBuildLimit !== 1 || project.buildBatchConfig !== undefined
    || !Number.isSafeInteger(project.timeoutInMinutes) || project.timeoutInMinutes < 5
    || project.timeoutInMinutes > 120
    || !matchesAwsQualificationSource(policy, project.source)
    || project.source.buildspec !== 'ci/aws-readiness/qualification-buildspec.yml'
    || !Array.isArray(project.secondarySources) || project.secondarySources.length !== 1
    || !matchesAwsQualificationSource(policy, project.secondarySources[0])
    || project.secondarySources[0].sourceIdentifier !== 'CANDIDATE'
    || project.environment?.type !== 'LINUX_CONTAINER' || project.environment.privilegedMode !== true
    || project.environment.image !== policy.hostImage || project.environment.computeType !== policy.computeType
    || project.environment.imagePullCredentialsType !== 'SERVICE_ROLE'
    || project.environment.fleet !== undefined || project.environment.dockerServer !== undefined
    || project.environment.computeConfiguration !== undefined
    || project.environment.registryCredential
    || !Array.isArray(project.environment.environmentVariables)
    || project.environment.environmentVariables.length !== 0
    || (project.fileSystemLocations && project.fileSystemLocations.length !== 0)
    || (project.cache && project.cache.type !== 'NO_CACHE') || project.vpcConfig?.vpcId
    || project.artifacts?.type !== 'S3' || project.artifacts.location !== policy.artifactBucket
    || project.artifacts.path !== policy.artifactPrefix || project.artifacts.namespaceType !== 'BUILD_ID'
    || project.artifacts.name !== 'qualification.zip' || project.artifacts.packaging !== 'ZIP'
    || project.artifacts.overrideArtifactName === true || project.artifacts.encryptionDisabled === true
    || (project.secondaryArtifacts && project.secondaryArtifacts.length !== 0)) {
    throw new Error('AWS qualification project changed source, trust, execution, cost, or retention destination.');
  }
  return { projectArn, accountId: policy.accountId, region: policy.region,
    artifactBucket: policy.artifactBucket, policyRevision: policy.revision };
}

export function validateAwsQualificationBucket(policyInput, lockConfiguration, versioning) {
  const policy = qualifiedPolicy(policyInput);
  const lock = lockConfiguration?.ObjectLockConfiguration;
  const retention = lock?.Rule?.DefaultRetention;
  if (lock?.ObjectLockEnabled !== 'Enabled' || retention?.Mode !== 'COMPLIANCE'
    || !Number.isSafeInteger(retention.Days) || retention.Days < 1
    || retention.Years !== undefined
    || retention.Days * 86400 < policy.minRetentionSeconds + policy.maxAgeSeconds
    || versioning?.Status !== 'Enabled') {
    throw new Error('AWS qualification bucket lacks versioning or sufficient default compliance retention.');
  }
  return { bucket: policy.artifactBucket, accountId: policy.accountId,
    defaultRetentionDays: retention.Days, policyRevision: policy.revision };
}

export function awsStartQualificationRequest(policyInput, operationToken, { project, lockConfiguration, versioning } = {}) {
  const policy = qualifiedPolicy(policyInput);
  validateAwsQualificationProject(policy, project);
  validateAwsQualificationBucket(policy, lockConfiguration, versioning);
  return awsClosedQualificationRequest(policyInput, operationToken);
}

export function awsClosedQualificationRequest(policyInput, operationToken) {
  const policy = qualifiedPolicy(policyInput);
  if (!matches(HASH, operationToken)) {
    throw new Error('AWS qualification requires one journaled 64-hex operation token.');
  }
  return { projectName: policy.projectName, sourceVersion: policy.controllerSha,
    autoRetryLimitOverride: 0,
    ...(!exact(policyInput, BASE_FIELDS) ? { timeoutInMinutesOverride: policyInput.timeoutInMinutes } : {}),
    secondarySourcesVersionOverride: [{ sourceIdentifier: 'CANDIDATE', sourceVersion: policy.frozenSourceCommit }],
    environmentVariablesOverride: [{ name: 'PROJECTS_RUN_MODE', type: 'PLAINTEXT', value: 'qualification' }],
    idempotencyToken: operationToken };
}

const SHA256 = /^[a-f0-9]{64}$/u;
const ISO = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const ARN = /^arn:aws:(?:iam|sts)::([0-9]{12}):(?:user|role|assumed-role)\/[A-Za-z0-9+=,.@_\/-]+$/u;

// Deployment-owned opt-in. The local profile is deliberately absent: only the
// operator selects it, and the live STS principal must equal dispatcherArn.
export function validateAwsDispatchPolicy(value) {
  const fields = [...BASE_FIELDS, 'workspaceId', 'workspaceVersion', 'privateHeadSha256', 'generation', 'objectId', 'principalId', 'packId', 'attempt',
    'assignmentRevision', 'handoffSha256', 'approvalId', 'approvalExpiresAt', 'dispatcherArn',
    'timeoutInMinutes', 'recoveryAnchor'];
  if (!exact(value, fields)) throw new Error('AWS dispatch policy has missing or unknown fields.');
  const base = basePolicy(value);
  validateAwsQualificationPolicy(base);
  const dispatcher = typeof value.dispatcherArn === 'string' ? ARN.exec(value.dispatcherArn) : null;
  if (!matches(/^[A-Za-z0-9._:-]{1,120}$/u, value.workspaceId)
    || !Number.isSafeInteger(value.workspaceVersion) || value.workspaceVersion < 1
    || !matches(SHA256, value.privateHeadSha256)
    || !ISO(value.generation) || !matches(SHA256, value.objectId)
    || !matches(/^[A-Za-z0-9._:@-]{1,160}$/u, value.principalId)
    || !matches(/^[A-Za-z0-9._:-]{1,120}$/u, value.packId)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 100
    || !Number.isSafeInteger(value.assignmentRevision) || value.assignmentRevision < 1 || value.assignmentRevision > 100
    || !matches(SHA256, value.handoffSha256) || !matches(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u, value.approvalId)
    || !ISO(value.approvalExpiresAt) || Date.parse(value.approvalExpiresAt) <= Date.parse(value.generation)
    || !dispatcher || dispatcher[0] !== value.dispatcherArn || dispatcher[1] !== value.accountId
    || !Number.isSafeInteger(value.timeoutInMinutes) || value.timeoutInMinutes < 5 || value.timeoutInMinutes > 120
    || !exact(value.recoveryAnchor, ['count', 'sha256'])
    || !Number.isSafeInteger(value.recoveryAnchor.count) || value.recoveryAnchor.count < 0
    || (value.recoveryAnchor.count === 0 ? value.recoveryAnchor.sha256 !== null : !matches(SHA256, value.recoveryAnchor.sha256))) {
    throw new Error('AWS dispatch policy is outside its owner, recovery, identity or cost boundary.');
  }
  return structuredClone(value);
}

export function validateAwsDispatchPreflight(policyInput, { caller, project, lockConfiguration, versioning, observedAt },
  now = Date.now()) {
  const policy = validateAwsDispatchPolicy(policyInput);
  if (!exact(caller, ['Account', 'Arn', 'UserId']) || caller.Account !== policy.accountId
    || caller.Arn !== policy.dispatcherArn || typeof caller.UserId !== 'string' || !caller.UserId
    || !ISO(observedAt) || !Number.isSafeInteger(now) || Date.parse(observedAt) > now
    || now - Date.parse(observedAt) > 15000 || now >= Date.parse(policy.approvalExpiresAt)) {
    throw new Error('AWS dispatch preflight principal, freshness or approval changed.');
  }
  validateAwsQualificationProject(policy, project);
  validateAwsQualificationBucket(policy, lockConfiguration, versioning);
  if (project.timeoutInMinutes !== policy.timeoutInMinutes) {
    throw new Error('AWS dispatch project exceeded the approved build time.');
  }
  return { accountId: policy.accountId, dispatcherArn: policy.dispatcherArn,
    projectArn: project.arn, observedAt };
}
