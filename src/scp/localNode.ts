// Ported from stellar-core (Apache-2.0): src/scp/LocalNode.cpp (instance part;
// the static quorum functions live in ./quorum.ts).

import { checkQuorumSetSanity, cloneQSet, normalizeQSet } from './quorum';
import type { Hash, NodeId, QuorumSet } from './types';
import { hashQuorumSet } from './xdr';

// Our own recent quorum sets stay resolvable by hash (our older statements
// still reference them) even if the driver's cache does not have them.
const RECENT_QSETS = 8;

export class LocalNode {
  private qSet: QuorumSet;
  private qSetHash: Hash;
  private validator: boolean;
  private readonly recent = new Map<Hash, QuorumSet>();

  constructor(
    private readonly nodeId: NodeId,
    isValidator: boolean,
    qSet: QuorumSet,
  ) {
    this.validator = isValidator;
    this.qSet = LocalNode.prepare(qSet);
    this.qSetHash = hashQuorumSet(this.qSet);
    this.remember();
  }

  private remember(): void {
    this.recent.delete(this.qSetHash);
    this.recent.set(this.qSetHash, this.qSet);
    while (this.recent.size > RECENT_QSETS) this.recent.delete(this.recent.keys().next().value!);
  }

  /** The current or a recent local quorum set with this hash, or null. */
  getQuorumSetByHash(hash: Hash): QuorumSet | null {
    return this.recent.get(hash) ?? null;
  }

  // stellar-core normalizes only in the constructor. We also normalize on
  // update, so the same set always gives the same hash.
  private static prepare(qSet: QuorumSet): QuorumSet {
    const err = checkQuorumSetSanity(qSet, false);
    if (err !== null) throw new Error(`invalid local quorum set: ${err}`);
    return normalizeQSet(qSet);
  }

  getNodeId(): NodeId {
    return this.nodeId;
  }

  updateQuorumSet(qSet: QuorumSet): void {
    this.qSet = LocalNode.prepare(qSet);
    this.qSetHash = hashQuorumSet(this.qSet);
    this.remember();
  }

  /** The normalized local quorum set. Callers must not modify it. */
  getQuorumSet(): QuorumSet {
    return this.qSet;
  }

  getQuorumSetCopy(): QuorumSet {
    return cloneQSet(this.qSet);
  }

  getQuorumSetHash(): Hash {
    return this.qSetHash;
  }

  isValidator(): boolean {
    return this.validator;
  }

  setValidator(on: boolean): void {
    this.validator = on;
  }
}
