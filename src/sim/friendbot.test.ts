// Friendbot under concurrent use: several nodes fund many accounts at the
// same moment. Every request must end with a funded account.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { FRIENDBOT_AMOUNT } from '../lib/constants';
import { sha256 } from '../lib/hash';
import type { TxStatusEvent } from '../herder/types';
import { Simulation } from './simulation';

function user(tag: string, i: number): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`friendbot-sim|${tag}|${i}`));
}

describe('simulation: friendbot under concurrent use', () => {
  it('4 nodes x 8 simultaneous calls: every account is funded, no friendbot tx is dropped', async () => {
    const sim = new Simulation({ seed: 41, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd'].map((name) => ({ name })));
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    const statuses: TxStatusEvent[] = [];
    for (const n of nodes) n.node!.events.on('txStatus', (e) => statuses.push(e));

    const users = nodes.map((n) => Array.from({ length: 8 }, (_, i) => user(n.name, i)));
    const hashes: string[] = [];
    // all 32 calls at the same virtual time: nobody has seen the others' txs yet
    const results = await Promise.all(nodes.flatMap((n, k) => users[k].map((u) => n.node!.friendbot(u.publicKey()))));
    for (const r of results) {
      expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
      hashes.push(r.hash);
    }
    const all = users.flat();
    const funded = () => nodes.every((n) => all.every((u) => n.node!.ledger.getAccount(u.publicKey()) !== undefined));
    const ok = await sim.runUntil(funded, 60_000);
    const fundedCount = all.filter((u) => nodes[0].node!.ledger.getAccount(u.publicKey()) !== undefined).length;
    const dropped = statuses.filter((s) => s.status === 'dropped' && hashes.includes(s.hash));
    expect({ ok, fundedCount }).toEqual({ ok: true, fundedCount: 32 });
    expect(dropped.map((d) => d.resultCode)).toEqual([]);
    for (const u of all) expect(nodes[0].node!.ledger.getAccount(u.publicKey())!.balance).toBe(FRIENDBOT_AMOUNT);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('a request that loses its sequence number is reported dropped and retried once with a new tx', async () => {
    const sim = new Simulation({ seed: 42, latency: [10, 60], logLevel: 'info' });
    const vals = await sim.addNodes(['v0', 'v1', 'v2'].map((name) => ({ name })));
    // a watcher owns no channel: it falls back to hashing, onto a channel a validator owns
    const w = await sim.addNode({ name: 'w', validating: false });
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    const nodes = [...vals, w];
    const statuses: TxStatusEvent[] = [];
    for (const n of nodes) n.node!.events.on('txStatus', (e) => statuses.push(e));

    // six calls per validator use every channel at the next sequence number
    const calls = vals.flatMap((v) => Array.from({ length: 6 }, (_, i) => ({ n: v, u: user(v.name, i) })));
    calls.push({ n: w, u: user('w', 0) });
    const results = await Promise.all(calls.map((c) => c.n.node!.friendbot(c.u.publicKey())));
    expect(results.every((r) => r.status === 'PENDING')).toBe(true);
    const hashes = new Set(results.map((r) => r.hash));

    const all = calls.map((c) => c.u.publicKey());
    const funded = () => nodes.every((n) => all.every((id) => n.node!.ledger.getAccount(id) !== undefined));
    expect(await sim.runUntil(funded, 60_000)).toBe(true);
    for (const id of all) expect(w.node!.ledger.getAccount(id)!.balance).toBe(FRIENDBOT_AMOUNT);
    // the collision: one of the two txs lost its sequence number; the UI sees
    // 'dropped' for the hash it got, and the account is funded by the retry
    const dropped = [...new Set(statuses.filter((s) => s.status === 'dropped' && hashes.has(s.hash)).map((s) => s.hash))];
    expect(dropped.length).toBe(1);
    expect(statuses.find((s) => s.hash === dropped[0] && s.status === 'dropped')!.resultCode).toBe('txBAD_SEQ');
    expect(sim.recentLogs(500, 'info').some((l) => /friendbot: tx .* was dropped \(txBAD_SEQ\); retried as/.test(l))).toBe(true);
    await sim.run(15_000);
    for (const n of nodes) expect(n.node!.herder.txQueue.size()).toBe(0);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });
});
