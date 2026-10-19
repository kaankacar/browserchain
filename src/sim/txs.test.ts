// Scenarios 10 and 11: transactions through the network, and a Byzantine validator.

import { Account, Asset, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { formatAmount } from '../lib/amount';
import { FRIENDBOT_AMOUNT } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { pick, randInt, seededRng } from '../lib/random';
import { equivocator, type ByzantineStats } from './byzantine';
import { Simulation, type SimNode } from './simulation';

function user(i: number): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`sim-user-${i}`));
}

describe('simulation: transactions and Byzantine validators', () => {
  it('10. friendbot and random payments at random nodes are included; balances match everywhere', async () => {
    const sim = new Simulation({ seed: 10, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd'].map((name) => ({ name })));
    const rng = seededRng(1010);
    expect(await sim.waitForLedger(3, 60_000)).toBe(true);

    const users = Array.from({ length: 6 }, (_, i) => user(i));
    const submitted = new Set<string>();
    for (const u of users) {
      const at = pick(rng, nodes);
      const r = await at.node!.friendbot(u.publicKey());
      expect(r.status).toBe('PENDING');
      submitted.add(r.hash);
      await sim.run(300);
    }
    // top up one account a second time (Payment instead of CreateAccount)
    const again = await nodes[0].node!.friendbot(users[0].publicKey());
    expect(again.status).toBe('PENDING');
    submitted.add(again.hash);
    const funded = () => nodes.every((n) => users.every((u) => n.node!.ledger.getAccount(u.publicKey()) !== undefined));
    expect(await sim.runUntil(funded, 60_000)).toBe(true);

    // random payments, one every 400 ms, each submitted at a random node
    const nextSeq = new Map<string, bigint>();
    const passphrase = nodes[0].node!.passphrase;
    for (let k = 0; k < 40; k++) {
      const from = users[randInt(rng, 0, users.length - 1)];
      let to = users[randInt(rng, 0, users.length - 1)];
      if (to === from) to = users[(users.indexOf(from) + 1) % users.length];
      const at: SimNode = pick(rng, nodes);
      const id = from.publicKey();
      const seq = nextSeq.get(id) ?? at.node!.ledger.getAccount(id)!.seqNum + 1n;
      nextSeq.set(id, seq + 1n);
      const tx = new TransactionBuilder(new Account(id, (seq - 1n).toString()), { fee: '100', networkPassphrase: passphrase })
        .addOperation(Operation.payment({ destination: to.publicKey(), asset: Asset.native(), amount: `${randInt(rng, 1, 50)}.5` }))
        .setTimeout(0)
        .build();
      tx.sign(from);
      const r = await at.node!.submitTransaction(tx.toEnvelope().toXdr('base64'));
      expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
      submitted.add(r.hash);
      await sim.run(400);
    }
    // every transaction is applied on every node
    const applied = async () => {
      for (const n of nodes) for (const h of submitted) if (!(await n.storage.getTx(h))?.successful) return false;
      return true;
    };
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      await sim.run(1_000);
      done = await applied();
    }
    expect(done).toBe(true);
    // all nodes at the same ledger have the same balances (and the same header hash)
    const lcl = Math.min(...nodes.map((n) => n.lcl));
    expect(await sim.runUntil(() => nodes.every((n) => n.lcl === lcl + 1), 30_000)).toBe(true);
    expect(new Set(nodes.map((n) => n.lclHash)).size).toBe(1);
    for (const u of users) {
      const balances = new Set(nodes.map((n) => n.node!.ledger.getAccount(u.publicKey())!.balance));
      expect(balances.size).toBe(1);
    }
    const total = users.reduce((s, u) => s + nodes[0].node!.ledger.getAccount(u.publicKey())!.balance, 0n);
    // 7 friendbot fundings minus the fees of 40 payments
    expect(total).toBe(7n * FRIENDBOT_AMOUNT - 40n * 100n);
    expect(formatAmount(nodes[0].node!.ledger.lastClosed().header.feePool)).not.toBe('0.0000000');
    expect(sim.historyConflicts()).toEqual([]);
    for (const n of nodes) expect(n.node!.herder.txQueue.size()).toBe(0);
    await sim.shutdown();
  });

  it('11. a Byzantine validator signing conflicting nominations and ballots: honest nodes stay safe and live', async () => {
    for (const seed of [111, 112, 113]) {
      const sim = new Simulation({ seed, latency: [10, 80] });
      const stats: ByzantineStats = { equivocations: 0 };
      const honest = await sim.addNodes(['h1', 'h2', 'h3', 'h4'].map((name) => ({ name })));
      await sim.addNode({ name: 'byz', emitInterceptor: equivocator({ ballots: true }, stats) });
      expect(await sim.waitForLedger(16, 16 * 12_000, honest)).toBe(true);
      expect(stats.equivocations).toBeGreaterThan(20);
      expect(sim.historyConflicts(honest)).toEqual([]);
      expect(sim.conflicts(honest)).toEqual([]);
      for (const n of honest) expect(n.forks).toEqual([]);
      await sim.shutdown();
    }
  });
});
