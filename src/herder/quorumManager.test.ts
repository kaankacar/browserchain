import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { VALIDATOR_ACTIVE_MS } from '../lib/constants';
import { sha256 } from '../lib/hash';
import type { PeerInfo, PeerSyncState } from '../overlay/types';
import { sortNodeIds } from '../scp/quorum';
import type { QuorumSet } from '../scp/types';
import { checkQuorumIntersection, faultTolerance, minBlockingSize, transitiveNodes } from './quorumAnalysis';
import { MAX_MEMBERS, PARTICIPATION_GRACE_MS, QuorumManager, autoQuorumSet, autoThreshold } from './quorumManager';

const ids = Array.from({ length: 20 }, (_, i) =>
  Keypair.fromRawEd25519Seed(sha256(`qm-${i}`)).publicKey(),
);
const H = (n: number) => n.toString(16).padStart(64, '0');

function peer(nodeId: string, o: { seq?: number; hash?: string; state?: PeerSyncState; validator?: boolean; qsetHash?: string } = {}): PeerInfo {
  return {
    nodeId,
    name: `n-${nodeId.slice(1, 4)}`,
    transports: ['memory'],
    ann: {
      nodeId,
      name: `n-${nodeId.slice(1, 4)}`,
      networkId: H(9),
      appVersion: 1,
      lcl: { seq: o.seq ?? 10, hash: o.hash ?? H(10) },
      state: o.state ?? 'synced',
      validator: o.validator ?? true,
      qsetHash: o.qsetHash ?? '',
      quorumMode: 'auto',
      ts: 1,
    },
    connectedAt: 0,
    lastSeen: 0,
    latencyMs: null,
  };
}

function manager() {
  const clock = new VirtualClock(1_000_000);
  const qm = new QuorumManager({ selfId: ids[0], selfName: 'me', clock });
  qm.setLocalChain({ seq: 10, hash: H(10) }, H(9));
  return { qm, clock };
}

describe('auto quorum sets', () => {
  it('uses threshold max(1, ceil(2n/3)) over sorted validators', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(autoThreshold)).toEqual([1, 2, 2, 3, 4, 4, 5]);
    expect(autoThreshold(0)).toBe(1);
    const q = autoQuorumSet([ids[3], ids[1], ids[2], ids[1]]);
    expect(q).toEqual({ threshold: 2, validators: sortNodeIds([ids[1], ids[2], ids[3]]), innerSets: [] });
  });

  it('is just self when nobody else is active', () => {
    const { qm } = manager();
    expect(qm.autoQSet()).toEqual({ threshold: 1, validators: [ids[0]], innerSets: [] });
    qm.setValidating(false);
    expect(qm.activeIds()).toEqual([]);
    expect(qm.autoQSet().validators).toEqual([ids[0]]);
  });

  it('counts validators heard recently that follow our chain', () => {
    const { qm } = manager();
    qm.noteStatus(peer(ids[1]));
    qm.noteStatus(peer(ids[2], { seq: 11, hash: H(77) }));
    qm.noteStatus(peer(ids[3], { seq: 9, hash: H(9) }));
    qm.noteStatus(peer(ids[4], { state: 'booting' }));
    qm.noteStatus(peer(ids[5], { state: 'stalled' }));
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]]));
    expect(qm.autoQSet().threshold).toBe(4);
  });

  it('excludes catching-up nodes, watchers, far LCLs and other branches', () => {
    const { qm } = manager();
    qm.noteStatus(peer(ids[1], { state: 'catching-up' }));
    qm.noteStatus(peer(ids[2], { validator: false }));
    qm.noteStatus(peer(ids[3], { seq: 12 }));
    qm.noteStatus(peer(ids[4], { seq: 10, hash: H(123) }));
    qm.noteStatus(peer(ids[5], { seq: 9, hash: H(55) }));
    qm.noteStatus(peer(ids[6]));
    qm.markForked(ids[6], true);
    expect(qm.activeIds()).toEqual([ids[0]]);
    qm.markForked(ids[6], false);
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[6]]));
    expect(qm.isConsistent({ seq: 10, hash: H(123) })).toBe(false);
    expect(qm.isConsistent({ seq: 9, hash: H(9) })).toBe(true);
    expect(qm.isConsistent({ seq: 11, hash: H(1) })).toBeNull();
  });

  it('drops validators silent for VALIDATOR_ACTIVE_MS, and at once after a bye', async () => {
    const { qm, clock } = manager();
    qm.noteStatus(peer(ids[1]));
    qm.noteEnvelope(ids[1], 10);
    qm.noteStatus(peer(ids[2]));
    qm.noteEnvelope(ids[2], 10);
    qm.noteDisconnected(ids[2], true);
    expect(qm.isGone(ids[2])).toBe(true);
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[1]]));
    await clock.advance(VALIDATOR_ACTIVE_MS - 1);
    expect(qm.isActive(ids[1])).toBe(true);
    await clock.advance(2);
    expect(qm.isActive(ids[1])).toBe(false);
    // a new status and a vote bring both back
    for (const id of [ids[1], ids[2]]) {
      qm.noteStatus(peer(id));
      qm.noteEnvelope(id, 11);
    }
    expect(qm.isGone(ids[2])).toBe(false);
    expect(qm.activeIds().length).toBe(3);
  });

  it(`a status alone counts only for ${PARTICIPATION_GRACE_MS / 1000} s after a validator is first heard of (obs-1)`, async () => {
    const { qm, clock } = manager();
    qm.noteStatus(peer(ids[1]));
    qm.noteStatus(peer(ids[2], { state: 'booting' }));
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[1], ids[2]]));
    // statuses keep coming, but neither votes
    for (let t = 0; t < PARTICIPATION_GRACE_MS; t += 1000) {
      await clock.advance(1000);
      qm.noteStatus(peer(ids[1]));
      qm.noteStatus(peer(ids[2], { state: 'booting' }));
    }
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[1], ids[2]]));
    await clock.advance(2);
    qm.noteStatus(peer(ids[1]));
    expect(qm.activeIds()).toEqual([ids[0]]);
    // a signed SCP envelope for our open slot makes it active again
    qm.noteEnvelope(ids[1], 11);
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[1]]));
    // reconnecting does not start a new grace period
    qm.noteDisconnected(ids[2], false);
    qm.noteStatus(peer(ids[2]));
    expect(qm.isActive(ids[2])).toBe(false);
    // the member book does not take validators that do not take part
    expect(qm.noteMembers()).toBe(true);
    expect(qm.memberSince(ids[1])).toBe(10);
    expect(qm.memberSince(ids[2])).toBeUndefined();
  });

  it('counts an envelope for a recent slot (LCL-1 to LCL+2) for VALIDATOR_ACTIVE_MS', async () => {
    const { qm, clock } = manager();
    qm.noteStatus(peer(ids[1]));
    qm.noteStatus(peer(ids[2]));
    qm.noteStatus(peer(ids[3]));
    await clock.advance(PARTICIPATION_GRACE_MS + 1);
    qm.noteEnvelope(ids[1], 9); // LCL-1: a slow peer finishing the last slot
    qm.noteEnvelope(ids[2], 5); // an old slot: no sign that it votes now
    qm.noteEnvelope(ids[3], 13); // too far ahead
    for (const id of [ids[1], ids[2], ids[3]]) qm.noteStatus(peer(id));
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[1]]));
    await clock.advance(VALIDATOR_ACTIVE_MS - 1);
    qm.noteStatus(peer(ids[1]));
    expect(qm.isActive(ids[1])).toBe(true);
    await clock.advance(2);
    qm.noteStatus(peer(ids[1]));
    expect(qm.isActive(ids[1])).toBe(false);
  });

  it('keeps a validator that voted in the open slot while the slot is stuck, until the slot closes', async () => {
    const { qm, clock } = manager();
    qm.noteStatus(peer(ids[1]));
    qm.noteEnvelope(ids[1], 11);
    // a long stall: nothing new is sent, only statuses
    for (let t = 0; t < 4 * VALIDATOR_ACTIVE_MS; t += 2000) {
      await clock.advance(2000);
      qm.noteStatus(peer(ids[1]));
    }
    expect(qm.isActive(ids[1])).toBe(true);
    // a crashed peer stops sending statuses: it leaves after VALIDATOR_ACTIVE_MS as before
    await clock.advance(VALIDATOR_ACTIVE_MS + 1);
    expect(qm.isActive(ids[1])).toBe(false);
    qm.noteStatus(peer(ids[1], { seq: 11, hash: H(11) }));
    // the slot closed (our LCL is 11): its old vote no longer counts, a new one does
    qm.setLocalChain({ seq: 11, hash: H(11) }, H(10));
    expect(qm.isActive(ids[1])).toBe(false);
    qm.noteEnvelope(ids[1], 12);
    expect(qm.isActive(ids[1])).toBe(true);
  });

  it('counts nodes heard only through SCP when they work on our slot', async () => {
    const { qm, clock } = manager();
    qm.noteEnvelope(ids[7], 11);
    qm.noteEnvelope(ids[8], 40);
    expect(qm.activeIds()).toEqual(sortNodeIds([ids[0], ids[7]]));
    await clock.advance(VALIDATOR_ACTIVE_MS + 1);
    expect(qm.activeIds()).toEqual([ids[0]]);
  });
});

describe('manual mode and the directory', () => {
  it('keeps the user quorum set (normalized), rejects insane ones', () => {
    const { qm } = manager();
    const q: QuorumSet = { threshold: 2, validators: [ids[3], ids[1]], innerSets: [{ threshold: 1, validators: [ids[5], ids[4]], innerSets: [] }] };
    qm.setManual(q);
    expect(qm.getMode()).toBe('manual');
    qm.noteStatus(peer(ids[9]));
    const d = qm.desiredQSet();
    expect(d.validators).toEqual(sortNodeIds([ids[1], ids[3]]));
    expect(d.innerSets[0].validators).toEqual(sortNodeIds([ids[4], ids[5]]));
    expect(() => qm.setManual({ threshold: 3, validators: [ids[1]], innerSets: [] })).toThrow(/invalid quorum set/);
    expect(() => qm.setManual({ threshold: 1, validators: [ids[1], ids[1]], innerSets: [] })).toThrow(/Duplicate/);
    qm.setAuto();
    expect(qm.getMode()).toBe('auto');
    expect(qm.desiredQSet().validators).toEqual(sortNodeIds([ids[0], ids[9]]));
  });

  it('needs a quorum set to start in manual mode', () => {
    const clock = new VirtualClock();
    expect(() => new QuorumManager({ selfId: ids[0], selfName: 'x', clock, mode: 'manual' })).toThrow(/needs a quorum set/);
  });

  it('lists self first and remembers names, qset hashes and connections', () => {
    const { qm } = manager();
    qm.noteStatus(peer(ids[2], { qsetHash: H(5) }));
    qm.noteEnvelope(ids[1], 11);
    qm.noteQSetHash(ids[1], H(6));
    qm.setSelfName('renamed');
    qm.noteDisconnected(ids[2], false);
    const list = qm.list();
    expect(list[0]).toMatchObject({ nodeId: ids[0], isSelf: true, name: 'renamed' });
    expect(list.map((r) => r.nodeId).slice(1)).toEqual(sortNodeIds([ids[1], ids[2]]));
    expect(qm.get(ids[2])).toMatchObject({ connected: false, gone: false, qsetHash: H(5) });
    expect(qm.get(ids[1])).toMatchObject({ lastSlot: 11, qsetHash: H(6) });
    expect(qm.name(ids[2])).toBe(peer(ids[2]).name);
    // ids[1] (never connected) and ids[2] (disconnected) are silent: pruned; self stays
    expect(qm.prune(Number.MAX_SAFE_INTEGER)).toBe(2);
    expect(qm.list().map((r) => r.nodeId)).toEqual([ids[0]]);
  });
});

describe('member book (validators seen as active members on our chain)', () => {
  it('records active validators whose status is on our chain, with the lowest ledger', () => {
    const { qm } = manager();
    qm.noteStatus(peer(ids[1]));
    qm.noteStatus(peer(ids[2], { seq: 9, hash: H(9) }));
    qm.noteStatus(peer(ids[3], { state: 'booting' }));
    expect(qm.noteMembers()).toBe(true);
    expect([qm.memberSince(ids[1]), qm.memberSince(ids[2]), qm.memberSince(ids[3])]).toEqual([10, 9, 10]);
    // nothing new: nothing to persist
    expect(qm.noteMembers()).toBe(false);
    // later ledgers do not move `since`
    qm.setLocalChain({ seq: 11, hash: H(11) }, H(10));
    qm.noteStatus(peer(ids[1], { seq: 11, hash: H(11) }));
    expect(qm.noteMembers()).toBe(false);
    expect(qm.memberSince(ids[1])).toBe(10);
    expect(qm.wasMemberAt(ids[1], 10)).toBe(true);
    expect(qm.wasMemberAt(ids[1], 9)).toBe(false);
    expect(qm.wasMemberAt(ids[9], 100)).toBe(false);
    expect(qm.memberSince(ids[0])).toBeUndefined();
  });

  it('does not record peers it cannot place on our chain, or that are not active', async () => {
    const { qm, clock } = manager();
    qm.noteStatus(peer(ids[1], { seq: 11, hash: H(77) })); // one ahead: active, but not on a ledger we know
    qm.noteStatus(peer(ids[2], { seq: 10, hash: H(123) })); // another branch
    qm.noteStatus(peer(ids[3], { seq: 9, hash: H(55) })); // another branch
    qm.noteStatus(peer(ids[4], { state: 'catching-up' }));
    qm.noteStatus(peer(ids[5], { validator: false }));
    qm.noteStatus(peer(ids[6]));
    qm.markForked(ids[6], true);
    qm.noteEnvelope(ids[7], 11); // heard only through SCP: no status to place
    expect(qm.isActive(ids[1])).toBe(true);
    expect(qm.noteMembers()).toBe(false);
    expect(qm.memberCount()).toBe(0);
    // a status that is too old does not count either
    qm.markForked(ids[6], false);
    await clock.advance(VALIDATOR_ACTIVE_MS + 1);
    expect(qm.noteMembers()).toBe(false);
    expect(qm.memberCount()).toBe(0);
  });

  it('reports the lowest ledger at which it saw any member (undefined for an empty book)', () => {
    const { qm } = manager();
    expect(qm.earliestMemberSince()).toBeUndefined();
    qm.noteMember(ids[3], 40);
    qm.noteMember(ids[4], 25);
    qm.noteMember(ids[3], 60);
    expect(qm.earliestMemberSince()).toBe(25);
    qm.clearMembers();
    expect(qm.earliestMemberSince()).toBeUndefined();
  });

  it('takes members from SCP confirmations, and only an earlier ledger is news', () => {
    const { qm } = manager();
    expect(qm.noteMember(ids[7], 8)).toBe(true);
    expect(qm.noteMember(ids[7], 9)).toBe(false);
    expect(qm.noteMember(ids[7], 5)).toBe(true);
    expect(qm.memberSince(ids[7])).toBe(5);
    expect(qm.noteMember(ids[0], 3)).toBe(false);
    expect(qm.noteMember(ids[8], 0)).toBe(false);
    expect(qm.noteMember(ids[8], 1.5)).toBe(false);
    expect(qm.memberCount()).toBe(1);
  });

  it('exports and imports the book, skipping malformed entries and ourselves', () => {
    const { qm } = manager();
    qm.noteMember(ids[2], 7);
    qm.noteMember(ids[1], 3);
    qm.noteMember(ids[1], 12);
    const saved = qm.exportMembers();
    expect(saved).toEqual(sortNodeIds([ids[1], ids[2]]).map((id) => (id === ids[1] ? { nodeId: id, since: 3, last: 12 } : { nodeId: id, since: 7, last: 7 })));
    const { qm: other } = manager();
    const n = other.importMembers([
      ...saved,
      { nodeId: ids[0], since: 1, last: 1 },
      { nodeId: 'not a key', since: 1, last: 1 },
      { nodeId: ids[3], since: 0, last: 4 },
      { nodeId: ids[4], since: 5, last: 4 },
      { nodeId: ids[5], since: '2', last: 4 },
      null,
    ]);
    expect(n).toBe(2);
    expect(other.exportMembers()).toEqual(saved);
    expect(other.importMembers('garbage')).toBe(0);
    expect(other.importMembers(undefined)).toBe(0);
    other.clearMembers();
    expect(other.memberCount()).toBe(0);
  });

  it(`keeps at most ${MAX_MEMBERS} members: the one active least recently goes first`, () => {
    const { qm } = manager();
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => Keypair.fromRawEd25519Seed(sha256(`qm-many-${i}`)).publicKey());
    // the first one was active at ledger 1 only; the others are active up to ledger 50
    qm.noteMember(many[0], 1);
    for (const id of many.slice(1, MAX_MEMBERS)) {
      qm.noteMember(id, 2);
      qm.noteMember(id, 50);
    }
    expect(qm.memberCount()).toBe(MAX_MEMBERS);
    expect(qm.noteMember(many[MAX_MEMBERS], 50)).toBe(true);
    expect(qm.memberCount()).toBe(MAX_MEMBERS);
    expect(qm.memberSince(many[0])).toBeUndefined();
    expect(qm.memberSince(many[MAX_MEMBERS])).toBe(50);
  });
});

describe('quorum analysis', () => {
  const flat = (n: number[], t: number): QuorumSet => ({ threshold: t, validators: n.map((i) => ids[i]), innerSets: [] });

  it('fault tolerance of flat and nested sets', () => {
    expect(faultTolerance(flat([0, 1, 2, 3], 3))).toBe(1);
    expect(faultTolerance(flat([0, 1, 2, 3, 4, 5, 6], 5))).toBe(2);
    expect(faultTolerance(flat([0], 1))).toBe(0);
    const nested: QuorumSet = { threshold: 2, validators: [], innerSets: [flat([0, 1, 2], 2), flat([3, 4, 5], 2), flat([6, 7, 8], 2)] };
    // blocking: 2 inner sets x 2 validators each
    expect(minBlockingSize(nested)).toBe(4);
    expect(faultTolerance(nested)).toBe(3);
    expect(minBlockingSize(flat([0, 1], 3))).toBe(0);
  });

  it('finds intersecting and split networks', () => {
    const all = [0, 1, 2, 3];
    const ok = new Map(all.map((i) => [ids[i], flat(all, 3)]));
    expect(checkQuorumIntersection(ids[0], ok)).toBe('ok');
    // two halves that only trust themselves
    const split = new Map<string, QuorumSet | null>([
      [ids[0], flat([0, 1, 2, 3], 2)],
      [ids[1], flat([0, 1], 2)],
      [ids[2], flat([2, 3], 2)],
      [ids[3], flat([2, 3], 2)],
    ]);
    expect(checkQuorumIntersection(ids[0], split)).toBe('broken');
    // a threshold of 2 of 4 lets {0,1} and {2,3} be disjoint quorums
    const low = new Map(all.map((i) => [ids[i], flat(all, 2)]));
    expect(checkQuorumIntersection(ids[0], low)).toBe('broken');
  });

  it('treats unknown quorum sets as dead nodes and gives up above 16 nodes', () => {
    const map = new Map<string, QuorumSet | null>([
      [ids[0], flat([0, 1, 2], 2)],
      [ids[1], flat([0, 1, 2], 2)],
      [ids[2], null],
    ]);
    expect(transitiveNodes(ids[0], map).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    expect(checkQuorumIntersection(ids[0], map)).toBe('ok');
    expect(checkQuorumIntersection(ids[5], map)).toBe('unknown');
    const big = Array.from({ length: 17 }, (_, i) => i);
    const huge = new Map(big.map((i) => [ids[i], flat(big, 12)]));
    expect(checkQuorumIntersection(ids[0], huge)).toBe('unknown');
    const sixteen = big.slice(0, 16);
    const max = new Map(sixteen.map((i) => [ids[i], flat(sixteen, 11)]));
    expect(checkQuorumIntersection(ids[0], max)).toBe('ok');
  });

  it('QuorumManager.intersection uses the known quorum sets of the directory', () => {
    const { qm } = manager();
    const all = [0, 1, 2, 3];
    const qs = flat(all, 3);
    for (const i of [1, 2, 3]) qm.noteStatus(peer(ids[i], { qsetHash: H(42) }));
    expect(qm.intersection(qs, (h) => (h === H(42) ? qs : null))).toBe('ok');
    expect(qm.intersection(flat(all, 2), () => flat(all, 2))).toBe('broken');
    expect(qm.faultTolerance(qs)).toBe(1);
  });
});
