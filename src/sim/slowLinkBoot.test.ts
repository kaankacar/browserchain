// Boot over WebRTC (ARCHITECTURE 11): Nostr signalling can take several
// seconds before two browsers see each other. With the 4 s boot wait, each
// started a chain of its own and the two chains had to be reconciled by a
// rollback. A node whose transports include WebRTC waits up to 12 s for a
// first peer; BroadcastChannel-only nodes keep 4 s.
//
// The slow link is modelled with a partition that heals later: the nodes
// run, but cannot reach each other until signalling has connected them.

import { describe, expect, it } from 'vitest';
import { Simulation, type SimNode } from './simulation';

/** Ledgers a node closed by consensus before `t` (local ms). */
function closedBefore(n: SimNode, t: number): number[] {
  return n.consensusCloses()
    .filter((c) => c.at < t)
    .map((c) => c.seq);
}

describe('simulation: slow WebRTC signalling at boot', () => {
  for (const [seed, linkUpMs] of [
    [501, 6_000],
    [502, 9_000],
    [503, 11_000],
  ] as const) {
    it(`WebRTC tabs whose links come up after ${linkUpMs / 1000} s start one chain (seed ${seed})`, async () => {
      const sim = new Simulation({ seed, latency: [40, 160] });
      const names = ['a', 'b', 'c'];
      // signalling has not connected anybody yet
      sim.net.partition(names.map((n) => [n]));
      const nodes = await sim.addNodes(names.map((name) => ({ name, transportKind: 'bridge' as const })));
      const t0 = sim.clock.now();
      await sim.run(linkUpMs);
      for (const n of nodes) expect(n.state, `${n.name} is still waiting for a peer`).toBe('booting');
      sim.heal();
      const met = sim.clock.now();
      expect(await sim.waitForLedger(6, 60_000)).toBe(true);
      for (const n of nodes) {
        expect(closedBefore(n, met), `${n.name} closed ledgers alone`).toEqual([]);
        expect(n.forks, `${n.name} forks`).toEqual([]);
        expect(n.node!.herder.scp.getLocalQuorumSet().validators.length, `${n.name} quorum`).toBe(3);
      }
      expect(sim.historyConflicts()).toEqual([]);
      expect(met - t0).toBe(linkUpMs);
      await sim.shutdown();
    });
  }

  it('a WebRTC tab with no peer at all starts alone after 12 s; a BroadcastChannel-only tab after 4 s', async () => {
    const sim = new Simulation({ seed: 504 });
    sim.net.partition([['web'], ['bc']]);
    const [web, bc] = await sim.addNodes([
      { name: 'web', transportKind: 'bridge' },
      { name: 'bc', transportKind: 'broadcast' },
    ]);
    const t0 = sim.clock.now();
    expect(await sim.runUntil(() => bc.state === 'synced', 20_000, 50)).toBe(true);
    const bcAt = sim.clock.now() - t0;
    expect(bcAt).toBeGreaterThanOrEqual(4_000);
    expect(bcAt).toBeLessThan(5_200);
    expect(web.state).toBe('booting');
    expect(await sim.runUntil(() => web.state === 'synced', 20_000, 50)).toBe(true);
    const webAt = sim.clock.now() - t0;
    expect(webAt).toBeGreaterThanOrEqual(12_000);
    expect(webAt).toBeLessThan(13_200);
    await sim.shutdown();
  });

  it('a WebRTC tab that sees a peer still settles about 1 s after the first one', async () => {
    const sim = new Simulation({ seed: 505, latency: [20, 60] });
    sim.net.partition([['a'], ['b']]);
    const [a, b] = await sim.addNodes([
      { name: 'a', transportKind: 'bridge' },
      { name: 'b', transportKind: 'bridge' },
    ]);
    await sim.run(2_000);
    sim.heal();
    const met = sim.clock.now();
    expect(await sim.runUntil(() => a.state === 'synced' && b.state === 'synced', 10_000, 50)).toBe(true);
    expect(sim.clock.now() - met).toBeLessThan(2_600);
    expect(await sim.waitForLedger(4, 30_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });
});
