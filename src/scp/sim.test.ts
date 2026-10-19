// Multi-node SCP simulation: N SCP instances on one VirtualClock, connected
// by an in-memory network with seeded random delays (messages get
// reordered). Every node nominates its own value each slot.
// Safety: all nodes that externalize a slot externalize the same value.
// Liveness: all honest live nodes externalize every slot within a bound.

import { describe, expect, it } from 'vitest';
import { ScpTestNetwork, bftThreshold, flatQSet, parseSimValue, type NetworkOptions, type NodeSpec } from './testnet';

const SLOTS = 20;
const SEEDS = 20;

interface RunResult {
  net: ScpTestNetwork;
  ok: boolean;
  virtualMs: number;
}

async function runFlat(
  n: number,
  seed: number,
  specs: (i: number) => Partial<NodeSpec> = () => ({}),
  options: Partial<NetworkOptions> = {},
  maxMs = SLOTS * 15_000,
): Promise<RunResult> {
  const net = new ScpTestNetwork({ seed, ...options });
  net.addNodes(
    Array.from({ length: n }, (_, i) => ({ name: `flat-${n}-${seed}-${i}`, ...specs(i) })),
    (ids) => flatQSet(ids, bftThreshold(n)),
  );
  const start = net.clock.now();
  const ok = await net.run(SLOTS, maxMs);
  return { net, ok, virtualMs: net.clock.now() - start };
}

/** Safety, liveness and validity checks shared by the scenarios. */
function checkRun(r: RunResult, maxSlotMs: number): void {
  const { net } = r;
  net.checkSafety();
  expect(r.ok, 'every honest live node externalized every slot').toBe(true);
  for (const node of net.honestLive()) {
    expect(node.lcl).toBeGreaterThanOrEqual(SLOTS);
    for (let slot = 1; slot <= SLOTS; slot++) {
      const v = node.externalized.get(slot);
      expect(v, `node ${node.index} slot ${slot}`).toBe(net.decided.get(slot));
      // validity: the value was nominated by a node for this slot
      expect(parseSimValue(v!)?.slot).toBe(slot);
    }
  }
  expect(net.maxSlotLatency()).toBeLessThanOrEqual(maxSlotMs);
}

describe('honest network', () => {
  for (const n of [4, 5, 7]) {
    it(`N=${n}: ${SEEDS} seeds x ${SLOTS} slots, safety and liveness`, async () => {
      const winners = new Set<number>();
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await runFlat(n, seed);
        checkRun(r, 10_000);
        // 20 slots within 20 x 5 s of virtual time
        expect(r.virtualMs).toBeLessThanOrEqual(SLOTS * 5_000);
        for (const v of r.net.decided.values()) winners.add(parseSimValue(v)!.nodeIndex);
        // reordered delivery happened and was handled
        expect(r.net.stats.delivered).toBeGreaterThan(SLOTS * n * (n - 1));
      }
      // leader selection rotates: every node's value won some slot
      expect(winners.size).toBe(n);
    });
  }
});

describe('crashed nodes', () => {
  it(`N=4, f=1 crashed from the start: ${SEEDS} seeds x ${SLOTS} slots`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const crashed = seed % 4;
      const r = await runFlat(4, seed, (i) => ({ crashed: i === crashed }));
      checkRun(r, 30_000);
      expect(r.net.nodes[crashed].externalized.size).toBe(0);
    }
  });

  it(`N=7, f=2 crashed from the start: ${SEEDS} seeds x ${SLOTS} slots`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const a = seed % 7;
      const b = (seed * 3 + 1) % 7 === a ? (a + 1) % 7 : (seed * 3 + 1) % 7;
      const r = await runFlat(7, seed, (i) => ({ crashed: i === a || i === b }));
      checkRun(r, 30_000);
    }
  });

  it('N=7, f=2 crash at random times during the run: 10 seeds', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const net = new ScpTestNetwork({ seed });
      const nodes = net.addNodes(
        Array.from({ length: 7 }, (_, i) => ({ name: `midcrash-${seed}-${i}` })),
        (ids) => flatQSet(ids, bftThreshold(7)),
      );
      for (const victim of [nodes[seed % 7], nodes[(seed + 3) % 7]]) {
        net.clock.setTimeout(() => victim.crash(), 2_000 + net.rng() * 10_000);
      }
      const start = net.clock.now();
      const ok = await net.run(SLOTS, SLOTS * 15_000);
      checkRun({ net, ok, virtualMs: net.clock.now() - start }, 30_000);
    }
  });

  it('N=4 with 2 crashed cannot make progress (no quorum), and stays safe', async () => {
    const r = await runFlat(4, 99, (i) => ({ crashed: i >= 2 }), {}, 60_000);
    expect(r.ok).toBe(false);
    for (const node of r.net.honestLive()) expect(node.externalized.size).toBe(0);
    r.net.checkSafety();
  });
});

describe('lossy network', () => {
  it('N=5, 10% message loss, herder-style rebroadcast every second: 10 seeds', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = await runFlat(5, seed, () => ({}), { dropRate: 0.1, rebroadcastMs: 1_000 });
      checkRun(r, 30_000);
      expect(r.net.stats.dropped).toBeGreaterThan(0);
    }
  });
});

describe('non-validator watcher', () => {
  it('follows the validators, externalizes the same values, never emits', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const net = new ScpTestNetwork({ seed });
      const validators = net.addNodes(
        Array.from({ length: 4 }, (_, i) => ({ name: `wv-${seed}-${i}` })),
        (ids) => flatQSet(ids, 3),
      );
      const ids = validators.map((v) => v.id);
      const [watcher] = net.addNodes([{ name: `watcher-${seed}`, watcher: true }], () => flatQSet(ids, 3));
      const ok = await net.run(SLOTS, SLOTS * 15_000);
      expect(ok).toBe(true);
      net.checkSafety();
      expect(watcher.scp.isValidator()).toBe(false);
      expect(watcher.emittedLog.length).toBe(0);
      for (let slot = 1; slot <= SLOTS; slot++) expect(watcher.externalized.get(slot)).toBe(net.decided.get(slot));
      expect(watcher.scp.getLatestMessagesSend(SLOTS)).toEqual([]);
    }
  });
});
