// This node's state in UI terms. A node whose peers are ahead, but that
// cannot catch up from them safely (for example they are all validators it
// did not know before), does not vote: voting alone would build a branch of
// its own. The node reports it in status.catchup.blocked; the UI shows it as
// its own state, never as 'synced'.

import type { NodeStatus, SyncState } from '../../node/api';

export type SelfState = SyncState | 'blocked';

/** Why the node cannot catch up from the peers ahead, or null when it is not blocked. */
export function blockedReason(status: NodeStatus | null): string | null {
  const reason = status?.catchup?.blocked;
  return typeof reason === 'string' ? reason : null;
}

/** The state to show for this node. A stopped or (re)starting node is not waiting for a catch-up. */
export function selfState(status: NodeStatus | null): SelfState {
  if (!status) return 'booting';
  if (status.state === 'stopped' || status.state === 'booting') return status.state;
  return blockedReason(status) !== null ? 'blocked' : status.state;
}

/** Synced or stalled, and not blocked: the node follows its own chain and votes. */
export function inSync(state: SelfState): boolean {
  return state === 'synced' || state === 'stalled';
}
