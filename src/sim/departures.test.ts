// Scenarios 6 and 7: validators leaving (bye), crashing (no bye) and restarting.

import { describe, expect, it } from 'vitest';
import { LEDGER_TARGET_CLOSE_MS, VALIDATOR_ACTIVE_MS } from '../lib/constants';
import { qsetNodes } from '../scp/quorum';
import { Simulation, type SimNode } from './simulation';

/** Longest time between consecutive consensus closes of `n` after `since`. */
function maxGapSince(n: SimNode, since: number): number {
  const at = [since, ...n.consensusCloses().filter((c) => c.at > since).map((c) => c.at)];
  let max = 0;
  for (let i = 1; i < at.length; i++) max = Math.max(max, at[i] - at[i - 1]);
  return max;
}

function quorumOf(n: SimNode): string[] {
  return qsetNodes(n.node!.herder.scp.getLocalQuorumSet());
}

describe('simulation: departures and restarts', () => {
  it('6a. two of five validators leave with bye: the others keep closing without a stall', async () => {
    const sim = new Simulation({ seed: 61, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })));
    expect(await sim.waitForLedger(10, 100_000)).toBe(true);
    const [a, b, c, d, e] = nodes;
    expect(quorumOf(a).length).toBe(5);
    await sim.run(1_700);
    const leftAt = sim.clock.now();
    await sim.stopNode(d);
    await sim.stopNode(e);
    const target = a.lcl + 6;
    expect(await sim.waitForLedger(target, 60_000, [a, b, c])).toBe(true);
    for (const n of [a, b, c]) {
      expect(quorumOf(n).sort()).toEqual([a.nodeId, b.nodeId, c.nodeId].sort());
      expect(maxGapSince(n, leftAt)).toBeLessThanOrEqual(LEDGER_TARGET_CLOSE_MS + 3_000);
    }
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('6b. two of five validators crash (no bye): the stall is bounded by VALIDATOR_ACTIVE_MS', async () => {
    for (const mode of ['freeze', 'link-down'] as const) {
      const sim = new Simulation({ seed: 62, latency: [10, 60] });
      const nodes = await sim.addNodes(['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })));
      expect(await sim.waitForLedger(8, 100_000)).toBe(true);
      const [a, b, c, d, e] = nodes;
      await sim.run(2_300);
      const crashedAt = sim.clock.now();
      sim.crashNode(d, mode);
      sim.crashNode(e, mode);
      const lclAtCrash = a.lcl;
      expect(await sim.waitForLedger(lclAtCrash + 6, 90_000, [a, b, c])).toBe(true);
      for (const n of [a, b, c]) {
        expect(quorumOf(n)).not.toContain(d.nodeId);
        expect(quorumOf(n)).not.toContain(e.nodeId);
        // stalled at most until the crashed nodes stopped counting as active
        expect(maxGapSince(n, crashedAt)).toBeLessThanOrEqual(VALIDATOR_ACTIVE_MS + LEDGER_TARGET_CLOSE_MS + 3_000);
      }
      // after the stall, ledgers close at the normal pace again
      const last = a.consensusCloses().slice(-4);
      for (let i = 1; i < last.length; i++) expect(last[i].at - last[i - 1].at).toBeLessThan(LEDGER_TARGET_CLOSE_MS + 1_500);
      expect(sim.historyConflicts([a, b, c])).toEqual([]);
      expect(sim.conflicts()).toEqual([]);
      await sim.shutdown();
    }
  });

  it('6c. one of four validators crashes: no stall at all (3 of 4 is still a quorum)', async () => {
    const sim = new Simulation({ seed: 63, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    const crashedAt = sim.clock.now();
    sim.crashNode(nodes[3]);
    expect(await sim.waitForLedger(nodes[0].lcl + 5, 60_000, nodes.slice(0, 3))).toBe(true);
    for (const n of nodes.slice(0, 3)) expect(maxGapSince(n, crashedAt)).toBeLessThanOrEqual(LEDGER_TARGET_CLOSE_MS + 2_000);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('7. a restarted node resumes from its stored state and catches up', async () => {
    const sim = new Simulation({ seed: 7, latency: [10, 60] });
    const nodes = await sim.addNodes(['a', 'b', 'c', 'd'].map((name) => ({ name })));
    const d = nodes[3];
    expect(await sim.waitForLedger(10, 100_000)).toBe(true);

    // graceful restart after a while
    await sim.stopNode(d);
    const stoppedAt = d.lcl;
    expect(stoppedAt).toBeGreaterThanOrEqual(10);
    await sim.run(25_000);
    expect(nodes[0].lcl).toBeGreaterThan(stoppedAt + 2);
    await sim.restartNode(d);
    // the ledger came back from storage, not from genesis
    expect(d.lcl).toBe(stoppedAt);
    expect(await sim.runUntil(() => d.state === 'synced' && d.lcl >= nodes[0].lcl - 1, 30_000)).toBe(true);
    const replayed = d.closes.filter((c) => c.source === 'catchup');
    expect(replayed.length).toBeGreaterThan(0);
    expect(Math.min(...replayed.map((c) => c.seq))).toBe(stoppedAt + 1);
    const before = d.consensusCloses().length;
    expect(await sim.waitForLedger(nodes[0].lcl + 4, 60_000)).toBe(true);
    expect(d.consensusCloses().length).toBeGreaterThan(before + 2);

    // crash, then restart with the same storage
    sim.crashNode(d);
    const crashedAt = d.lcl;
    await sim.run(20_000);
    await sim.restartNode(d);
    expect(d.lcl).toBe(crashedAt);
    expect(await sim.runUntil(() => d.state === 'synced' && d.lcl >= nodes[0].lcl - 1, 30_000)).toBe(true);
    expect(await sim.waitForLedger(nodes[0].lcl + 3, 60_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    expect(sim.conflicts()).toEqual([]);
    const stored = await sim.storedChain(d);
    const reference = await sim.storedChain(nodes[0]);
    for (const [seq, h] of stored) expect(reference.get(seq)).toBe(h);
    await sim.shutdown();
  });
});
