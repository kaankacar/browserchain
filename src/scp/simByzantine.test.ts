// SCP simulation with one Byzantine node that sends conflicting nominations
// to two halves of its peers. Signed runs use the real envelope signature
// path (statementSignaturePayload + ed25519): the conflicting envelopes are
// authentic, so only SCP itself keeps the honest nodes safe.

import { describe, expect, it } from 'vitest';
import { checkByzantineRun, runByzantine, sawConflictingNominations } from './simByzantineKit';

describe('one Byzantine node sending conflicting signed nominations', () => {
  it('N=4 (f=1), signed envelopes: 10 seeds x 20 slots', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const byz = seed % 4;
      const { net, ok } = await runByzantine(4, [byz], 'equivocate-nomination', seed, true);
      checkByzantineRun(net, ok);
      expect(net.stats.equivocations).toBeGreaterThan(0);
      expect(sawConflictingNominations(net, byz)).toBe(true);
      // every envelope was properly signed: nothing rejected
      expect(net.stats.rejectedSignature).toBe(0);
    }
  });

  it('N=4 (f=1), unsigned: 30 more seeds x 20 slots', async () => {
    for (let seed = 11; seed <= 40; seed++) {
      const byz = seed % 4;
      const { net, ok } = await runByzantine(4, [byz], 'equivocate-nomination', seed, false);
      checkByzantineRun(net, ok);
      expect(sawConflictingNominations(net, byz)).toBe(true);
    }
  });

  it('N=7 (f=2) equivocating on nominations: 20 seeds x 20 slots', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { net, ok } = await runByzantine(7, [seed % 7, (seed + 3) % 7], 'equivocate-nomination', seed, false);
      checkByzantineRun(net, ok);
    }
  });
});
