export const ACTION_AUTHORITY = Object.freeze({
  doctor: Object.freeze(['observe_host', 'observe_repository']),
  prepare: Object.freeze(['observe_host', 'observe_repository', 'create_worktree']),
  publish: Object.freeze([
    'observe_candidate', 'observe_repository', 'push_branch',
    'create_pull_request', 'observe_pull_request'
  ]),
  finalize: Object.freeze(['observe_pull_request', 'remove_worktree', 'observe_repository']),
  status: Object.freeze(['observe_repository', 'observe_pull_request']),
  abort: Object.freeze(['observe_repository', 'remove_worktree', 'remove_local_branch']),
  stack: Object.freeze(['observe_host', 'link_stack', 'observe_stack'])
});

export const MUTATING_ACTIONS = Object.freeze([
  'create_worktree', 'push_branch', 'create_pull_request',
  'remove_worktree', 'remove_local_branch', 'link_stack'
]);

export class ActionAuthorityError extends Error {
  constructor() {
    super('The local CLI operation does not authorize this host action.');
    this.name = 'ActionAuthorityError';
    this.code = 'action_not_authorized';
  }
}

export function isActionAuthorized(operation, actionKind) {
  return typeof operation === 'string' && typeof actionKind === 'string'
    && Object.hasOwn(ACTION_AUTHORITY, operation)
    && ACTION_AUTHORITY[operation].includes(actionKind);
}

export function assertActionAuthority(operation, actionKind) {
  if (!isActionAuthorized(operation, actionKind)) throw new ActionAuthorityError();
}
