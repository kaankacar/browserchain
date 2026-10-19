// After a rollback, the node re-submits the transactions of its discarded
// ledgers. One that cannot be queued again (here: its sequence number was
// used by another tx on the winning branch) must be reported 'dropped', so
// the wallet does not keep it as applied or show it as 'Unknown'.

import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/hash';
import type { TxStatusEvent } from '../herder/types';
import { Simulation, type SimNode } from './simulation';

function key(tag: string): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`rollback-requeue|${tag}`));
}

/** U creates `dest` (10 XLM), with U's next sequence number on `n`'s ledger. */
function createFrom(n: SimNode, u: Keypair, dest: Keypair): string {
  const node = n.node!;
  const acct = node.ledger.getAccount(u.publicKey())!;
  const tx = new TransactionBuilder(new Account(u.publicKey(), acct.seqNum.toString()), { fee: '100', networkPassphrase: node.passphrase })
    .addOperation(Operation.createAccount({ destination: dest.publicKey(), startingBalance: '10' }))
    .setTimeout(0)
    .build();
  tx.sign(u);
  return tx.toEnvelope().toXdr('base64');
}

describe('simulation: rollback and re-queue', () => {
  it('a discarded tx that cannot be queued again is reported dropped with its result code', async () => {
    const sim = new Simulation({ seed: 211, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    const [a, b, c] = nodes;
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    const u = key('user');
    expect((await a.node!.friendbot(u.publicKey())).status).toBe('PENDING');
    expect(await sim.runUntil(() => nodes.every((n) => n.node!.ledger.getAccount(u.publicKey()) !== undefined), 60_000)).toBe(true);

    // c alone on one side, a and b (the heavier branch) on the other
    sim.partition([[a, b], [c]]);
    const split = Math.max(...nodes.map((n) => n.lcl));
    expect(await sim.runUntil(() => nodes.every((n) => n.lcl >= split + 3), 90_000)).toBe(true);

    // the same sequence number of U on both sides
    const p = key('p');
    const q = key('q');
    const lost = await c.node!.submitTransaction(createFrom(c, u, p));
    const kept = await a.node!.submitTransaction(createFrom(a, u, q));
    expect([lost.status, kept.status]).toEqual(['PENDING', 'PENDING']);
    expect(
      await sim.runUntil(
        () => c.node!.ledger.getAccount(p.publicKey()) !== undefined && [a, b].every((n) => n.node!.ledger.getAccount(q.publicKey()) !== undefined),
        60_000,
      ),
    ).toBe(true);

    const statuses: TxStatusEvent[] = [];
    c.node!.events.on('txStatus', (e) => statuses.push(e));
    sim.heal();
    const converged = () => {
      const lcl = Math.min(...nodes.map((n) => n.lcl));
      return sim.conflicts(nodes).length === 0 && new Set(nodes.map((n) => n.chain.get(lcl))).size === 1 && nodes.every((n) => n.state === 'synced');
    };
    expect(await sim.runUntil(() => converged() && c.forks.some((f) => f.resolution === 'rolled-back'), 120_000)).toBe(true);
    await sim.run(2_000);

    // the winning branch has q, not p: c's tx is gone for good and says so
    expect(c.node!.ledger.getAccount(p.publicKey())).toBeUndefined();
    expect(c.node!.ledger.getAccount(q.publicKey())).toBeDefined();
    const dropped = statuses.filter((e) => e.hash === lost.hash && e.status === 'dropped');
    expect(dropped.map((e) => e.resultCode)).toEqual(['txBAD_SEQ']);
    // a tx of the discarded ledgers that the winning branch applied is not reported dropped
    expect(statuses.filter((e) => e.hash === kept.hash && e.status === 'dropped')).toEqual([]);
    expect(sim.conflicts()).toEqual([]);
    await sim.shutdown();
  });
});
