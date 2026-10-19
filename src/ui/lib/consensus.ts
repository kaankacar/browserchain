// Wording for the state of the slot being decided (consensus card, slot
// inspector). SCP's nomination round is 0 until this node starts
// nominating, so "round 0" is never shown: it reads like a real round.

import type { ScpSlotView, SyncState } from '../../node/api';
import { formatBallotCounter } from './format';

/** No validator has sent a statement for the slot yet: the ledger trigger has not fired. */
export function slotIdle(slot: ScpSlotView | null): boolean {
  return !slot || (slot.nomination.round === 0 && slot.nodes.every((n) => n.statement === 'none'));
}

/** This node's nomination, in words: "round 2", or why there is no round. */
export function nominationLabel(slot: ScpSlotView, isValidator: boolean): string {
  if (slot.nomination.round > 0) return `round ${slot.nomination.round}`;
  if (!isValidator) return 'watching, not voting';
  if (slot.externalized) return 'did not nominate';
  return 'not nominating yet';
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** One line on where the slot stands, for the consensus card subtitle. */
export function slotProgress(slot: ScpSlotView | null, node: { state: SyncState; isValidator: boolean }): string {
  if (!slot) return node.state === 'synced' || node.state === 'stalled' ? 'Waiting for the first nomination' : 'Joins after the node is in sync';
  if (slotIdle(slot)) return 'Waiting for the next ledger trigger';
  const parts: string[] = [];
  if (slot.nomination.round > 0 || !node.isValidator) parts.push(nominationLabel(slot, node.isValidator));
  else if (!slot.ballot) parts.push('waiting for this node to nominate');
  if (slot.ballot) parts.push(`ballot ${formatBallotCounter(slot.ballot.counter)}`);
  return capitalize(parts.join(' · '));
}
