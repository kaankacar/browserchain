// Friendbot under normal load, with no attacker (ARCHITECTURE 10.2, 11).
// Transactions from peers may hold only a few of a friendbot channel's queue
// slots, so that an attacker cannot take the slots of this node's own
// requests. A node makes its own requests on the channels it owns. Review
// case: the cap applied to every channel. Every other node then refused the
// 5th and later request that a node queued on one of its channels. Bulk
// requests at a validator took 7 to 11 ledgers instead of 3, and a watcher,
// which never builds a tx set, lost them (they aged out unfunded).

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/hash';
import type { TxStatusEvent } from '../herder/types';
import { Simulation, type SimNode } from './simulation';

/** Make `count` friendbot requests at `n` at once. Returns the new accounts and the dropped request txs. */
async function requestAll(n: SimNode, count: number, tag: string): Promise<{ users: string[]; dropped: string[] }> {
  const users = Array.from({ length: count }, (_, i) => Keypair.fromRawEd25519Seed(sha256(`fb-load|${tag}|${i}`)).publicKey());
  const hashes = new Set<string>();
  const dropped: string[] = [];
  n.node!.events.on('txStatus', (e: TxStatusEvent) => {
    if (e.status === 'dropped' && hashes.has(e.hash)) dropped.push(`${e.hash.slice(0, 8)} ${e.resultCode ?? ''}`);
  });
  const results = await Promise.all(users.map((u) => n.node!.friendbot(u)));
  for (const r of results) {
    expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
    hashes.add(r.hash);
  }
  return { users, dropped };
}

function fundedOn(n: SimNode, users: string[]): number {
  return users.filter((u) => n.node!.ledger.getAccount(u) !== undefined).length;
}

describe('simulation: friendbot under normal load', () => {
  for (const seed of [9402, 9403]) {
    it(`40 requests at one of 4 validators are funded within 5 ledgers (seed ${seed})`, async () => {
      const sim = new Simulation({ seed, latency: [10, 60] });
      const nodes = await sim.addNodes(['v0', 'v1', 'v2', 'v3'].map((name) => ({ name })));
      expect(await sim.waitForLedger(4, 60_000)).toBe(true);
      await sim.run(6_000);
      const start = nodes[0].lcl;
      const { users, dropped } = await requestAll(nodes[0], 40, `v-${seed}`);
      // the lane takes 16 a ledger: 3 ledgers when every node can include them
      expect(await sim.runUntil(() => nodes.every((n) => fundedOn(n, users) === users.length), 60_000, 250)).toBe(true);
      expect(nodes[0].lcl - start, 'ledgers until all were funded').toBeLessThanOrEqual(5);
      expect(dropped).toEqual([]);
      expect(sim.historyConflicts()).toEqual([]);
      await sim.shutdown();
    });
  }

  it("a watcher's 40 requests are all funded", async () => {
    const sim = new Simulation({ seed: 9701, latency: [10, 60] });
    const vals = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    const w = await sim.addNode({ name: 'w', validating: false });
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    await sim.run(6_000);
    const { users, dropped } = await requestAll(w, 40, 'watcher');
    expect(await sim.runUntil(() => [...vals, w].every((n) => fundedOn(n, users) === users.length), 90_000, 250)).toBe(true);
    expect(dropped).toEqual([]);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });
});
