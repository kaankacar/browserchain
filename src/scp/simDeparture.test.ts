// Departures while a slot is still nominating: validators leave, the
// survivors stall, then switch to a quorum set over themselves with the
// herder recipe (updateLocalQuorumSet, then abandonBallot or
// refreshNomination). Round leaders must follow the new quorum set: before
// the fix they only grew, so departed leaders could block nomination forever.

import { describe, expect, it } from 'vitest';
import { ScpTestNetwork, bftThreshold, flatQSet, makeSimValue, parseSimValue, type SimNode } from './testnet';

const SLOTS = 5;
const SEEDS = Number(process.env.SCP_DEPARTURE_SEEDS ?? 40);

interface Scenario {
  n: number;
  departed: number;
  /** delay from the start to the quorum set change (herder: 4 s stall + 1 s check) */
  stallMs: [number, number];
  /** survivors restarted at random times (restored state, like a reloaded tab) */
  restarts?: number;
}

async function runDeparture(seed: number, s: Scenario): Promise<{ net: ScpTestNetwork; ok: boolean; live: SimNode[] }> {
  const net = new ScpTestNetwork({ seed });
  const gone = new Set<number>();
  while (gone.size < s.departed) gone.add(Math.floor(net.rng() * s.n));
  const nodes = net.addNodes(
    Array.from({ length: s.n }, (_, i) => ({ name: `dep-${s.n}-${s.departed}-${seed}-${i}`, crashed: gone.has(i) })),
    (ids) => flatQSet(ids, bftThreshold(s.n)),
  );
  const live = nodes.filter((n) => !n.crashed);
  const liveIds = live.map((n) => n.id);
  for (const n of live) {
    const [lo, hi] = s.stallMs;
    net.clock.setTimeout(
      () => {
        net.updateQSet(n, flatQSet(liveIds, bftThreshold(live.length)));
        const slot = n.lcl + 1;
        if (!n.scp.abandonBallot(slot)) n.scp.refreshNomination(slot, makeSimValue(slot, n.index, 1_000 + seed));
      },
      lo + net.rng() * (hi - lo),
    );
  }
  for (let k = 0; k < (s.restarts ?? 0); k++) {
    const victim = live[Math.floor(net.rng() * live.length)];
    net.clock.setTimeout(() => victim.restart(), 500 + net.rng() * 20_000);
  }
  const ok = await net.run(SLOTS, 120_000);
  return { net, ok, live };
}

function check(net: ScpTestNetwork, ok: boolean, live: SimNode[], label: string): void {
  net.checkSafety();
  expect(ok, `${label}: every survivor externalized ${SLOTS} slots`).toBe(true);
  for (const node of live) {
    for (let slot = 1; slot <= SLOTS; slot++) expect(parseSimValue(node.externalized.get(slot)!)?.slot).toBe(slot);
  }
}

describe('departures during nomination (round leaders follow the quorum set)', () => {
  const scenarios: Scenario[] = [
    { n: 7, departed: 3, stallMs: [4_000, 9_000] },
    { n: 5, departed: 2, stallMs: [4_000, 9_000] },
    { n: 10, departed: 4, stallMs: [4_000, 12_000] },
  ];
  for (const s of scenarios) {
    it(`N=${s.n}, ${s.departed} never show up, survivors switch after a stall: ${SEEDS} seeds`, async () => {
      const stuck: number[] = [];
      const staleLeaders: number[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { net, ok, live } = await runDeparture(seed, s);
        net.checkSafety();
        if (!ok) stuck.push(seed);
        else check(net, ok, live, `seed ${seed}`);
        // round leaders of every slot are members of the new quorum set
        const stale = live.some((n) => {
          const members = new Set(n.scp.getLocalQuorumSet().validators);
          return n.scp.getKnownSlots().some((slot) => n.scp.getNominationLeaders(slot).some((l) => !members.has(l)));
        });
        if (stale) staleLeaders.push(seed);
      }
      expect({ stuck, staleLeaders }, 'seeds where the survivors never finished / kept departed leaders').toEqual({
        stuck: [],
        staleLeaders: [],
      });
    });
  }
});

describe('departures while survivors restart (a restored nomination must announce the new set)', () => {
  // A survivor that restarts just before its quorum set change cannot
  // announce the new set (nomination has not started yet). Before the fix
  // its restored nomination kept the old set for good: 3 restarts stalled
  // seeds 50 and 91, 6 restarts stalled seeds 25, 49, 62, 87 and 91.
  const scenarios: Scenario[] = [
    { n: 5, departed: 2, stallMs: [4_000, 9_000], restarts: 3 },
    { n: 5, departed: 2, stallMs: [4_000, 9_000], restarts: 6 },
  ];
  for (const s of scenarios) {
    it(`N=${s.n}, ${s.departed} never show up, ${s.restarts} restarts: 100 seeds`, async () => {
      const stuck: number[] = [];
      for (let seed = 1; seed <= 100; seed++) {
        const { net, ok, live } = await runDeparture(seed, s);
        net.checkSafety();
        expect(net.stats.exceptions, `seed ${seed}: ${net.violations.join('; ')}`).toBe(0);
        if (!ok) stuck.push(seed);
        else check(net, ok, live, `seed ${seed}`);
      }
      expect(stuck, 'seeds where the survivors never finished').toEqual([]);
    });
  }
});
