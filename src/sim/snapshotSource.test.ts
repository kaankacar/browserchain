// A node that joined from a snapshot stores no ledgers between genesis and
// that snapshot. When the nodes that saw the whole chain are gone, newcomers
// can only catch up from such nodes, so catch-up must not need those headers.

import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';

describe('simulation: catch-up from a node that joined from a snapshot', () => {
  it('a fresh node catches up when its only source started from a snapshot', async () => {
    const sim = new Simulation({ seed: 501, latency: [10, 40] });
    const [a, b] = await sim.addNodes([{ name: 'a' }, { name: 'b' }]);
    expect(await sim.waitForLedger(70, 600_000)).toBe(true);
    // c joins after checkpoint 64: it loads the snapshot and keeps no older ledgers
    const c = await sim.addNode({ name: 'c' });
    expect(await sim.waitForLedger(72, 120_000, [a, b, c])).toBe(true);
    expect(await c.storage.listSnapshotSeqs()).toEqual([64]);
    expect(await c.storage.getLedger(2)).toBeUndefined();
    // the full-history nodes leave; c goes on alone past checkpoint 128
    await sim.stopNode(a);
    await sim.stopNode(b);
    expect(await sim.waitForLedger(131, 900_000, [c])).toBe(true);

    const d = await sim.addNode({ name: 'd' });
    expect(await sim.runUntil(() => d.state === 'synced' && d.lcl >= c.lcl - 1, 120_000)).toBe(true);
    // d took c's chain (from a snapshot) and did not close a chain of its own
    expect(d.closes.filter((x) => x.source === 'consensus' && x.seq <= 128)).toEqual([]);
    expect(await d.storage.listSnapshotSeqs()).toContain(128);
    expect(await sim.waitForLedger(c.lcl + 3, 60_000, [c, d])).toBe(true);
    expect(sim.conflicts([c, d])).toEqual([]);
    await sim.shutdown();
  });
});
