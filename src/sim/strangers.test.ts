// Validators this node did not know before (ARCHITECTURE 12.3, 15). Honest
// strangers look like Sybil identities, so they never move a node to their
// chain on their own. Instead the node makes it visible:
// - V-2: two groups that formed apart meet. Each keeps its chain. A node
//   whose side has no more vouchers than the strangers on the other branch
//   reports the fork ('kept-ours' with unknownValidators), again at most
//   every 10 s while it lasts.
// - V-4: nodes whose old members are gone come back to a network of
//   strangers that lack the ledgers to replay. Alone, a node does not vote
//   and says why in status.catchup.blocked. Two of them vote together on a
//   private branch and report the strangers.
// A resync (chain wiped, identity kept, member book cleared) then joins the
// other group: the node catches up from it as a fresh node.

import { describe, expect, it } from 'vitest';
import type { ForkInfo } from '../node/api';
import { NodeService } from '../node/service';
import { qsetNodes } from '../scp/quorum';
import { Simulation, type SimNode } from './simulation';

/** Reports of a fork that only validators unknown to the node are on. */
function strangerReports(n: SimNode, since = -Infinity): ForkInfo[] {
  return n.forks.filter((f) => f.ts >= since && f.resolution === 'kept-ours' && (f.unknownValidators ?? 0) > 0);
}

async function resync(sim: Simulation, n: SimNode): Promise<void> {
  let done = false;
  void n.node!.resync().then(() => {
    done = true;
  });
  // resync waits for a running fork check or catch-up, whose requests need the clock to move
  expect(await sim.runUntil(() => done, 30_000)).toBe(true);
}

function expectReportedEvery10s(n: SimNode, reports: ForkInfo[], now: number): void {
  expect(reports.length, `${n.name} reports`).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < reports.length; i++) expect(reports[i].ts - reports[i - 1].ts, `${n.name} report gap`).toBeGreaterThanOrEqual(10_000);
  // while the fork lasts, the newest report stays fresh (the UI alert needs one within 40 s)
  expect(now - reports[reports.length - 1].ts, `${n.name} newest report age`).toBeLessThan(25_000);
}

describe('simulation: groups that formed apart (V-2)', () => {
  it('a smaller group reports the strangers, nobody rolls back, and a resync joins the other group', async () => {
    const sim = new Simulation({ seed: 801, latency: [10, 60] });
    const A = ['a1', 'a2', 'a3', 'a4'];
    const B = ['b1', 'b2'];
    sim.net.partition([A, B]);
    const nodes = await sim.addNodes([...A, ...B].map((name) => ({ name })));
    const groupA = nodes.slice(0, 4);
    const groupB = nodes.slice(4);
    expect(await sim.waitForLedger(8, 90_000)).toBe(true);
    expect(groupA[0].chain.get(2)).not.toBe(groupB[0].chain.get(2));

    sim.heal();
    const healAt = sim.clock.now();
    await sim.run(60_000);
    const now = sim.clock.now();
    for (const n of nodes) {
      expect(n.forks.filter((f) => f.resolution === 'rolled-back'), `${n.name} rollbacks`).toEqual([]);
      expect(n.consensusCloses().filter((c) => c.at > now - 15_000).length, `${n.name} still closes ledgers`).toBeGreaterThan(0);
    }
    expect(sim.conflicts(groupA)).toEqual([]);
    expect(sim.conflicts(groupB)).toEqual([]);
    // B: 4 validators it never knew are on the other branch, against 2 vouchers on its side
    for (const n of groupB) {
      const reports = strangerReports(n, healAt);
      expectReportedEvery10s(n, reports, now);
      for (const f of reports) {
        expect(f).toMatchObject({ resolution: 'kept-ours', atSeq: 2, unknownValidators: 4, rolledBackLedgers: 0 });
        expect(f.ourHash).toBe(n.chain.get(2));
        expect(f.theirHash).toBe(groupA[0].chain.get(2));
      }
    }
    // A: 2 strangers are fewer than its 4 vouchers: nothing to report
    for (const n of groupA) expect(strangerReports(n), `${n.name} stranger reports`).toEqual([]);

    // every B tab resyncs: each catches up from A as a fresh node
    for (const n of groupB) await resync(sim, n);
    expect(await sim.runUntil(() => groupB.every((n) => n.state === 'synced' && n.lcl >= groupA[0].lcl - 1), 120_000)).toBe(true);
    const joined = sim.clock.now();
    for (const n of groupB) expect(n.chain.get(2), `${n.name} ledger 2`).toBe(groupA[0].chain.get(2));
    expect(await sim.waitForLedger(Math.max(...nodes.map((n) => n.lcl)) + 3, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    await sim.run(20_000);
    for (const n of nodes) {
      expect(qsetNodes(n.node!.herder.scp.getLocalQuorumSet()).length, `${n.name} quorum`).toBe(6);
      expect(strangerReports(n, joined), `${n.name} stranger reports after joining`).toEqual([]);
    }
    await sim.shutdown();
  });

  it('two groups of three both report the other one', async () => {
    const sim = new Simulation({ seed: 802, latency: [10, 60] });
    const A = ['a1', 'a2', 'a3'];
    const B = ['b1', 'b2', 'b3'];
    sim.net.partition([A, B]);
    const nodes = await sim.addNodes([...A, ...B].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 90_000)).toBe(true);
    sim.heal();
    const healAt = sim.clock.now();
    await sim.run(45_000);
    for (const n of nodes) {
      expect(n.forks.filter((f) => f.resolution === 'rolled-back'), `${n.name} rollbacks`).toEqual([]);
      const reports = strangerReports(n, healAt);
      expect(reports.length, `${n.name} reports`).toBeGreaterThanOrEqual(1);
      expect(reports.every((f) => f.unknownValidators === 3)).toBe(true);
    }
    await sim.shutdown();
  });
});

/**
 * a, b and the returning nodes close a few ledgers together; the returning
 * nodes stop. a and b go past checkpoint 64, `born` validators join from
 * snapshot 64 (they lack ledgers 2..64), and a and b leave: nobody the
 * returning nodes knew is left, and nobody can serve their gap.
 */
async function strangersOnly(seed: number, returning: string[], born: number) {
  const sim = new Simulation({ seed, latency: [10, 40] });
  const nodes = await sim.addNodes(['a', 'b', ...returning].map((name) => ({ name })));
  const [a, b] = nodes;
  const back = nodes.slice(2);
  expect(await sim.waitForLedger(8, 60_000)).toBe(true);
  for (const n of back) await sim.stopNode(n);
  expect(await sim.waitForLedger(70, 600_000, [a, b])).toBe(true);
  const joined: SimNode[] = [];
  for (let i = 0; i < born; i++) joined.push(await sim.addNode({ name: `born${i}` }));
  expect(await sim.runUntil(() => joined.every((n) => n.state === 'synced' && n.lcl >= a.lcl - 1), 120_000)).toBe(true);
  for (const n of joined) expect(await n.storage.getLedger(10)).toBeUndefined();
  await sim.stopNode(a);
  await sim.stopNode(b);
  expect(await sim.waitForLedger(a.lcl + 4, 120_000, joined)).toBe(true);
  return { sim, back, joined };
}

describe('simulation: returning nodes whose known validators are gone (V-4)', () => {
  it('alone, the node does not vote and its status says why; a resync joins the strangers', async () => {
    const { sim, back, joined } = await strangersOnly(811, ['e'], 2);
    const [e] = back;
    const eLcl = e.lcl;
    const since = sim.clock.now();
    await sim.restartNode(e);
    await sim.run(60_000);
    expect(e.consensusCloses().filter((c) => c.at >= since)).toEqual([]);
    expect(e.state).toBe('catching-up');
    const status = e.node!.getStatus();
    expect(status.catchup).toMatchObject({ current: eLcl, source: null });
    expect(typeof status.catchup!.blocked).toBe('string');
    expect(status.catchup!.blocked!.length).toBeGreaterThan(10);
    expect(status.catchup!.blocked!.length).toBeLessThanOrEqual(200);
    // the UI reads it through NodeService, as plain data
    const service = new NodeService(e.node!, { clock: sim.clock });
    const viaApi = structuredClone(await service.getStatus());
    expect(viaApi.catchup!.blocked).toBe(status.catchup!.blocked);
    service.dispose();

    await resync(sim, e);
    expect(await sim.runUntil(() => e.state === 'synced' && e.lcl >= joined[0].lcl - 1, 120_000)).toBe(true);
    expect(e.node!.getStatus().catchup).toBeNull();
    expect(await sim.waitForLedger(e.lcl + 3, 60_000, [e, ...joined])).toBe(true);
    expect(sim.conflicts([e, ...joined])).toEqual([]);
    expect(qsetNodes(e.node!.herder.scp.getLocalQuorumSet()).length).toBe(1 + joined.length);
    await sim.shutdown();
  });

  for (const born of [2, 3]) {
    it(`two of them vote together on a private branch and report the ${born} strangers; a resync joins them`, async () => {
      const { sim, back, joined } = await strangersOnly(812 + born, ['e', 'f'], born);
      const since = sim.clock.now();
      for (const n of back) await sim.restartNode(n);
      await sim.run(60_000);
      const now = sim.clock.now();
      for (const n of back) {
        // they vote together (company): the private branch the review found
        expect(n.consensusCloses().filter((c) => c.at >= since).length, `${n.name} private ledgers`).toBeGreaterThan(0);
        const reports = strangerReports(n, since);
        expectReportedEvery10s(n, reports, now);
        expect(reports.every((f) => f.unknownValidators === born)).toBe(true);
        // the alert stays up: our ledger at the reported height is what the report says
        const last = reports[reports.length - 1];
        const ours = n.chain.get(last.atSeq);
        if (ours !== undefined) expect(last.ourHash).toBe(ours);
      }
      expect(sim.conflicts(back)).toEqual([]);

      for (const n of back) await resync(sim, n);
      expect(await sim.runUntil(() => back.every((n) => n.state === 'synced' && n.lcl >= joined[0].lcl - 1), 120_000)).toBe(true);
      const all = [...back, ...joined];
      expect(await sim.waitForLedger(Math.max(...all.map((n) => n.lcl)) + 3, 60_000, all)).toBe(true);
      expect(sim.conflicts(all)).toEqual([]);
      for (const n of back) expect(qsetNodes(n.node!.herder.scp.getLocalQuorumSet()).length, `${n.name} quorum`).toBe(all.length);
      await sim.shutdown();
    });
  }
});
