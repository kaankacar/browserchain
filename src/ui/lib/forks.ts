// Which fork, if any, the UI should point out. A node in manual quorum mode
// only reports a fork ('alert-only') and keeps its own chain until the user
// acts. It checks the fork again only when it can compare the two chains,
// never while the peer is ahead, so one report can stand for a long fork.
// In auto mode a node keeps its chain when only validators it did not know
// before the fork are on the other branch, and reports that fork again while
// it lasts: only a resync moves the node to their chain.

import type { ForkInfo, LedgerSummary, ValidatorView } from '../../node/api';

/** A new 'alert-only' report shows for this long in any case. */
export const FORK_ALERT_MS = 30_000;
/** A rollback is news for a minute. */
export const ROLLBACK_NOTICE_MS = 60_000;
/**
 * While a fork with unknown validators lasts, the node reports it again at
 * most every 10 s (a check can also be skipped or late). The fork is current
 * while its newest report is this recent.
 */
export const STRANGER_FORK_FRESH_MS = 40_000;

/**
 * Auto mode kept our chain only because the validators on the other branch
 * were unknown to this node before the fork point.
 */
export function isStrangerFork(f: ForkInfo): boolean {
  return f.resolution === 'kept-ours' && (f.unknownValidators ?? 0) > 0;
}

export interface ForkNotice {
  kind: 'alert' | 'rolled-back';
  fork: ForkInfo;
}

/** What this node knows now: its validator directory and whether it is in sync. */
export interface ForkContext {
  validators: ValidatorView[];
  synced: boolean;
}

/**
 * The fork to show: the newest report, while this node still has its side
 * of the fork (a resync replaces the chain) and the report is recent or the
 * node still keeps the peer out (a synced, connected peer it does not count
 * as active, as it does with a forked one). Reports of a fork with unknown
 * validators have their own alert (strangerFork) and are skipped, unless one
 * is about the same peer: then it replaces the older report. `forks` and
 * `ledgers` are newest first.
 */
export function forkNotice(
  forks: ForkInfo[],
  ledgers: LedgerSummary[],
  now: number,
  live: ForkContext = { validators: [], synced: false },
): ForkNotice | null {
  const i = forks.findIndex((x) => !isStrangerFork(x));
  const f = forks[i];
  if (!f || forks.slice(0, i).some((x) => x.peer === f.peer)) return null;
  const age = now - f.ts;
  if (f.resolution === 'alert-only') {
    const ours = ledgers.find((l) => l.seq === f.atSeq);
    // our ledger at the fork height changed: the fork is gone
    if (ours && ours.hash !== f.ourHash) return null;
    if (age <= FORK_ALERT_MS) return { kind: 'alert', fork: f };
    const peer = live.validators.find((v) => v.nodeId === f.peer);
    if (live.synced && peer && peer.connected && peer.synced && !peer.active) return { kind: 'alert', fork: f };
    return null;
  }
  if (f.resolution === 'rolled-back' && age <= ROLLBACK_NOTICE_MS) return { kind: 'rolled-back', fork: f };
  return null;
}

/** What the UI knows about this node when it judges a fork with unknown validators. */
export interface StrangerContext {
  /** In sync (synced or stalled, not blocked): the node follows its own chain. */
  inSync: boolean;
  /** UI time of the latest resync that this UI started, or null. */
  resyncAt: number | null;
}

/**
 * The fork with validators this node did not know before, while it lasts:
 * the newest such report, while reports keep coming, while this node is in
 * sync and still has its side of the fork. Reports from before a resync this
 * UI started are about the wiped chain. An empty ourHash means that the node
 * had not closed that ledger yet when it reported (strangers it cannot check
 * against its chain). `forks` and `ledgers` are newest first.
 */
export function strangerFork(forks: ForkInfo[], ledgers: LedgerSummary[], now: number, ctx: StrangerContext): ForkInfo | null {
  if (!ctx.inSync) return null;
  const f = forks.find(isStrangerFork);
  if (!f || now - f.ts > STRANGER_FORK_FRESH_MS) return null;
  if (ctx.resyncAt !== null && f.ts < ctx.resyncAt) return null;
  const ours = ledgers.find((l) => l.seq === f.atSeq);
  if (ours && f.ourHash && ours.hash !== f.ourHash) return null;
  return f;
}
