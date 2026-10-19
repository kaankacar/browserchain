// Restarts with restored state (herder restoreScpState): honest nodes are
// restarted at random times, get their latest envelopes of the open slot
// back, then the peers' current state, then nominate again. Before the fix a
// restarted node whose restored votes already held every value the leaders
// offered never evaluated the statements it got before nominating: it never
// accepted or confirmed anything, and the slot could stall for good.

import { describe, expect, it } from 'vitest';
import { ScpTestNetwork, bftThreshold, flatQSet, parseSimValue } from './testnet';

const SLOTS = 10;

interface Scenario {
  n: number;
  byzantine: number;
  restarts: number;
  dropRate?: number;
}

async function runRestarts(seed: number, s: Scenario): Promise<{ net: ScpTestNetwork; ok: boolean }> {
  const net = new ScpTestNetwork({ seed, dropRate: s.dropRate, rebroadcastMs: s.dropRate ? 1_000 : undefined });
  const byz = new Set<number>();
  while (byz.size < s.byzantine) byz.add(Math.floor(net.rng() * s.n));
  const nodes = net.addNodes(
    Array.from({ length: s.n }, (_, i) => ({ name: `rs-${s.n}-${seed}-${i}`, byzantine: byz.has(i) ? ('random' as const) : undefined })),
    (ids) => flatQSet(ids, bftThreshold(s.n)),
  );
  const honest = nodes.filter((x) => x.isHonest());
  for (let k = 0; k < s.restarts; k++) {
    const victim = honest[Math.floor(net.rng() * honest.length)];
    net.clock.setTimeout(() => victim.restart(), 500 + net.rng() * SLOTS * 2_500);
  }
  const ok = await net.run(SLOTS, SLOTS * 30_000);
  return { net, ok };
}

describe('restarts with restored SCP state', () => {
  const scenarios: [string, Scenario, number][] = [
    // seeds 9, 20 and 31 stalled before the fix
    ['N=4, 1 random Byzantine, 6 restarts', { n: 4, byzantine: 1, restarts: 6 }, 40],
    // seeds 13 and 22 stalled before the fix
    ['N=5, 5% loss + rebroadcast, 8 restarts', { n: 5, byzantine: 0, restarts: 8, dropRate: 0.05 }, 30],
  ];
  for (const [name, s, seeds] of scenarios) {
    it(`${name}: ${seeds} seeds x ${SLOTS} slots stay live and safe`, async () => {
      const stuck: number[] = [];
      for (let seed = 1; seed <= seeds; seed++) {
        const { net, ok } = await runRestarts(seed, s);
        net.checkSafety();
        expect(net.stats.exceptions, `seed ${seed}: ${net.violations.join('; ')}`).toBe(0);
        if (!ok) stuck.push(seed);
        for (const node of net.honestLive()) {
          for (const [slot, v] of node.externalized) expect(parseSimValue(v)?.slot).toBe(slot);
        }
      }
      expect(stuck, 'seeds where the honest nodes never finished').toEqual([]);
    });
  }
});
