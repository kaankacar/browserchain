// Scenarios 1 and 2: a single node alone, and four nodes with 20-150 ms latency.

import { describe, expect, it } from 'vitest';
import { LEDGER_TARGET_CLOSE_MS } from '../lib/constants';
import { Simulation } from './simulation';

describe('simulation: basic consensus', () => {
  it('1. a single node closes ledgers every ~5 s alone', async () => {
    const sim = new Simulation({ seed: 1 });
    const [a] = await sim.addNodes([{ name: 'solo' }]);
    // boot: 4 s without peers, then synced alone
    expect(await sim.waitForSynced(10_000)).toBe(true);
    expect(await sim.waitForLedger(12, 120_000)).toBe(true);
    const closes = a.consensusCloses();
    expect(closes.length).toBeGreaterThanOrEqual(10);
    const gaps = closes.slice(1).map((c, i) => c.at - closes[i].at);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(LEDGER_TARGET_CLOSE_MS - 50);
      expect(g).toBeLessThanOrEqual(LEDGER_TARGET_CLOSE_MS + 500);
    }
    // the node is its own quorum
    expect(a.node!.herder.scp.getLocalQuorumSet()).toEqual({ threshold: 1, validators: [a.nodeId], innerSets: [] });
    expect(closes.every((c) => c.externalizedBy === 1)).toBe(true);
    // ledgers are persisted, with a strictly increasing close time
    const stored = await a.storage.getLedgers(1, a.lcl);
    expect(stored.map((l) => l.seq)).toEqual(Array.from({ length: a.lcl }, (_, i) => i + 1));
    for (let i = 2; i < stored.length; i++) expect(stored[i].closeTime).toBeGreaterThan(stored[i - 1].closeTime);
    await sim.shutdown();
  });

  it('2. four nodes, latency 20-150 ms: 30 ledgers with identical hashes', async () => {
    const sim = new Simulation({ seed: 2, latency: [20, 150] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd'].map((name) => ({ name })));
    expect(await sim.waitForLedger(31, 30 * 8_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    expect(sim.conflicts()).toEqual([]);
    for (const n of nodes) {
      // every node took part in consensus for (almost) every ledger
      expect(n.consensusCloses().length).toBeGreaterThanOrEqual(28);
      expect(n.forks).toEqual([]);
      const q = n.node!.herder.scp.getLocalQuorumSet();
      expect(q.validators.length).toBe(4);
      expect(q.threshold).toBe(3);
    }
    // ledgers close about every 5 s
    const a = nodes[0].consensusCloses();
    const span = a[a.length - 1].at - a[0].at;
    expect(span / (a.length - 1)).toBeLessThan(LEDGER_TARGET_CLOSE_MS * 1.3);
    await sim.shutdown();
  });
});
