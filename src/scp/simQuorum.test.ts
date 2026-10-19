// SCP simulation with nested quorum sets and quorum set changes during a
// slot (updateLocalQuorumSet).

import { describe, expect, it } from 'vitest';
import { normalizeQSet } from './quorum';
import { ScpTestNetwork, flatQSet, makeSimValue, parseSimValue, type SimNode } from './testnet';
import type { NodeId, QuorumSet } from './types';
import { hashQuorumSet } from './xdr';

const SLOTS = 20;

function checkAll(net: ScpTestNetwork, ok: boolean, maxSlotMs = 30_000): void {
  net.checkSafety();
  expect(ok, 'every honest live node externalized every slot').toBe(true);
  for (const node of net.honestLive()) {
    for (let slot = 1; slot <= SLOTS; slot++) {
      const v = node.externalized.get(slot)!;
      expect(v).toBe(net.decided.get(slot));
      expect(parseSimValue(v)?.slot).toBe(slot);
    }
  }
  expect(net.maxSlotLatency()).toBeLessThanOrEqual(maxSlotMs);
}

// organizations of 3 with inner threshold 2; top threshold 2 of 3
function orgsQSet(ids: NodeId[]): QuorumSet {
  const orgs: QuorumSet[] = [];
  for (let o = 0; o < ids.length / 3; o++) orgs.push({ threshold: 2, validators: ids.slice(o * 3, o * 3 + 3), innerSets: [] });
  return { threshold: 2, validators: [], innerSets: orgs };
}

describe('nested quorum sets (organizations of 3, inner threshold 2)', () => {
  it(`3 organizations, top threshold 2: 20 seeds x ${SLOTS} slots`, async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const net = new ScpTestNetwork({ seed });
      net.addNodes(
        Array.from({ length: 9 }, (_, i) => ({ name: `org-${seed}-${i}` })),
        (ids) => orgsQSet(ids),
      );
      const ok = await net.run(SLOTS, SLOTS * 15_000);
      checkAll(net, ok, 10_000);
    }
  });

  it('one crashed node in every organization: 10 seeds', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const net = new ScpTestNetwork({ seed });
      const crashed = new Set([seed % 3, 3 + ((seed + 1) % 3), 6 + ((seed + 2) % 3)]);
      net.addNodes(
        Array.from({ length: 9 }, (_, i) => ({ name: `org1-${seed}-${i}`, crashed: crashed.has(i) })),
        (ids) => orgsQSet(ids),
      );
      const ok = await net.run(SLOTS, SLOTS * 20_000);
      checkAll(net, ok);
    }
  });

  it('a whole organization crashed (2 of 3 remain): 10 seeds', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const net = new ScpTestNetwork({ seed });
      const org = seed % 3;
      net.addNodes(
        Array.from({ length: 9 }, (_, i) => ({ name: `orgdown-${seed}-${i}`, crashed: Math.floor(i / 3) === org })),
        (ids) => orgsQSet(ids),
      );
      const ok = await net.run(SLOTS, SLOTS * 20_000);
      checkAll(net, ok);
    }
  });

  it('heterogeneous nested sets: 4 organizations, top threshold 3, mixed inner thresholds', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const net = new ScpTestNetwork({ seed });
      net.addNodes(
        Array.from({ length: 12 }, (_, i) => ({ name: `org4-${seed}-${i}`, crashed: i === seed % 12 })),
        (ids) => ({
          threshold: 3,
          validators: [],
          innerSets: [0, 1, 2, 3].map((o) => ({ threshold: 2, validators: ids.slice(o * 3, o * 3 + 3), innerSets: [] })),
        }),
      );
      const ok = await net.run(SLOTS, SLOTS * 20_000);
      checkAll(net, ok);
    }
  });
});

describe('quorum set change mid-slot (updateLocalQuorumSet)', () => {
  // every pair of quorums intersects: each slice has at least 3 of the 5 nodes
  const variants = (ids: NodeId[]): QuorumSet[] => [
    flatQSet(ids, 4),
    flatQSet(ids, 3),
    {
      threshold: 2,
      validators: [],
      innerSets: [
        { threshold: 2, validators: ids.slice(0, 3), innerSets: [] },
        { threshold: 1, validators: ids.slice(3), innerSets: [] },
      ],
    },
  ];

  it('random changes at random times during the run: 30 seeds, safety + liveness + announced hashes', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const net = new ScpTestNetwork({ seed });
      const nodes = net.addNodes(
        Array.from({ length: 5 }, (_, i) => ({ name: `qchg-${seed}-${i}` })),
        (ids) => flatQSet(ids, 4),
      );
      const ids = nodes.map((n) => n.id);
      const changes: { node: SimNode; logIndex: number; hash: string }[] = [];
      for (let k = 0; k < 40; k++) {
        const node = nodes[Math.floor(net.rng() * nodes.length)];
        const q = variants(ids)[Math.floor(net.rng() * 3)];
        net.clock.setTimeout(() => {
          const logIndex = node.emittedLog.length;
          net.updateQSet(node, q);
          const hash = node.scp.getLocalQuorumSetHash();
          // the local set is the normalized one
          expect(hash).toBe(hashQuorumSet(normalizeQSet(q)));
          changes.push({ node, logIndex, hash });
        }, net.rng() * 15_000);
      }
      const ok = await net.run(SLOTS, SLOTS * 15_000);
      checkAll(net, ok, 10_000);

      // the first statement emitted after a change carries the new hash
      // (unless the same node changed again before emitting)
      expect(changes.length).toBe(40);
      let checked = 0;
      changes.forEach((c, i) => {
        const next = c.node.emittedLog[c.logIndex];
        const superseded = changes.slice(i + 1).some((d) => d.node === c.node && d.logIndex === c.logIndex);
        if (next && !superseded) {
          expect(next.qsetHash).toBe(c.hash);
          checked++;
        }
      });
      expect(checked).toBeGreaterThan(20);
    }
  });

  it('departure: 2 of 5 crash mid-slot, survivors switch to a quorum set over themselves: 30 seeds', async () => {
    // Herder recipe after removals: updateLocalQuorumSet (re-evaluates open
    // slots), then announce the new set with a newer statement: abandonBallot,
    // or refreshNomination with a fresh value while still nominating.
    for (let seed = 1; seed <= 30; seed++) {
      const net = new ScpTestNetwork({ seed });
      const nodes = net.addNodes(
        Array.from({ length: 5 }, (_, i) => ({ name: `depart-${seed}-${i}` })),
        (ids) => flatQSet(ids, 4),
      );
      const live = nodes.slice(0, 3);
      const liveIds = live.map((n) => n.id);
      net.clock.setTimeout(() => {
        nodes[3].crash();
        nodes[4].crash();
        for (const n of live) {
          net.clock.setTimeout(() => {
            net.updateQSet(n, flatQSet(liveIds, 2));
            const slot = n.lcl + 1;
            if (!n.scp.abandonBallot(slot)) n.scp.refreshNomination(slot, makeSimValue(slot, n.index, 1_000 + seed));
          }, 100 + net.rng() * 2_000);
        }
      }, 3_000 + net.rng() * 4_000);

      const ok = await net.run(SLOTS, SLOTS * 15_000);
      checkAll(net, ok);
      for (const n of live) expect(n.scp.getLocalQuorumSet()).toEqual(normalizeQSet(flatQSet(liveIds, 2)));
    }
  });

  it('without a quorum set change the survivors cannot progress (no quorum), and stay safe', async () => {
    const net = new ScpTestNetwork({ seed: 5 });
    const nodes = net.addNodes(
      Array.from({ length: 5 }, (_, i) => ({ name: `stuck-${i}` })),
      (ids) => flatQSet(ids, 4),
    );
    net.clock.setTimeout(() => {
      nodes[3].crash();
      nodes[4].crash();
    }, 5_000);
    const ok = await net.run(SLOTS, 60_000);
    expect(ok).toBe(false);
    net.checkSafety();
    const stuckAt = Math.min(...nodes.slice(0, 3).map((n) => n.lcl));
    expect(stuckAt).toBeLessThan(SLOTS);
  });
});
