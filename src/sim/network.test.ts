// Scenarios 3-5: message loss, late joiners catching up by replay and from a snapshot.

import { describe, expect, it } from 'vitest';
import { CHECKPOINT_FREQUENCY } from '../lib/constants';
import { qsetNodes } from '../scp/quorum';
import { Simulation, type SimNode } from './simulation';

function inQuorumOf(n: SimNode, id: string): boolean {
  return qsetNodes(n.node!.herder.scp.getLocalQuorumSet()).includes(id);
}

describe('simulation: unreliable network and late joiners', () => {
  it('3. seven nodes with 5% message drop: safety and liveness over 30 ledgers', async () => {
    const sim = new Simulation({ seed: 3, latency: [10, 80], dropRate: 0.05 });
    const nodes = await sim.addNodes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map((name) => ({ name })));
    expect(await sim.waitForLedger(31, 30 * 10_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    expect(sim.conflicts()).toEqual([]);
    for (const n of nodes) {
      expect(n.forks).toEqual([]);
      expect(n.node!.herder.scp.getLocalQuorumSet().validators.length).toBe(7);
    }
    await sim.shutdown();
  });

  it('4. a node joining at ledger ~25 with empty storage catches up by replay, then takes part', async () => {
    const sim = new Simulation({ seed: 4, latency: [10, 60] });
    const first = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(25, 25 * 8_000)).toBe(true);
    const late = await sim.addNode({ name: 'late' });
    // catches up by replaying the missing ledgers, then becomes synced
    expect(await sim.runUntil(() => late.state === 'synced' && late.lcl >= 25, 30_000)).toBe(true);
    const replayed = late.closes.filter((c) => c.source === 'catchup');
    expect(replayed.length).toBeGreaterThanOrEqual(20);
    expect(await late.storage.listSnapshotSeqs()).toEqual([]);
    // a few ledgers later it closes ledgers by consensus and is in everyone's quorum
    const joinedAt = late.lcl;
    expect(await sim.waitForLedger(joinedAt + 5, 60_000)).toBe(true);
    expect(late.consensusCloses().length).toBeGreaterThanOrEqual(3);
    for (const n of first) expect(inQuorumOf(n, late.nodeId)).toBe(true);
    expect(late.node!.herder.scp.getLocalQuorumSet().validators.length).toBe(4);
    expect(sim.historyConflicts()).toEqual([]);
    // the stored chain matches the others from genesis on
    const theirs = await sim.storedChain(first[0]);
    const ours = await sim.storedChain(late);
    for (const [seq, h] of ours) expect(theirs.get(seq)).toBe(h);
    expect(ours.size).toBeGreaterThanOrEqual(joinedAt);
    await sim.shutdown();
  });

  it('5. a node joining after ledger 70 catches up from the checkpoint 64 snapshot', async () => {
    const sim = new Simulation({ seed: 5, latency: [5, 30] });
    const first = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(72, 72 * 7_000)).toBe(true);
    for (const n of first) expect(await n.storage.listSnapshotSeqs()).toEqual([CHECKPOINT_FREQUENCY]);
    const late = await sim.addNode({ name: 'late' });
    expect(await sim.runUntil(() => late.state === 'synced' && late.lcl >= 72, 30_000)).toBe(true);
    // it loaded the snapshot and replayed only the ledgers after it
    expect(await late.storage.listSnapshotSeqs()).toContain(CHECKPOINT_FREQUENCY);
    const replayed = late.closes.filter((c) => c.source === 'catchup').map((c) => c.seq);
    expect(Math.min(...replayed)).toBe(CHECKPOINT_FREQUENCY + 1);
    expect(await late.storage.getLedger(10)).toBeUndefined();
    expect(await sim.waitForLedger(late.lcl + 4, 60_000)).toBe(true);
    expect(late.consensusCloses().length).toBeGreaterThanOrEqual(2);
    expect(sim.historyConflicts()).toEqual([]);
    expect(sim.conflicts()).toEqual([]);
    // state is identical: same header hash means same state hash
    const lcl = Math.min(...sim.running().map((n) => n.lcl));
    const hashes = new Set(sim.running().map((n) => n.chain.get(lcl)));
    expect(hashes.size).toBe(1);
    // a restart of the late node loads the snapshot and replays what it stored
    await sim.restartNode(late);
    expect(await sim.runUntil(() => late.state === 'synced', 30_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    await sim.shutdown();
  });
});
