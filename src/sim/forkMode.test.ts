// A fork with a peer that stays ahead of us must be checked again: its LCL
// cannot be compared with our chain, so only a new fork check can resolve
// it. Review cases: a manual-mode fork that stayed for 125 s after switching
// to auto mode, and an auto-mode fork check whose branchWeight request failed.

import { describe, expect, it } from 'vitest';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { SimNode, Simulation } from './simulation';

/** One chain: the same hash at the lowest common LCL, no conflicts, all synced. */
function oneChain(sim: Simulation, nodes: SimNode[]): boolean {
  const lcl = Math.min(...nodes.map((n) => n.lcl));
  return sim.conflicts(nodes).length === 0 && new Set(nodes.map((n) => n.chain.get(lcl))).size === 1 && nodes.every((n) => n.state === 'synced');
}

describe('simulation: forks with a peer that stays ahead', () => {
  it('a manual-mode fork is resolved at once after switching to auto mode', async () => {
    const seed = 231;
    // fork checks of the same peer are spaced 120 s apart: only the mode
    // switch can make the next check come quickly
    const sim = new Simulation({ seed, latency: [10, 60], nodeTuning: { forkRecheckMs: 120_000 } });
    const bId = new SimNode(seed, { name: 'b' }).nodeId;
    sim.net.partition([['a'], ['b']]);
    const a = await sim.addNode({ name: 'a' });
    expect(await sim.runUntil(() => a.lcl >= 14, 120_000)).toBe(true);
    // b trusts only itself: in manual mode it keeps its own chain
    const b = await sim.addNode({ name: 'b', quorum: { mode: 'manual', qset: { threshold: 1, validators: [bId], innerSets: [] } } });
    expect(await sim.runUntil(() => b.lcl >= 3, 60_000)).toBe(true);
    sim.heal();
    expect(await sim.runUntil(() => b.forks.some((f) => f.resolution === 'alert-only'), 60_000)).toBe(true);
    await sim.run(30_000);
    expect(a.lcl).toBeGreaterThan(b.lcl + 2);
    expect(b.chain.get(2)).not.toBe(a.chain.get(2));
    expect(b.forks.every((f) => f.resolution === 'alert-only')).toBe(true);

    await b.node!.setQuorumConfig({ mode: 'auto' });
    // the heavier branch (a's) wins: b rolls back right away and follows a
    expect(await sim.runUntil(() => b.forks.some((f) => f.resolution === 'rolled-back'), 15_000)).toBe(true);
    expect(await sim.runUntil(() => oneChain(sim, [a, b]) && b.lcl >= a.lcl - 1, 60_000)).toBe(true);
    const at = Math.max(a.lcl, b.lcl);
    expect(await sim.waitForLedger(at + 3, 60_000, [a, b])).toBe(true);
    expect(sim.conflicts([a, b])).toEqual([]);
    expect(b.node!.herder.scp.getLocalQuorumSet().validators.length).toBe(2);
    await sim.shutdown();
  });

  it('manual mode: the fork is checked again while it lasts, and reported once', async () => {
    const seed = 233;
    const sim = new Simulation({ seed, latency: [10, 60] });
    const bId = new SimNode(seed, { name: 'b' }).nodeId;
    sim.net.partition([['a'], ['b']]);
    const a = await sim.addNode({ name: 'a' });
    expect(await sim.runUntil(() => a.lcl >= 10, 120_000)).toBe(true);
    const b = await sim.addNode({ name: 'b', quorum: { mode: 'manual', qset: { threshold: 1, validators: [bId], innerSets: [] } } });
    expect(await sim.runUntil(() => b.lcl >= 3, 60_000)).toBe(true);
    // count b's header requests to a: each fork check walks a's headers
    const ov = b.node!.overlay;
    const request = ov.request.bind(ov);
    let headerRequests = 0;
    ov.request = (id: string, body: RequestBody, timeoutMs?: number): Promise<ResponseBody> => {
      if (id === a.nodeId && body.kind === 'headers') headerRequests++;
      return request(id, body, timeoutMs);
    };
    sim.heal();
    expect(await sim.runUntil(() => b.forks.length > 0, 60_000)).toBe(true);
    const first = headerRequests;
    await sim.run(60_000);
    expect(a.lcl).toBeGreaterThan(b.lcl);
    expect(headerRequests - first, 'fork checks of the peer that stays ahead').toBeGreaterThanOrEqual(3);
    expect(b.forks.map((f) => f.resolution)).toEqual(['alert-only']);
    expect(b.chain.get(2)).not.toBe(a.chain.get(2));
    await sim.shutdown();
  });

  it('auto mode: a fork check without a verdict (branchWeight failed) is retried while the peer stays ahead', async () => {
    const sim = new Simulation({ seed: 232, latency: [10, 60] });
    sim.net.partition([['a'], ['b']]);
    const a = await sim.addNode({ name: 'a' });
    expect(await sim.runUntil(() => a.lcl >= 14, 120_000)).toBe(true);
    const b = await sim.addNode({ name: 'b' });
    expect(await sim.runUntil(() => b.lcl >= 3, 60_000)).toBe(true);
    // b's first branchWeight request is lost
    const ov = b.node!.overlay;
    const request = ov.request.bind(ov);
    let lost = 0;
    ov.request = (id: string, body: RequestBody, timeoutMs?: number): Promise<ResponseBody> => {
      if (body.kind === 'branchWeight' && lost === 0) {
        lost++;
        return Promise.reject(new Error('lost'));
      }
      return request(id, body, timeoutMs);
    };
    sim.heal();
    expect(await sim.runUntil(() => lost === 1, 60_000)).toBe(true);
    expect(await sim.runUntil(() => oneChain(sim, [a, b]) && b.forks.some((f) => f.resolution === 'rolled-back'), 60_000)).toBe(true);
    expect(sim.recentLogs(200).some((l) => /branchWeight from .* failed/.test(l))).toBe(true);
    const at = Math.max(a.lcl, b.lcl);
    expect(await sim.waitForLedger(at + 3, 60_000, [a, b])).toBe(true);
    expect(sim.conflicts([a, b])).toEqual([]);
    await sim.shutdown();
  });
});
