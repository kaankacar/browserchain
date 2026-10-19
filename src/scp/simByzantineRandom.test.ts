// SCP simulation with Byzantine nodes that also send random well-formed
// statements (counter 0 prepared ballots, nPrepared < nH, UINT32_MAX
// counters, equivocation) built from values they have seen. Honest nodes
// must stay safe and live, and SCP must never throw at them.

import { describe, expect, it } from 'vitest';
import { checkByzantineRun, runByzantine } from './simByzantineKit';

describe('Byzantine nodes sending random statements', () => {
  it('N=4 (f=1), unsigned: 60 seeds x 20 slots, no exception at honest nodes', async () => {
    // before the counter 0 fix, seeds 57, 91, 100 and 101 threw "b.n != 0" at an honest node
    for (let seed = 51; seed <= 110; seed++) {
      const { net, ok } = await runByzantine(4, [seed % 4], 'random', seed, false);
      expect(net.stats.exceptions, `seed ${seed}: ${net.violations.join('; ')}`).toBe(0);
      checkByzantineRun(net, ok);
      expect(net.stats.randomStatements).toBeGreaterThan(0);
    }
  });

  it('N=7 (f=2), signed: 2 seeds x 20 slots', async () => {
    for (let seed = 1; seed <= 2; seed++) {
      const { net, ok } = await runByzantine(7, [seed % 7, (seed + 3) % 7], 'random', seed, true);
      expect(net.stats.exceptions, `seed ${seed}: ${net.violations.join('; ')}`).toBe(0);
      checkByzantineRun(net, ok);
      expect(net.stats.rejectedSignature).toBe(0);
    }
  });
});
