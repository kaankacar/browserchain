// Scenarios 8, 9 and 12: partitions in auto and manual mode, and the
// "everyone leaves, then the stale node comes back alone first" story.

import { describe, expect, it } from 'vitest';
import type { QuorumConfigInput } from '../node/api';
import { Simulation, type SimNode } from './simulation';

/** All nodes report the same hash for their common LCL and no conflicts anywhere. */
function converged(sim: Simulation, nodes: SimNode[]): boolean {
  if (sim.conflicts(nodes).length > 0) return false;
  const lcl = Math.min(...nodes.map((n) => n.lcl));
  const hashes = new Set(nodes.map((n) => n.chain.get(lcl)));
  return hashes.size === 1 && nodes.every((n) => n.state === 'synced');
}

describe('simulation: partitions and forks', () => {
  it('8. auto mode, partition 3|3: each side forks; after healing all nodes converge to one chain', async () => {
    const sim = new Simulation({ seed: 8, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    const left = nodes.slice(0, 3);
    const right = nodes.slice(3);
    const splitAt = Math.max(...nodes.map((n) => n.lcl));
    sim.partition([left, right]);
    // both sides drop the other side from their quorum and keep closing ledgers
    expect(await sim.runUntil(() => nodes.every((n) => n.lcl >= splitAt + 6), 120_000)).toBe(true);
    const forkSeq = Math.min(...nodes.map((n) => n.lcl));
    expect(left[0].chain.get(forkSeq)).not.toBe(right[0].chain.get(forkSeq));
    expect(sim.conflicts(left)).toEqual([]);
    expect(sim.conflicts(right)).toEqual([]);

    sim.heal();
    expect(await sim.runUntil(() => converged(sim, nodes), 180_000)).toBe(true);
    // forks were detected; the losing side rolled back
    const all = nodes.flatMap((n) => n.forks);
    expect(all.length).toBeGreaterThan(0);
    const rolledBack = nodes.filter((n) => n.forks.some((f) => f.resolution === 'rolled-back'));
    expect(rolledBack.length).toBeGreaterThanOrEqual(3);
    // and the network keeps going as one, with everyone in every quorum
    const now = Math.max(...nodes.map((n) => n.lcl));
    expect(await sim.waitForLedger(now + 3, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    for (const n of nodes) expect(n.node!.herder.scp.getLocalQuorumSet().validators.length).toBe(6);
    // the stored chains agree too
    const ref = await sim.storedChain(nodes[0]);
    for (const n of nodes.slice(1)) {
      for (const [seq, h] of await sim.storedChain(n)) expect(ref.get(seq) ?? h).toBe(h);
    }
    await sim.shutdown();
  });

  it('8b. auto mode: a validator that joined the losing side during a partition follows the winning chain after healing', async () => {
    // Review: g knows no validator from before the fork point, so it counted
    // only itself (1 for ours, 0 for theirs) and kept its branch forever,
    // closing ledgers alone after its side rolled back.
    const sim = new Simulation({ seed: 731, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd', 'e', 'f', 'h'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    // g is named before it starts, so it joins the left side
    sim.net.partition([
      ['a', 'b', 'c', 'g'],
      ['d', 'e', 'f', 'h'],
    ]);
    const split = Math.max(...nodes.map((n) => n.lcl));
    expect(await sim.runUntil(() => nodes.every((n) => n.lcl >= split + 4), 120_000)).toBe(true);
    const g = await sim.addNode({ name: 'g' });
    const all = [...nodes, g];
    expect(await sim.runUntil(() => g.state === 'synced' && all.every((n) => n.lcl >= split + 10), 180_000)).toBe(true);
    const [a, , , d] = nodes;
    expect(g.chain.get(split + 2)).toBe(a.chain.get(split + 2));
    expect(a.chain.get(split + 2)).not.toBe(d.chain.get(split + 2));

    sim.heal();
    // 4 validators known before the split against 3: the left side rolls back, and g with it
    expect(await sim.runUntil(() => converged(sim, all), 180_000)).toBe(true);
    expect(g.forks.some((f) => f.resolution === 'rolled-back')).toBe(true);
    expect(g.chain.get(split + 2)).toBe(d.chain.get(split + 2));
    const now = Math.max(...all.map((n) => n.lcl));
    expect(await sim.waitForLedger(now + 3, 60_000, all)).toBe(true);
    expect(sim.conflicts(all)).toEqual([]);
    for (const n of all) expect(n.node!.herder.scp.getLocalQuorumSet().validators.length, `${n.name} quorum`).toBe(8);
    await sim.shutdown();
  });

  it('9. manual mode {A,B,C,D} threshold 3, partition 2|2: no side closes ledgers; after healing they resume', async () => {
    const sim = new Simulation({ seed: 9, latency: [10, 60] });
    const names = ['A', 'B', 'C', 'D'];
    // node ids are derived from the seed and name, so the quorum set can be built up front
    const probe = new Simulation({ seed: 9 });
    const ids: string[] = [];
    for (const name of names) ids.push((await probe.addNode({ name })).nodeId);
    await probe.shutdown();
    const quorum: QuorumConfigInput = { mode: 'manual', qset: { threshold: 3, validators: ids, innerSets: [] } };
    const nodes = await sim.addNodes(names.map((name) => ({ name, quorum })));
    expect(await sim.waitForLedger(5, 60_000)).toBe(true);
    for (const n of nodes) expect(n.node!.getQuorumConfig().mode).toBe('manual');

    sim.partition([nodes.slice(0, 2), nodes.slice(2)]);
    await sim.run(1_000);
    const frozen = nodes.map((n) => n.lcl);
    await sim.run(60_000);
    // safety: nobody closed a ledger while split (at most the slot that was in flight)
    nodes.forEach((n, i) => expect(n.lcl).toBeLessThanOrEqual(frozen[i] + 1));
    expect(sim.conflicts()).toEqual([]);
    expect(nodes.every((n) => n.forks.length === 0)).toBe(true);
    // quorum sets were not changed
    for (const n of nodes) expect(n.node!.herder.scp.getLocalQuorumSet().validators.length).toBe(4);

    sim.heal();
    const start = Math.max(...nodes.map((n) => n.lcl));
    expect(await sim.waitForLedger(start + 3, 120_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('9b. manual mode with a weak quorum (2 of 4): forks are only reported, never rolled back', async () => {
    const names = ['A', 'B', 'C', 'D'];
    const probe = new Simulation({ seed: 19 });
    const ids: string[] = [];
    for (const name of names) ids.push((await probe.addNode({ name })).nodeId);
    await probe.shutdown();
    const sim = new Simulation({ seed: 19, latency: [10, 60] });
    const quorum: QuorumConfigInput = { mode: 'manual', qset: { threshold: 2, validators: ids, innerSets: [] } };
    const nodes = await sim.addNodes(names.map((name) => ({ name, quorum })));
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    sim.partition([nodes.slice(0, 2), nodes.slice(2)]);
    const split = Math.max(...nodes.map((n) => n.lcl));
    // two disjoint quorums: both sides keep closing ledgers
    expect(await sim.runUntil(() => nodes.every((n) => n.lcl >= split + 4), 120_000)).toBe(true);
    sim.heal();
    expect(await sim.runUntil(() => nodes.every((n) => n.forks.length > 0), 60_000)).toBe(true);
    for (const n of nodes) {
      expect(n.forks.every((f) => f.resolution === 'alert-only' && f.rolledBackLedgers === 0)).toBe(true);
      expect(n.closes.some((c) => c.source === 'catchup' && c.seq <= split + 4)).toBe(false);
    }
    expect(sim.conflicts().length).toBeGreaterThan(0);
    // The user resolves it on one side: a quorum set whose quorums intersect
    // (3 of 4), then a resync. A manual-mode node follows only a v-blocking
    // set of its quorum set: A and B are one for 3 of 4, not for 2 of 4.
    const fixed: QuorumConfigInput = { mode: 'manual', qset: { threshold: 3, validators: ids, innerSets: [] } };
    for (const n of nodes.slice(2)) {
      await n.node!.setQuorumConfig(fixed);
      // resync waits for a running fork check, whose requests need the clock to move
      let done = false;
      void n.node!.resync().then(() => {
        done = true;
      });
      expect(await sim.runUntil(() => done, 30_000)).toBe(true);
    }
    const [A] = nodes;
    expect(await sim.runUntil(() => sim.conflicts().length === 0 && nodes.every((n) => n.state === 'synced' && n.lcl >= A.lcl - 1), 60_000)).toBe(true);
    for (const n of nodes.slice(2)) expect(n.chain.get(split + 2)).toBe(A.chain.get(split + 2));
    expect(await sim.waitForLedger(Math.max(...nodes.map((n) => n.lcl)) + 2, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('12. everyone leaves, the stale node comes back alone first: the chains reconcile by the fork rule', async () => {
    const sim = new Simulation({ seed: 12, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'stale'].map((name) => ({ name })));
    const [a, b, c, stale] = nodes;
    expect(await sim.waitForLedger(8, 60_000)).toBe(true);
    // the stale node leaves early; the others go on and leave later
    await sim.stopNode(stale);
    const staleAt = stale.lcl;
    expect(await sim.waitForLedger(staleAt + 10, 120_000, [a, b, c])).toBe(true);
    for (const n of [a, b, c]) await sim.stopNode(n);
    const mainAt = a.lcl;
    await sim.run(10_000);

    // the stale node comes back alone: no peers, so it validates alone and forks
    await sim.restartNode(stale);
    expect(await sim.runUntil(() => stale.lcl >= staleAt + 4, 60_000)).toBe(true);
    const staleChain = new Map(stale.chain);
    expect(staleChain.get(staleAt + 1)).not.toBe(a.chain.get(staleAt + 1));

    // the others come back: the heavier branch wins, the stale node rolls back
    for (const n of [a, b, c]) await sim.restartNode(n);
    expect(await sim.runUntil(() => converged(sim, nodes) && stale.lcl >= mainAt, 120_000)).toBe(true);
    expect(stale.forks.some((f) => f.resolution === 'rolled-back' && f.atSeq === staleAt + 1)).toBe(true);
    for (const n of [a, b, c]) expect(n.forks.every((f) => f.resolution !== 'rolled-back')).toBe(true);
    // the main chain survived: its ledger after the fork point is what everyone has
    expect(stale.chain.get(staleAt + 1)).toBe(a.chain.get(staleAt + 1));
    expect(await sim.waitForLedger(Math.max(...nodes.map((n) => n.lcl)) + 2, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    const stored = await sim.storedChain(stale);
    const ref = await sim.storedChain(a);
    for (const [seq, h] of stored) expect(ref.get(seq) ?? h).toBe(h);
    await sim.shutdown();
  });
});
