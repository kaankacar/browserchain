// Robustness against a single hostile peer that signs valid messages but
// lies about its chain (ARCHITECTURE 4: no trust in peers; auto mode favours
// liveness but must not let one outsider rewrite a healthy quorum's chain).
//
// The attacker is a real Overlay (own key, valid signatures). It announces a
// chain it does not have and answers history requests with fabricated or no
// data. The honest nodes must keep their chain and keep closing ledgers.

import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/hash';
import { Logger, LogSink } from '../lib/log';
import { deserializeEntry } from '../ledger/entries';
import { decodeLedgerHeader } from '../ledger/header';
import { createGenesisLedger, LedgerManager, loadLedgerFromSnapshot } from '../ledger/manager';
import { LedgerRoot } from '../ledger/state';
import type { AccountEntry } from '../ledger/types';
import { makeSignedStellarValue } from '../ledger/value';
import { Overlay } from '../overlay/overlay';
import type { AnnouncementFields } from '../overlay/overlay';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { Simulation, type SimNode } from './simulation';

/** A hostile overlay on the sim network: valid signatures, lying answers. */
function hostile(
  sim: Simulation,
  kp: Keypair,
  lcl: { seq: number; hash: string },
  onRequest: (b: RequestBody) => ResponseBody | null | Promise<ResponseBody | null>,
): Overlay {
  const ov = new Overlay({
    keypair: kp,
    networkId: sim.nodes[0].node!.networkIdHex,
    name: 'evil',
    clock: sim.clock,
    logger: new Logger(new LogSink(sim.clock, 'error'), 'evil'),
    transports: [sim.net.createTransport('evil')],
    handlers: { onStellarMessage: () => false, onRequest: (b) => onRequest(b) },
    announcement: { lcl, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' },
  });
  ov.start();
  return ov;
}

/** Close `n` empty ledgers on lm, values signed by kp. */
function extend(lm: LedgerManager, kp: Keypair, n: number, txs: (seq: number) => string[] = () => []) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lcl = lm.lastClosed();
    const txSet = lm.makeTxSet(lcl.hash, txs(lcl.header.ledgerSeq + 1));
    const v = makeSignedStellarValue(lm.networkId, kp, txSet.hash, lcl.header.scpValue.closeTime + 1);
    out.push(lm.closeLedger(txSet, v));
  }
  return out;
}

describe('a single hostile peer cannot subvert a healthy quorum', () => {
  it('A. a fabricated far-ahead snapshot is never installed', async () => {
    const sim = new Simulation({ seed: 77, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    const pass = nodes[0].node!.passphrase;
    const evil = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
    // a chain built from genesis in which friendbot channel 0 funds evil (the root is locked)
    const lm = createGenesisLedger(pass);
    const channel = Keypair.fromRawEd25519Seed(sha256(`${pass}|friendbot|0`));
    const pay = (seq: number) => {
      if (seq !== 3) return [];
      const tx = new TransactionBuilder(new Account(channel.publicKey(), '0'), { fee: '100', networkPassphrase: pass })
        .addOperation(Operation.createAccount({ destination: evil.publicKey(), startingBalance: '10000' }))
        .setTimeout(0)
        .build();
      tx.sign(channel);
      return [tx.toEnvelope().toXdr('base64')];
    };
    extend(lm, evil, 63, pay);
    const snap = JSON.stringify(lm.snapshot());
    const target = { seq: 64, hash: lm.lastClosed().hash };
    const ov = hostile(sim, evil, target, (b) => {
      if (b.kind === 'headers') return { kind: 'headers', items: [] };
      if (b.kind === 'snapshot') return { kind: 'snapshot', seq: 64, data: snap };
      return null;
    });
    const base = Math.max(...nodes.map((n) => n.lcl));
    expect(await sim.waitForLedger(base + 6, 90_000, nodes)).toBe(true);
    for (const n of nodes) {
      expect(n.node!.ledger.getAccount(evil.publicKey()), `${n.name} must not hold the fake state`).toBeUndefined();
      expect(n.lclHash).not.toBe(target.hash);
      // never loaded a snapshot from the liar
      expect(await n.storage.listSnapshotSeqs()).not.toContain(64);
    }
    // the honest quorum keeps closing its own ledgers and stays one chain
    expect(sim.conflicts()).toEqual([]);
    ov.stop();
    await sim.shutdown();
  });

  it('B. a fake branch with a huge claimed weight cannot capture the chain', async () => {
    const sim = new Simulation({ seed: 78, latency: [10, 60], logLevel: 'warn' });
    const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(8, 60_000)).toBe(true);
    const a = nodes[0];
    const evil = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(9));
    const L = a.lcl;
    // evil's own ledger L+1 on top of the honest L, funding itself so its tx
    // set (and header hash) differ from the honest L+1: a genuine fork
    const lm = loadLedgerFromSnapshot(a.node!.ledger.snapshot(), a.node!.passphrase);
    const channel = Keypair.fromRawEd25519Seed(sha256(`${a.node!.passphrase}|friendbot|0`)); // the root is locked
    const fund = new TransactionBuilder(new Account(channel.publicKey(), lm.getAccount(channel.publicKey())!.seqNum.toString()), { fee: '100', networkPassphrase: a.node!.passphrase })
      .addOperation(Operation.createAccount({ destination: evil.publicKey(), startingBalance: '10000' }))
      .setTimeout(0)
      .build();
    fund.sign(channel);
    const [fake] = extend(lm, evil, 1, () => [fund.toEnvelope().toXdr('base64')]);
    const target = { seq: L + 1, hash: fake.hash };
    expect(fake.hash).not.toBe(a.lclHash);
    const headerOf = async (seq: number) => (seq === L + 1 ? fake.headerXdr : (await a.storage.getLedger(seq))?.headerXdr);
    const ov = hostile(sim, evil, target, async (b) => {
      if (b.kind === 'headers') {
        const items = [];
        for (let s = b.from; s <= Math.min(b.to, L + 1); s++) {
          const h = await headerOf(s);
          if (h) items.push({ seq: s, headerXdr: h });
        }
        return { kind: 'headers', items };
      }
      if (b.kind === 'ledgers' && b.from <= L + 1 && b.to >= L + 1) {
        return { kind: 'ledgers', items: [{ seq: L + 1, headerXdr: fake.headerXdr, txSetXdr: fake.txSet.xdr }] };
      }
      // claim an astronomically heavy branch
      if (b.kind === 'branchWeight') return { kind: 'branchWeight', afterSeq: b.afterSeq, weight: 1_000_000, lcl: target };
      return null;
    });
    // the honest quorum keeps extending its own branch; let it run well past L+1
    expect(await sim.waitForLedger(L + 8, 90_000, nodes)).toBe(true);
    // evil's ledger L+1 never becomes the honest nodes' settled ledger L+1,
    // and evil's self-funding never takes effect
    for (const n of nodes) {
      expect(n.chain.get(L + 1), `${n.name} ledger ${L + 1}`).not.toBe(fake.hash);
      expect(n.node!.ledger.getAccount(evil.publicKey()), `${n.name} evil account`).toBeUndefined();
    }
    // the liar's branch was rejected on the spot (no rollback to it): nobody
    // known at the fork point vouches for it, and its absurd 1e6 weight
    // never decided the outcome
    expect(sim.recentLogs(500).some((l) => /vouch 3 for ours \(us included\), 0 for theirs -> keep ours/.test(l))).toBe(true);
    expect(sim.recentLogs(500).some((l) => /theirs 1000000@/.test(l))).toBe(false);
    expect(nodes.every((n) => n.forks.every((f) => f.resolution !== 'rolled-back'))).toBe(true);
    expect(sim.conflicts(nodes)).toEqual([]);
    ov.stop();
    await sim.shutdown();
  });

  it('C. a far-ahead peer that serves nothing does not stall the quorum', async () => {
    const sim = new Simulation({ seed: 79, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    const evil = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(5));
    const start = nodes[0].lcl;
    const ov = hostile(sim, evil, { seq: start + 500, hash: 'ab'.repeat(32) }, () => null);
    const closedBefore = nodes.map((n) => n.lcl);
    await sim.run(60_000);
    // the quorum keeps closing ledgers at the normal pace (~5 s) despite the liar
    for (let i = 0; i < nodes.length; i++) {
      expect(nodes[i].lcl - closedBefore[i], `${nodes[i].name} progress`).toBeGreaterThanOrEqual(8);
    }
    // and it is not flapping between synced and catching-up the whole time
    const flaps = nodes[0].states.filter((s) => s.at > sim.clock.now() - 60_000 && s.state === 'catching-up').length;
    expect(flaps).toBeLessThan(10);
    expect(sim.historyConflicts()).toEqual([]);
    ov.stop();
    await sim.shutdown();
  });

  it('D. a fake chain linked from our own LCL cannot install a snapshot with arbitrary balances', async () => {
    await forgedSnapshotAttack(601, 1);
  });

  it('F. two colluding identities serving the same fake chain cannot install it either', async () => {
    await forgedSnapshotAttack(602, 2);
  });

  it('E. a far-ahead peer that never answers and keeps moving its target does not slow the quorum', async () => {
    const sim = new Simulation({ seed: 79, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    const evil = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(13));
    const start = nodes[0].lcl;
    let n = 0;
    const ann = (): AnnouncementFields => ({
      name: 'evil',
      lcl: { seq: start + 500 + n, hash: (n % 2 ? 'ab' : 'cd').repeat(32) },
      state: 'synced',
      validator: true,
      qsetHash: '',
      quorumMode: 'auto',
    });
    const ov = new Overlay({
      keypair: evil,
      networkId: nodes[0].node!.networkIdHex,
      name: 'evil',
      clock: sim.clock,
      logger: new Logger(new LogSink(sim.clock, 'error'), 'evil'),
      transports: [sim.net.createTransport('evil')],
      // requests are never answered: every one runs into the full timeout
      handlers: { onStellarMessage: () => false, onRequest: () => new Promise<ResponseBody | null>(() => {}) },
      announcement: ann(),
    });
    ov.start();
    const move = () => {
      n++;
      ov.setAnnouncement(ann());
      sim.clock.setTimeout(move, 3000);
    };
    sim.clock.setTimeout(move, 3000);
    const before = nodes.map((x) => x.lcl);
    const t0 = sim.clock.now();
    await sim.run(120_000);
    // the normal pace is 24 ledgers in 120 s; a pause per target cost ~30%
    nodes.forEach((x, i) => expect(x.lcl - before[i], `${x.name} progress`).toBeGreaterThanOrEqual(22));
    for (const x of nodes) expect(x.states.filter((s) => s.at > t0 && s.state === 'catching-up')).toEqual([]);
    expect(sim.historyConflicts()).toEqual([]);
    ov.stop();
    await sim.shutdown();
  });
});

/**
 * Hostile identities follow the honest LCL: they extend it with their own
 * ledgers up to checkpoint 64, whose snapshot takes an honest user's whole
 * balance, and all announce that ledger. Every header links to our LCL, so
 * only the decision not to follow them can stop it.
 */
async function forgedSnapshotAttack(seed: number, identities: number): Promise<void> {
  const sim = new Simulation({ seed, latency: [10, 60] });
  const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
  expect(await sim.waitForLedger(4, 60_000)).toBe(true);
  const pass = nodes[0].node!.passphrase;
  const victim = Keypair.fromRawEd25519Seed(sha256(`hostile-peers|victim|${seed}`));
  expect((await nodes[0].node!.friendbot(victim.publicKey())).status).toBe('PENDING');
  expect(await sim.runUntil(() => nodes.every((n) => n.node!.ledger.getAccount(victim.publicKey()) !== undefined), 60_000)).toBe(true);
  const funded = nodes[0].node!.ledger.getAccount(victim.publicKey())!.balance;
  const keys = Array.from({ length: identities }, (_, i) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(11 + i)));
  let fake: { start: number; startHash: string; headers: Map<number, string>; snap: string; target: { seq: number; hash: string } } | null = null;
  let snapshotRequests = 0;
  const overlays: Overlay[] = [];
  const ann = (name: string, lcl: { seq: number; hash: string }): AnnouncementFields => ({ name, lcl, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' });
  const build = (src: SimNode) => {
    const lcl = src.node!.ledger.lastClosed();
    if ((fake && fake.startHash === lcl.hash) || lcl.header.ledgerSeq >= 62) return;
    let lm = loadLedgerFromSnapshot(src.node!.ledger.snapshot(), pass);
    const headers = new Map<number, string>();
    const close = () => {
      const prev = lm.lastClosed();
      const txSet = lm.makeTxSet(prev.hash, []);
      const r = lm.closeLedger(txSet, makeSignedStellarValue(lm.networkId, keys[0], txSet.hash, prev.header.scpValue.closeTime + 1));
      headers.set(r.header.ledgerSeq, r.headerXdr);
      return r;
    };
    while (lm.lastClosed().header.ledgerSeq < 63) close();
    const snap63 = lm.snapshot();
    const entries = snap63.entries.map(deserializeEntry);
    for (const e of entries) if (e.kind === 'account' && (e as AccountEntry).accountId === victim.publicKey()) (e as AccountEntry).balance = 0n;
    lm = new LedgerManager(pass, new LedgerRoot(entries), decodeLedgerHeader(snap63.headerXdr));
    const r64 = close();
    fake = { start: lcl.header.ledgerSeq, startHash: lcl.hash, headers, snap: JSON.stringify(lm.snapshot()), target: { seq: 64, hash: r64.hash } };
    overlays.forEach((ov, i) => ov.setAnnouncement(ann(`evil${i}`, fake!.target)));
  };
  keys.forEach((kp, i) => {
    const ov = new Overlay({
      keypair: kp,
      networkId: nodes[0].node!.networkIdHex,
      name: `evil${i}`,
      clock: sim.clock,
      logger: new Logger(new LogSink(sim.clock, 'error'), `evil${i}`),
      transports: [sim.net.createTransport(`evil${i}`)],
      handlers: {
        onStellarMessage: () => false,
        onPeerStatus: (p) => {
          const sn = nodes.find((n) => n.nodeId === p.nodeId);
          if (sn?.running) build(sn);
        },
        onRequest: async (b, from) => {
          const sn = nodes.find((n) => n.nodeId === from.nodeId);
          if (!sn || !fake) return null;
          if (b.kind === 'headers') {
            const items = [];
            for (let s = b.from; s <= Math.min(b.to, b.from + 63, 64); s++) {
              const h = s <= fake.start ? (await sn.node!.chain.getLedger(s))?.headerXdr : fake.headers.get(s);
              if (h) items.push({ seq: s, headerXdr: h });
            }
            return { kind: 'headers', items };
          }
          if (b.kind === 'snapshot') {
            snapshotRequests++;
            return { kind: 'snapshot', seq: 64, data: fake.snap };
          }
          return null;
        },
      },
      announcement: ann(`evil${i}`, { seq: 1, hash: '00'.repeat(32) }),
    });
    overlays.push(ov);
  });
  for (const ov of overlays) ov.start();
  build(nodes[0]);
  const base = Math.max(...nodes.map((n) => n.lcl));
  expect(await sim.waitForLedger(base + 8, 90_000, nodes)).toBe(true);
  expect(snapshotRequests).toBe(0);
  for (const n of nodes) {
    expect(n.node!.ledger.getAccount(victim.publicKey())!.balance, `${n.name} victim balance`).toBe(funded);
    expect(await n.storage.listSnapshotSeqs()).not.toContain(64);
    expect(n.forks.every((f) => f.resolution !== 'rolled-back')).toBe(true);
  }
  expect(sim.recentLogs(500).some((l) => /not following evil\d to ledger 64/.test(l))).toBe(true);
  expect(sim.historyConflicts()).toEqual([]);
  for (const ov of overlays) ov.stop();
  await sim.shutdown();
}
