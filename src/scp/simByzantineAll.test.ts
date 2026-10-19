// SCP simulation with Byzantine nodes that equivocate on nominations and on
// ballot statements, and (signed runs) forge envelopes of honest nodes.

import { describe, expect, it } from 'vitest';
import { checkByzantineRun, runByzantine } from './simByzantineKit';

describe('Byzantine nodes equivocating on nominations and ballots', () => {
  it('N=4 (f=1), signed, with forged envelopes: 6 seeds x 20 slots', async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { net, ok } = await runByzantine(4, [seed % 4], 'equivocate-all', seed, true);
      checkByzantineRun(net, ok);
      expect(net.stats.forgeries).toBeGreaterThan(0);
      // forged envelopes fail the signature check at every receiver
      expect(net.stats.rejectedSignature).toBeGreaterThan(0);
    }
  });

  it('N=4 (f=1), unsigned: 20 seeds x 20 slots', async () => {
    for (let seed = 7; seed <= 26; seed++) {
      const { net, ok } = await runByzantine(4, [seed % 4], 'equivocate-all', seed, false);
      checkByzantineRun(net, ok);
      expect(net.stats.equivocations).toBeGreaterThan(0);
    }
  });

  it('N=7 (f=2), unsigned: 20 seeds x 20 slots', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, ok } = await runByzantine(7, [seed % 7, (seed + 2) % 7], 'equivocate-all', seed, false);
      checkByzantineRun(net, ok);
    }
  });

  it('N=7 (f=2), signed, with forged envelopes: 2 seeds x 20 slots', async () => {
    for (let seed = 21; seed <= 22; seed++) {
      const { net, ok } = await runByzantine(7, [seed % 7, (seed + 2) % 7], 'equivocate-all', seed, true);
      checkByzantineRun(net, ok);
      expect(net.stats.rejectedSignature).toBeGreaterThan(0);
    }
  });
});
