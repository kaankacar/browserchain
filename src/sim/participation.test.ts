// Auto quorum membership needs SCP participation (ARCHITECTURE 10.6). Review
// case (obs-1): one signed status at our LCL made a validator active even if
// it never voted. Two such liars sat in a 5-node quorum with threshold 4 and
// stalled it for good. A synced validator now stays active only while it
// sends signed SCP envelopes for recent slots. A peer first seen counts for a
// short grace period without them, so tabs that start at the same time do
// not each close ledgers alone.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { LEDGER_TARGET_CLOSE_MS } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { Logger, LogSink } from '../lib/log';
import { Overlay, type AnnouncementFields } from '../overlay/overlay';
import type { LclRef } from '../overlay/types';
import { qsetNodes } from '../scp/quorum';
import { Simulation, type SimNode } from './simulation';

/**
 * A validator that announces the newest LCL it hears from the honest nodes
 * (so it always looks in sync with them) and never sends an SCP message.
 */
function silentLiar(sim: Simulation, i: number): { ov: Overlay; nodeId: string } {
  const kp = Keypair.fromRawEd25519Seed(sha256(`participation|liar|${i}`));
  const first = sim.nodes[0].node!;
  const lcl = first.ledger.lastClosed();
  let cur: LclRef = { seq: lcl.header.ledgerSeq, hash: lcl.hash };
  const fields = (): AnnouncementFields => ({ name: `liar${i}`, lcl: cur, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' });
  const ov: Overlay = new Overlay({
    keypair: kp,
    networkId: first.networkIdHex,
    name: `liar${i}`,
    clock: sim.clock,
    logger: new Logger(new LogSink(sim.clock, 'error'), `liar${i}`),
    transports: [sim.net.createTransport(`liar${i}`)],
    handlers: {
      onStellarMessage: () => false,
      onRequest: () => null,
      onPeerStatus: (p) => {
        if (p.ann.lcl.seq <= cur.seq) return;
        cur = { ...p.ann.lcl };
        ov.setAnnouncement(fields());
      },
    },
    announcement: { lcl: cur, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' },
  });
  ov.start();
  return { ov, nodeId: kp.publicKey() };
}

function closesAfter(n: SimNode, t: number): number {
  return n.consensusCloses().filter((c) => c.at > t).length;
}

describe('simulation: auto quorum membership needs SCP participation', () => {
  for (const seed of [711, 712, 713]) {
    it(`two validators that only send statuses do not stall a 3-node quorum (seed ${seed})`, async () => {
      const sim = new Simulation({ seed, latency: [10, 60] });
      const honest = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
      expect(await sim.waitForLedger(4, 60_000)).toBe(true);
      const liars = [silentLiar(sim, 0), silentLiar(sim, 1)];
      const t0 = sim.clock.now();
      await sim.run(60_000);
      const liarIds = new Set(liars.map((l) => l.nodeId));
      for (const n of honest) {
        // 12 ledgers in 60 s at full pace; the liars may hold one slot for a few seconds
        expect(closesAfter(n, t0), `${n.name} ledgers closed`).toBeGreaterThanOrEqual(9);
        expect(qsetNodes(n.node!.herder.scp.getLocalQuorumSet()).filter((id) => liarIds.has(id)), `${n.name} quorum`).toEqual([]);
        expect(n.node!.quorum.isActive(liars[0].nodeId)).toBe(false);
      }
      // still closing at the end, at the normal pace
      const last = honest[0].consensusCloses().slice(-4);
      for (let i = 1; i < last.length; i++) expect(last[i].at - last[i - 1].at).toBeLessThan(LEDGER_TARGET_CLOSE_MS + 1_500);
      expect(sim.historyConflicts(honest)).toEqual([]);
      for (const l of liars) l.ov.stop();
      await sim.shutdown();
    });
  }

  for (const [seed, latency, count] of [
    [721, [20, 150], 4],
    [722, [50, 400], 5],
    [723, [10, 60], 7],
    [724, [100, 300], 3],
  ] as const) {
    it(`${count} tabs that start at the same time form one chain (seed ${seed}, latency ${latency[0]}-${latency[1]} ms)`, async () => {
      const sim = new Simulation({ seed, latency: [latency[0], latency[1]] });
      const nodes = await sim.addNodes(Array.from({ length: count }, (_, i) => ({ name: `t${i}` })));
      expect(await sim.waitForLedger(8, 120_000)).toBe(true);
      expect(sim.historyConflicts()).toEqual([]);
      for (const n of nodes) {
        expect(n.forks, `${n.name} forks`).toEqual([]);
        expect(qsetNodes(n.node!.herder.scp.getLocalQuorumSet()).length, `${n.name} quorum`).toBe(count);
      }
      await sim.shutdown();
    });
  }

  it('control: without the grace period, tabs that start at the same time each close ledgers alone', async () => {
    const sim = new Simulation({ seed: 721, latency: [20, 150], nodeTuning: { participationGraceMs: 0 } });
    await sim.addNodes(Array.from({ length: 4 }, (_, i) => ({ name: `t${i}` })));
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    // nobody counted the others before they voted: each closed ledger 2 with a quorum of its own
    expect(sim.historyConflicts().length).toBeGreaterThan(0);
    await sim.shutdown();
  });
});
