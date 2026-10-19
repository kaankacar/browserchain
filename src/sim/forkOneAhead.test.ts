// A fork with a peer one ledger ahead (ARCHITECTURE 12.2, 12.3). Two solo
// nodes built separate chains; b restarts and finds a one ledger ahead. The
// catch-up used to leave a peer one ledger ahead to SCP without checking that
// its ledger builds on ours. When a lost the fork verdict and rolled back
// onto b's chain, b never checked the fork and never reported it (seen in
// e2e/fork.spec.ts once WebRTC tabs boot later). A fork is reported on both
// sides, whichever wins.

import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';

describe('simulation: a fork with a peer one ledger ahead', () => {
  for (const seed of [931, 932, 933, 934, 935, 936]) {
    it(`a node that restarts one ledger behind a peer on another branch checks the fork and reports it (seed ${seed})`, async () => {
      const sim = new Simulation({ seed, latency: [5, 25] });
      sim.net.partition([['a'], ['b']]);
      const a = await sim.addNode({ name: 'a' });
      await sim.run(2_500);
      const b = await sim.addNode({ name: 'b' });
      // each closes its own ledgers until a is exactly one ahead
      expect(await sim.runUntil(() => b.lcl >= 4 && a.lcl === b.lcl + 1, 120_000, 50)).toBe(true);
      await sim.stopNode(b);
      sim.heal();
      await sim.restartNode(b);
      expect(await sim.runUntil(() => a.lclHash === b.lclHash && a.state === 'synced' && b.state === 'synced' && a.lcl >= 8, 90_000)).toBe(true);
      const outcomes = [...a.forks, ...b.forks].map((f) => f.resolution).sort();
      expect(outcomes, `a: ${a.forks.map((f) => f.resolution)}, b: ${b.forks.map((f) => f.resolution)}`).toEqual(['kept-ours', 'rolled-back']);
      for (const f of [...a.forks, ...b.forks]) expect(f.atSeq).toBe(2);
      expect(await sim.waitForLedger(a.lcl + 2, 30_000)).toBe(true);
      expect(sim.conflicts()).toEqual([]);
      await sim.shutdown();
    });
  }
});
