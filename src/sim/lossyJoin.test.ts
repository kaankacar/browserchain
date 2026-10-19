// A newcomer whose only catch-up source is one peer, on a lossy network:
// some requests time out. One lost message must not end its catch-up, or it
// becomes synced far behind, votes alone and closes a chain of its own.

import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';

describe('simulation: catch-up from a single source over a lossy network', () => {
  for (const seed of [302, 303, 306]) {
    it(`seed ${seed}: the newcomer catches up and never closes a ledger off the chain`, async () => {
      const sim = new Simulation({ seed, latency: [10, 60] });
      const [a] = await sim.addNodes([{ name: 'a' }]);
      expect(await sim.waitForLedger(150, 900_000)).toBe(true);
      sim.net.setDropRate(0.15);
      const b = await sim.addNode({ name: 'b' });
      const synced = () => b.state === 'synced' && b.lcl >= a.lcl - 1 && b.chain.get(b.lcl) === a.chain.get(b.lcl);
      expect(await sim.runUntil(synced, 120_000)).toBe(true);
      expect(b.closes.filter((c) => c.source === 'consensus' && a.chain.get(c.seq) !== c.hash)).toEqual([]);
      expect(a.forks.filter((f) => f.resolution === 'rolled-back')).toEqual([]);
      await sim.shutdown();
    });
  }
});
