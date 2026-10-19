// Snapshot trust (review: in auto mode, attackers with more identities than
// the honest side could make a node adopt a forged snapshot).
// - A node with a committed chain beyond genesis catches up by replay only:
//   every ledger is re-executed, so forged balances need forged signatures.
// - A snapshot is for a node with no committed state, or when every source
//   lacks the ledgers to replay; then at least two validators that the node
//   saw as active members at or before its LCL must announce the target,
//   more than the ones against it (the node itself included).
// - A node that cannot catch up and would vote alone does not vote: it
//   waits in 'catching-up' (review: it closed 24 ledgers of its own).
// - In manual mode, a catch-up target must be announced by a v-blocking set
//   of the configured quorum set.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/hash';
import { Logger, LogSink } from '../lib/log';
import { deserializeEntry } from '../ledger/entries';
import { decodeLedgerHeader } from '../ledger/header';
import { LedgerManager, loadLedgerFromSnapshot } from '../ledger/manager';
import { LedgerRoot } from '../ledger/state';
import type { AccountEntry } from '../ledger/types';
import { makeSignedStellarValue } from '../ledger/value';
import { Overlay, type AnnouncementFields } from '../overlay/overlay';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { SimNode, Simulation } from './simulation';

interface FakeLedger {
  headerXdr: string;
  txSetXdr: string;
}

/** Headers or ledgers [from, to] (at most 64): the honest node's own up to `start`, then `fake`. */
async function serveChain(sn: SimNode, start: number, fake: Map<number, FakeLedger>, body: RequestBody, max: number): Promise<ResponseBody | null> {
  if (body.kind !== 'headers' && body.kind !== 'ledgers') return null;
  const items: { seq: number; headerXdr: string; txSetXdr: string }[] = [];
  for (let s = body.from; s <= Math.min(body.to, body.from + 63, max); s++) {
    const own = s <= start ? await sn.node!.chain.getLedger(s) : undefined;
    const l = own ? { headerXdr: own.headerXdr, txSetXdr: own.txSetXdr } : fake.get(s);
    if (l) items.push({ seq: s, ...l });
  }
  return body.kind === 'headers'
    ? { kind: 'headers', items: items.map((i) => ({ seq: i.seq, headerXdr: i.headerXdr })) }
    : { kind: 'ledgers', items };
}

function liarOverlay(sim: Simulation, kp: Keypair, name: string, handlers: Partial<ConstructorParameters<typeof Overlay>[0]['handlers']>): Overlay {
  return new Overlay({
    keypair: kp,
    networkId: sim.nodes[0].node!.networkIdHex,
    name,
    clock: sim.clock,
    logger: new Logger(new LogSink(sim.clock, 'error'), name),
    transports: [sim.net.createTransport(name)],
    handlers: { onStellarMessage: () => false, onRequest: () => null, ...handlers },
    announcement: { lcl: { seq: 1, hash: '00'.repeat(32) }, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' },
  });
}

const ann = (name: string, lcl: { seq: number; hash: string }): AnnouncementFields => ({ name, lcl, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' });

/**
 * `identities` liars follow the honest LCL: they extend it with their own
 * empty ledgers up to checkpoint 64, whose snapshot takes the victim's whole
 * balance, and all announce ledger 64. They serve the headers (linked from
 * the honest LCL) and, when `serveLedgers`, the ledgers too.
 */
async function forgedChainAttack(seed: number, identities: number, serveLedgers: boolean) {
  const sim = new Simulation({ seed, latency: [10, 60] });
  const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
  expect(await sim.waitForLedger(4, 60_000)).toBe(true);
  const pass = nodes[0].node!.passphrase;
  const victim = Keypair.fromRawEd25519Seed(sha256(`snapshot-trust|victim|${seed}`));
  expect((await nodes[0].node!.friendbot(victim.publicKey())).status).toBe('PENDING');
  expect(await sim.runUntil(() => nodes.every((n) => n.node!.ledger.getAccount(victim.publicKey()) !== undefined), 60_000)).toBe(true);
  const funded = nodes[0].node!.ledger.getAccount(victim.publicKey())!.balance;
  const keys = Array.from({ length: identities }, (_, i) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(71 + i)));
  let fake: { start: number; startHash: string; ledgers: Map<number, FakeLedger>; snap: string; target: { seq: number; hash: string } } | null = null;
  const requests = { snapshot: 0, ledgers: 0 };
  const overlays: Overlay[] = [];
  const build = (src: SimNode) => {
    const lcl = src.node!.ledger.lastClosed();
    if ((fake && fake.startHash === lcl.hash) || lcl.header.ledgerSeq >= 62) return;
    let lm = loadLedgerFromSnapshot(src.node!.ledger.snapshot(), pass);
    const ledgers = new Map<number, FakeLedger>();
    const close = () => {
      const prev = lm.lastClosed();
      const txSet = lm.makeTxSet(prev.hash, []);
      const r = lm.closeLedger(txSet, makeSignedStellarValue(lm.networkId, keys[0], txSet.hash, prev.header.scpValue.closeTime + 1));
      ledgers.set(r.header.ledgerSeq, { headerXdr: r.headerXdr, txSetXdr: txSet.xdr });
      return r;
    };
    while (lm.lastClosed().header.ledgerSeq < 63) close();
    const snap63 = lm.snapshot();
    const entries = snap63.entries.map(deserializeEntry);
    for (const e of entries) if (e.kind === 'account' && (e as AccountEntry).accountId === victim.publicKey()) (e as AccountEntry).balance = 0n;
    lm = new LedgerManager(pass, new LedgerRoot(entries), decodeLedgerHeader(snap63.headerXdr));
    const r64 = close();
    fake = { start: lcl.header.ledgerSeq, startHash: lcl.hash, ledgers, snap: JSON.stringify(lm.snapshot()), target: { seq: 64, hash: r64.hash } };
    overlays.forEach((ov, i) => ov.setAnnouncement(ann(`evil${i}`, fake!.target)));
  };
  keys.forEach((kp, i) => {
    overlays.push(
      liarOverlay(sim, kp, `evil${i}`, {
        onPeerStatus: (p) => {
          const sn = nodes.find((n) => n.nodeId === p.nodeId);
          if (sn?.running) build(sn);
        },
        onRequest: async (b, from) => {
          const sn = nodes.find((n) => n.nodeId === from.nodeId);
          if (!sn || !fake) return null;
          if (b.kind === 'snapshot') {
            requests.snapshot++;
            return { kind: 'snapshot', seq: 64, data: fake.snap };
          }
          if (b.kind === 'ledgers') {
            requests.ledgers++;
            if (!serveLedgers) return null;
          }
          return serveChain(sn, fake.start, fake.ledgers, b, 64);
        },
      }),
    );
  });
  for (const ov of overlays) ov.start();
  build(nodes[0]);
  const t0 = sim.clock.now();
  const base = nodes.map((n) => n.lcl);
  await sim.run(90_000);
  return { sim, nodes, overlays, victim, funded, requests, t0, base };
}

/**
 * e closes a few ledgers with a and b, then stops. a and b go past
 * checkpoint 64; `born` nodes join then (from snapshot 64, so they lack
 * ledgers 2..64), and a and b leave. e comes back: no source can replay
 * its gap.
 */
async function snapshotBornNetwork(seed: number, born: number) {
  const sim = new Simulation({ seed, latency: [10, 40] });
  const [a, b, e] = await sim.addNodes([{ name: 'a' }, { name: 'b' }, { name: 'e' }]);
  expect(await sim.waitForLedger(8, 60_000)).toBe(true);
  await sim.stopNode(e);
  const eLcl = e.lcl;
  const eHash = e.chain.get(eLcl)!;
  expect(await sim.waitForLedger(70, 600_000, [a, b])).toBe(true);
  const joined: SimNode[] = [];
  for (let i = 0; i < born; i++) joined.push(await sim.addNode({ name: `born${i}` }));
  expect(await sim.runUntil(() => joined.every((n) => n.state === 'synced' && n.lcl >= a.lcl - 1), 120_000)).toBe(true);
  for (const n of joined) expect(await n.storage.getLedger(10)).toBeUndefined();
  await sim.stopNode(a);
  await sim.stopNode(b);
  expect(await sim.waitForLedger(a.lcl + 4, 120_000, joined)).toBe(true);
  return { sim, e, eLcl, eHash, joined };
}

describe('snapshot trust: a committed chain catches up by replay', () => {
  it('a node with a committed chain replays past a checkpoint instead of loading the snapshot', async () => {
    const sim = new Simulation({ seed: 251, latency: [10, 40] });
    const [a, b, c] = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    await sim.stopNode(c);
    const cLcl = c.lcl;
    expect(await sim.waitForLedger(72, 600_000, [a, b])).toBe(true);
    const back = sim.clock.now();
    await sim.restartNode(c);
    expect(await sim.runUntil(() => c.state === 'synced' && c.lcl >= a.lcl - 1, 120_000)).toBe(true);
    const replayed = c.closes.filter((x) => x.source === 'catchup' && x.at >= back).map((x) => x.seq);
    expect(Math.min(...replayed)).toBe(cLcl + 1);
    expect(replayed).toContain(64);
    expect(await c.storage.getLedger(10)).toBeDefined();
    expect(await sim.waitForLedger(c.lcl + 2, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('four liars against three honest nodes: a forged snapshot is never fetched; replaying the forged chain fails at the forged ledger', async () => {
    const { sim, nodes, overlays, victim, funded, requests } = await forgedChainAttack(611, 4, true);
    for (const n of nodes) {
      expect(n.node!.ledger.getAccount(victim.publicKey())!.balance, `${n.name} victim balance`).toBe(funded);
    }
    // the honest nodes followed the liars (4 > 3) but only by replay: the
    // empty ledgers replay, the ledger with the forged state cannot
    expect(requests.snapshot).toBe(0);
    expect(requests.ledgers).toBeGreaterThan(0);
    expect(sim.recentLogs(2000).some((l) => /replay of ledger 64 gave/.test(l))).toBe(true);
    for (const ov of overlays) ov.stop();
    await sim.shutdown();
  });

  it('four liars that withhold the ledgers cannot get their snapshot loaded either', async () => {
    const { sim, nodes, overlays, victim, funded, requests, t0, base } = await forgedChainAttack(612, 4, false);
    for (const n of nodes) {
      expect(n.node!.ledger.getAccount(victim.publicKey())!.balance, `${n.name} victim balance`).toBe(funded);
      expect(await n.storage.listSnapshotSeqs()).not.toContain(64);
    }
    expect(requests.snapshot).toBe(0);
    expect(requests.ledgers).toBeGreaterThan(0);
    expect(sim.recentLogs(2000).some((l) => /cannot replay to ledger 64/.test(l))).toBe(true);
    // the honest nodes keep closing ledgers (18 in 90 s at full pace), and a
    // refused target does not make them pause at every ledger (the liars'
    // target moves with each honest ledger: about 18 pauses without resting
    // the sources, about 6 with it, a few more when the pauses cause forks)
    nodes.forEach((n, i) => expect(n.lcl - base[i], `${n.name} progress`).toBeGreaterThanOrEqual(12));
    for (const n of nodes) expect(n.states.filter((x) => x.at > t0 && x.state === 'catching-up').length, `${n.name} pauses`).toBeLessThanOrEqual(12);
    expect(sim.conflicts(nodes)).toEqual([]);
    for (const ov of overlays) ov.stop();
    await sim.shutdown();
  });
});

/** e waits without voting: no ledger closed alone, state and progress say why. */
function expectWaiting(sim: Simulation, e: SimNode, eLcl: number, eHash: string, since: number, networkLcl: number): void {
  expect(e.consensusCloses().filter((c) => c.at >= since).map((c) => c.seq), `${e.name} closed ledgers alone`).toEqual([]);
  expect(e.lcl).toBe(eLcl);
  expect(e.chain.get(eLcl)).toBe(eHash);
  expect(e.state).toBe('catching-up');
  expect(e.states.filter((s) => s.at >= since && (s.state === 'synced' || s.state === 'stalled'))).toEqual([]);
  const progress = e.node!.getStatus().catchup;
  expect(progress).toMatchObject({ current: eLcl, source: null });
  expect(progress!.target).toBeGreaterThanOrEqual(networkLcl - 2);
  expect(sim.recentLogs(2000).some((l) => /\[e\] not voting: peers are at ledger \d+ and we cannot catch up from ledger \d+/.test(l))).toBe(true);
}

describe('snapshot trust: snapshots when replay is impossible', () => {
  it('two snapshot-born sources it never knew: no snapshot, and the returning node does not vote alone', async () => {
    const { sim, e, eLcl, eHash, joined } = await snapshotBornNetwork(261, 2);
    const back = sim.clock.now();
    await sim.restartNode(e);
    await sim.run(90_000);
    // validators first seen after its LCL do not vouch for a snapshot
    expect(await e.storage.listSnapshotSeqs()).not.toContain(64);
    expect(sim.recentLogs(2000).some((l) => /\[e\] cannot replay to ledger \d+: .*\(0 for, 1 against, us included\)/.test(l))).toBe(true);
    expectWaiting(sim, e, eLcl, eHash, back, joined[0].lcl);
    await sim.shutdown();
  });

  it('one snapshot-born source: the returning node waits without voting, then replays from a validator that has the ledgers', async () => {
    const { sim, e, eLcl, eHash, joined } = await snapshotBornNetwork(262, 1);
    const back = sim.clock.now();
    await sim.restartNode(e);
    await sim.run(120_000);
    expect(await e.storage.listSnapshotSeqs()).not.toContain(64);
    expect((await e.storage.getLedger(eLcl))?.hash).toBe(eHash);
    expect(sim.recentLogs(2000).some((l) => /cannot replay to ledger \d+/.test(l))).toBe(true);
    expectWaiting(sim, e, eLcl, eHash, back, joined[0].lcl);
    // a validator with the whole chain comes back: e replays from it and votes again
    const a = sim.get('a');
    await sim.restartNode(a);
    expect(await sim.runUntil(() => e.state === 'synced' && e.lcl >= joined[0].lcl - 1, 120_000)).toBe(true);
    const replayed = e.closes.filter((x) => x.source === 'catchup' && x.at >= back).map((x) => x.seq);
    expect(Math.min(...replayed)).toBe(eLcl + 1);
    expect(replayed).toContain(64);
    expect(await sim.waitForLedger(e.lcl + 2, 60_000, [e, a, ...joined])).toBe(true);
    expect(sim.conflicts([e, a, ...joined])).toEqual([]);
    await sim.shutdown();
  });

  it('a lone validator at work goes on validating when one peer announces a far-ahead ledger and serves nothing', async () => {
    // Review: the wait above also stopped a lone validator that was closing
    // ledgers: one identity with one status halted it for as long as it
    // stayed connected. Only a node that would start voting alone waits.
    const sim = new Simulation({ seed: 264, latency: [10, 40] });
    const a = await sim.addNode({ name: 'a' });
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    const far = liarOverlay(sim, Keypair.fromRawEd25519Seed(sha256('snapshot-trust|far-ahead')), 'far', {});
    far.setAnnouncement(ann('far', { seq: 5000, hash: 'ab'.repeat(32) }));
    far.start();
    const t0 = sim.clock.now();
    await sim.run(120_000);
    // it tried to catch up and could not, then went on alone as before
    expect(sim.recentLogs(2000).some((l) => /\[a\] cannot replay to ledger 5000/.test(l))).toBe(true);
    expect(sim.recentLogs(2000).some((l) => /\[a\] not voting/.test(l))).toBe(false);
    const closed = a.consensusCloses().filter((c) => c.at >= t0);
    expect(closed.length, 'ledgers closed in 120 s').toBeGreaterThanOrEqual(15);
    expect(sim.clock.now() - closed[closed.length - 1].at, 'still closing at the end').toBeLessThan(15_000);
    far.stop();
    await sim.shutdown();
  });

  it('two validators it knew before lack the ledgers and agree: the returning node loads their snapshot', async () => {
    const sim = new Simulation({ seed: 263, latency: [10, 40] });
    const [a, b, x, y, e] = await sim.addNodes(['a', 'b', 'x', 'y', 'e'].map((name) => ({ name })));
    expect(await sim.waitForLedger(8, 60_000)).toBe(true);
    await sim.stopNode(e);
    const eLcl = e.lcl;
    expect(await sim.waitForLedger(70, 600_000, [a, b, x, y])).toBe(true);
    // x and y start over: they come back from snapshot 64 and lack ledgers 2..63
    for (const n of [x, y]) {
      let done = false;
      void n.node!.resync().then(() => {
        done = true;
      });
      expect(await sim.runUntil(() => done, 30_000)).toBe(true);
      expect(await sim.runUntil(() => n.state === 'synced' && n.lcl >= a.lcl - 1, 120_000)).toBe(true);
      expect(await n.storage.getLedger(10)).toBeUndefined();
    }
    await sim.stopNode(a);
    await sim.stopNode(b);
    expect(await sim.waitForLedger(a.lcl + 4, 120_000, [x, y])).toBe(true);
    const back = sim.clock.now();
    await sim.restartNode(e);
    expect(await sim.runUntil(() => e.state === 'synced' && e.lcl >= x.lcl - 1, 120_000)).toBe(true);
    expect(await e.storage.listSnapshotSeqs()).toContain(64);
    const replayed = e.closes.filter((c) => c.source === 'catchup' && c.at >= back).map((c) => c.seq);
    expect(Math.min(...replayed)).toBe(65);
    expect(e.lcl).toBeGreaterThan(eLcl);
    expect(await sim.waitForLedger(e.lcl + 2, 60_000, [e, x, y])).toBe(true);
    expect(sim.conflicts([e, x, y])).toEqual([]);
    await sim.shutdown();
  });
});

describe('snapshot trust: manual mode follows only a v-blocking set', () => {
  it('a peer outside the quorum set is not followed; a v-blocking set of members is', async () => {
    const seed = 271;
    const names = ['A', 'B', 'C'];
    const ids = names.map((name) => new SimNode(seed, { name }).nodeId);
    const quorum = { mode: 'manual' as const, qset: { threshold: 2, validators: ids, innerSets: [] } };
    const sim = new Simulation({ seed, latency: [10, 60] });
    const [A, B, C] = await sim.addNodes(names.map((name) => ({ name, quorum })));
    expect(await sim.waitForLedger(5, 60_000)).toBe(true);

    // B and C leave: A cannot close ledgers (2 of 3) and stalls
    await sim.stopNode(B);
    await sim.stopNode(C);
    expect(await sim.runUntil(() => A.state === 'stalled', 60_000)).toBe(true);
    const start = A.lcl;
    const startHash = A.lclHash;
    // a peer outside A's quorum set announces 10 more ledgers on A's chain and serves them
    const pass = A.node!.passphrase;
    const evilKey = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(91));
    const lm = loadLedgerFromSnapshot(A.node!.ledger.snapshot(), pass);
    const fake = new Map<number, FakeLedger>();
    const fakeHashes = new Map<number, string>();
    for (let i = 0; i < 10; i++) {
      const prev = lm.lastClosed();
      const txSet = lm.makeTxSet(prev.hash, []);
      const r = lm.closeLedger(txSet, makeSignedStellarValue(lm.networkId, evilKey, txSet.hash, prev.header.scpValue.closeTime + 1));
      fake.set(r.header.ledgerSeq, { headerXdr: r.headerXdr, txSetXdr: txSet.xdr });
      fakeHashes.set(r.header.ledgerSeq, r.hash);
    }
    const target = { seq: start + 10, hash: lm.lastClosed().hash };
    const evil = liarOverlay(sim, evilKey, 'evil', { onRequest: (b) => serveChain(A, start, fake, b, target.seq) });
    evil.start();
    evil.setAnnouncement(ann('evil', target));
    await sim.run(60_000);
    expect(A.lcl, 'A did not follow a peer outside its quorum set').toBe(start);
    expect(A.lclHash).toBe(startHash);
    expect(A.closes.filter((x) => x.source === 'catchup')).toEqual([]);
    evil.stop();

    // B and C come back: the three close ledgers again on A's chain
    await sim.restartNode(B);
    await sim.restartNode(C);
    expect(await sim.waitForLedger(start + 3, 90_000, [A, B, C])).toBe(true);
    expect(A.chain.get(start + 1)).not.toBe(fakeHashes.get(start + 1));

    // C leaves; A and B (a v-blocking set for C: 2 of 3) go on; C comes back and follows them
    await sim.stopNode(C);
    const cAt = C.lcl;
    expect(await sim.waitForLedger(cAt + 8, 90_000, [A, B])).toBe(true);
    const back = sim.clock.now();
    await sim.restartNode(C);
    expect(await sim.runUntil(() => C.state === 'synced' && C.lcl >= A.lcl - 1, 60_000)).toBe(true);
    expect(C.closes.filter((x) => x.source === 'catchup' && x.at >= back).length).toBeGreaterThanOrEqual(5);
    expect(await sim.waitForLedger(Math.max(A.lcl, C.lcl) + 2, 60_000, [A, B, C])).toBe(true);
    expect(sim.conflicts([A, B, C])).toEqual([]);
    await sim.shutdown();
  });
});
