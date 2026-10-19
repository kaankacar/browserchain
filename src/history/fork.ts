// Fork detection and resolution helpers (ARCHITECTURE 12.3).
//
// A fork exists when a peer's header at some seq differs from ours. The fork
// point (last common seq) is found with `headers` requests, walking back in
// batches of 64 from the lower LCL. In auto mode the branch that more
// validators vouch for wins. Only validators that this node saw as active
// members at or before the fork point count. Equal counts fall back to the
// branch weights (sum of externalizedBy after the fork point), then to the
// lower hash of the first ledger after the fork point.

import { hashLedgerHeader } from '../ledger/header';
import type { LclRef } from '../overlay/types';
import { CatchupError, type CatchupHost } from './catchup';
import { decodeLedgerHeader } from '../ledger/header';
import { MAX_LEDGERS_PER_REQUEST } from './server';

export interface BranchInfo {
  weight: number;
  lcl: LclRef;
  /** Hash of the branch's first ledger after the fork point ('' when unknown). */
  first: string;
}

export type ForkVerdict = 'ours' | 'theirs';

/** Weights closer than this (absolute or relative) count as a tie. */
export const WEIGHT_TOLERANCE_ABS = 2;
export const WEIGHT_TOLERANCE_REL = 0.15;

/**
 * Which branch wins (auto mode). The higher weight wins. Weights are local
 * counts (each node saw a slightly different number of externalizing
 * validators), so close weights are a tie, broken by the lower hash of the
 * first ledger after the fork point: every node of a branch has the same one,
 * so all nodes reach the same verdict. Unknown first hashes fall back to
 * the higher LCL seq, then the lower LCL hash.
 */
export function decideFork(ours: BranchInfo, theirs: BranchInfo): ForkVerdict {
  const tolerance = Math.max(WEIGHT_TOLERANCE_ABS, Math.ceil(WEIGHT_TOLERANCE_REL * Math.max(ours.weight, theirs.weight)));
  if (Math.abs(ours.weight - theirs.weight) > tolerance) return ours.weight > theirs.weight ? 'ours' : 'theirs';
  if (ours.first && theirs.first && ours.first !== theirs.first) return ours.first < theirs.first ? 'ours' : 'theirs';
  if (ours.lcl.seq !== theirs.lcl.seq) return ours.lcl.seq > theirs.lcl.seq ? 'ours' : 'theirs';
  return ours.lcl.hash <= theirs.lcl.hash ? 'ours' : 'theirs';
}

/**
 * Distinct validators that vouch for each branch: a signed status whose LCL
 * is on that branch, from a validator this node saw as an active member at
 * or before the fork point. `ours` includes this node.
 */
export interface Vouchers {
  ours: number;
  theirs: number;
}

/**
 * The auto-mode verdict. The branch with strictly more vouchers wins; the
 * weights in `ours` and `theirs` (self-reported) only break a tie in the
 * counts, through decideFork. `vouchers` is null for a node that never saw
 * another validator as an active member: it has no quorum history to
 * protect, so decideFork alone decides (two solo nodes that meet still end
 * on one chain).
 */
export function decideForkByVouchers(vouchers: Vouchers | null, ours: BranchInfo, theirs: BranchInfo): ForkVerdict {
  if (vouchers && vouchers.ours !== vouchers.theirs) return vouchers.theirs > vouchers.ours ? 'theirs' : 'ours';
  return decideFork(ours, theirs);
}

export interface ForkPoint {
  /** Last seq where both chains agree. */
  forkPoint: number;
  /** Our and their hash at forkPoint + 1 (null when one side does not have it). */
  ourNext: string | null;
  theirNext: string | null;
}

/**
 * Walk back from `low` (the lower of the two LCLs) until a common ledger is
 * found. `ourHash(seq)` gives our hash (undefined when we do not have it).
 * Returns null when no common ledger is found within maxDepth ledgers or the
 * peer has no data.
 */
export async function findForkPoint(
  host: Pick<CatchupHost, 'request' | 'requestTimeoutMs' | 'aborted'>,
  peer: string,
  low: number,
  ourHash: (seq: number) => Promise<string | undefined>,
  maxDepth = 4096,
): Promise<ForkPoint | null> {
  let hi = low;
  let theirAbove: string | null = null;
  let ourAbove: string | null = null;
  const stop = Math.max(1, low - maxDepth);
  while (hi >= stop) {
    const lo = Math.max(stop, hi - MAX_LEDGERS_PER_REQUEST + 1);
    if (host.aborted?.()) throw new CatchupError('aborted', 'fork check aborted');
    let res;
    try {
      res = await host.request(peer, { kind: 'headers', from: lo, to: hi }, host.requestTimeoutMs);
    } catch (err) {
      throw new CatchupError('network', `headers request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.kind !== 'headers') throw new CatchupError('bad-source', 'expected a headers answer');
    const theirs = new Map<number, string>();
    for (const it of res.items) {
      if (it.seq < lo || it.seq > hi) continue;
      try {
        const h = decodeLedgerHeader(it.headerXdr);
        if (h.ledgerSeq === it.seq) theirs.set(it.seq, hashLedgerHeader(h));
      } catch {
        /* ignore malformed */
      }
    }
    if (theirs.size === 0) return null;
    for (let seq = hi; seq >= lo; seq--) {
      const t = theirs.get(seq);
      const o = await ourHash(seq);
      if (t !== undefined && o !== undefined && t === o) {
        return { forkPoint: seq, ourNext: ourAbove, theirNext: theirAbove };
      }
      theirAbove = t ?? null;
      ourAbove = o ?? null;
    }
    hi = lo - 1;
  }
  return null;
}
