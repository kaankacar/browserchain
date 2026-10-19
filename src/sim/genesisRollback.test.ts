// Rollbacks to a fork point at genesis, and winning branches that do not
// replay (ARCHITECTURE 12.2, 12.3).
// - New identities with a chain that forks right after genesis do not win
//   the fork verdict against a quorum (only validators known at the fork
//   point vouch).
// - A node that had a chain beyond genesis catches up by replay, also after
//   it rolled back to ledger 1. Otherwise a winning branch from genesis
//   could bring a forged snapshot along.
// - When the winning branch does not replay, the node reloads its stored
//   ledger and does not follow that branch again until it moves.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/hash';
import { Logger, LogSink } from '../lib/log';
import { deserializeEntry, serializeEntry } from '../ledger/entries';
import { decodeLedgerHeader } from '../ledger/header';
import { createGenesisLedger, LedgerManager } from '../ledger/manager';
import { LedgerRoot } from '../ledger/state';
import type { AccountEntry } from '../ledger/types';
import { makeSignedStellarValue } from '../ledger/value';
import { Overlay } from '../overlay/overlay';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { Simulation, type SimNode } from './simulation';

/**
 * Honest nodes (three by default) and two liars. The liars announce ledger
 * 64 of a chain forked after genesis: empty ledgers 2..63, then ledger 64
 * whose state gives the victim nothing and evil 1,000,000 XLM. They serve
 * its headers, ledgers and snapshot, and claim a heavy branch.
 */
async function forgedGenesisBranch(seed: number, names = ['a', 'b', 'c']) {
  const sim = new Simulation({ seed, latency: [10, 60] });
  const nodes = await sim.addNodes(names.map((name) => ({ name })));
  expect(await sim.waitForLedger(6, 60_000)).toBe(true);
  const pass = nodes[0].node!.passphrase;
  const victim = Keypair.fromRawEd25519Seed(sha256(`genesis-rollback|victim|${seed}`));
  expect((await nodes[0].node!.friendbot(victim.publicKey())).status).toBe('PENDING');
  expect(await sim.runUntil(() => nodes.every((n) => n.node!.ledger.getAccount(victim.publicKey()) !== undefined), 60_000)).toBe(true);

  const keys = [121, 122].map((b) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(b)));
  const evil = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(120));
  let lm = createGenesisLedger(pass);
  const ledgers = new Map<number, { headerXdr: string; txSetXdr: string }>([[1, { headerXdr: lm.lastClosed().headerXdr, txSetXdr: '' }]]);
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
  const account = serializeEntry(entries.find((e) => e.kind === 'account') as AccountEntry);
  entries.push(deserializeEntry({ ...account, accountId: victim.publicKey(), balance: '0' } as never));
  entries.push(deserializeEntry({ ...account, accountId: evil.publicKey(), balance: '10000000000000' } as never));
  lm = new LedgerManager(pass, new LedgerRoot(entries), decodeLedgerHeader(snap63.headerXdr));
  const target = { seq: 64, hash: close().hash };
  const snap = JSON.stringify(lm.snapshot());
  const requests = { snapshot: 0 };
  const answer = (b: RequestBody): ResponseBody | null => {
    if (b.kind === 'snapshot') {
      requests.snapshot++;
      return { kind: 'snapshot', seq: 64, data: snap };
    }
    // a heavy branch: the weight clamp still lets two identities win the verdict
    if (b.kind === 'branchWeight') return { kind: 'branchWeight', afterSeq: b.afterSeq, weight: 1_000_000, lcl: target };
    if (b.kind !== 'headers' && b.kind !== 'ledgers') return null;
    const items = [];
    for (let s = Math.max(1, b.from); s <= Math.min(b.to, b.from + 63, 64); s++) items.push({ seq: s, ...ledgers.get(s)! });
    return b.kind === 'headers' ? { kind: 'headers', items: items.map((i) => ({ seq: i.seq, headerXdr: i.headerXdr })) } : { kind: 'ledgers', items: items.filter((i) => i.seq > 1) };
  };
  const liars = keys.map(
    (kp, i) =>
      new Overlay({
        keypair: kp,
        networkId: nodes[0].node!.networkIdHex,
        name: `evil${i}`,
        clock: sim.clock,
        logger: new Logger(new LogSink(sim.clock, 'error'), `evil${i}`),
        transports: [sim.net.createTransport(`evil${i}`)],
        handlers: { onStellarMessage: () => false, onRequest: answer },
        announcement: { lcl: target, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' },
      }),
  );
  for (const ov of liars) ov.start();
  const stop = async () => {
    for (const ov of liars) ov.stop();
    await sim.shutdown();
  };
  return { sim, nodes, victim, evil, target, requests, stop };
}

describe('rollback to genesis', () => {
  it('two liars with a chain forked after genesis neither win the fork verdict nor install a forged snapshot', async () => {
    const { sim, nodes, victim, evil, target, requests, stop } = await forgedGenesisBranch(641);
    const before = new Map(nodes[0].chain);
    const h0 = Math.max(...before.keys());
    await sim.run(60_000);
    // the liars were first seen long after ledger 1: they vouch for nothing
    for (const n of nodes) {
      expect(n.forks.filter((f) => f.resolution === 'rolled-back'), `${n.name} rollbacks`).toEqual([]);
      for (let s = 2; s <= h0; s++) expect(n.chain.get(s), `${n.name} ledger ${s}`).toBe(before.get(s));
    }
    expect(nodes.some((n) => n.forks.some((f) => f.resolution === 'kept-ours' && f.atSeq === 2))).toBe(true);
    // and none of them loaded the forged snapshot
    expect(requests.snapshot).toBe(0);
    for (const n of nodes) {
      expect(n.node!.ledger.getAccount(evil.publicKey()), `${n.name} evil account`).toBeUndefined();
      expect(n.node!.ledger.getAccount(victim.publicKey())?.balance, `${n.name} victim balance`).not.toBe(0n);
      expect(n.chain.get(64), `${n.name} ledger 64`).not.toBe(target.hash);
    }
    await stop();
  });

  it('a winning branch that does not replay: the node reloads its stored ledger and goes on', async () => {
    // a lone validator that never had a member: the weights decide its fork
    // verdicts, so the liars' heavy branch wins, and its ledger 64 does not replay
    const { sim, nodes, stop } = await forgedGenesisBranch(643, ['a']);
    // every 100 ms: a node in sync runs on a ledger it stored (as a ledger or a snapshot)
    const stored = async (n: SimNode, seq: number, hash: string) => {
      if ((await n.storage.getLedger(seq))?.hash === hash) return true;
      const snap = await n.storage.getSnapshot(seq);
      return snap !== undefined && (JSON.parse(snap) as { hash: string }).hash === hash;
    };
    const unstored: string[] = [];
    for (let t = 0; t < 600; t++) {
      await sim.run(100);
      for (const n of nodes) {
        if (n.state !== 'synced' && n.state !== 'stalled') continue;
        const lcl = n.node!.ledger.lastClosed();
        if (!(await stored(n, lcl.header.ledgerSeq, lcl.hash))) unstored.push(`${n.name}@${lcl.header.ledgerSeq}`);
      }
    }
    expect(unstored.slice(0, 5), `${unstored.length} samples in sync on a ledger that is not stored`).toEqual([]);
    expect(sim.recentLogs(2000).some((l) => /replay of ledger 64 gave/.test(l))).toBe(true);
    // the honest nodes do not follow the forged ledger 64 again, and keep closing ledgers
    expect(await sim.waitForLedger(70, 60_000, nodes)).toBe(true);
    expect(sim.conflicts(nodes)).toEqual([]);
    await stop();
  });

  it('a node that loses a fork at genesis replays the winning chain from ledger 2', async () => {
    const sim = new Simulation({ seed: 642, latency: [10, 60] });
    sim.net.partition([['a'], ['b']]);
    const a = await sim.addNode({ name: 'a' });
    expect(await sim.runUntil(() => a.lcl >= 70, 600_000)).toBe(true);
    const b: SimNode = await sim.addNode({ name: 'b' });
    expect(await sim.runUntil(() => b.lcl >= 4, 60_000)).toBe(true);
    expect(b.chain.get(2)).not.toBe(a.chain.get(2));
    const healed = sim.clock.now();
    sim.heal();
    // a's branch is heavier: b rolls back to ledger 1 and follows a
    expect(await sim.runUntil(() => b.forks.some((f) => f.resolution === 'rolled-back' && f.atSeq === 2), 60_000)).toBe(true);
    expect(await sim.runUntil(() => b.state === 'synced' && b.lcl >= a.lcl - 1 && sim.conflicts([a, b]).length === 0, 120_000)).toBe(true);
    // by replay, not from a's snapshot
    const replayed = b.closes.filter((x) => x.source === 'catchup' && x.at >= healed).map((x) => x.seq);
    expect(Math.min(...replayed)).toBe(2);
    expect(replayed).toContain(64);
    expect(await sim.waitForLedger(Math.max(a.lcl, b.lcl) + 2, 60_000, [a, b])).toBe(true);
    expect(sim.conflicts([a, b])).toEqual([]);
    await sim.shutdown();
  });
});
