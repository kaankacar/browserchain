// Shared helpers for the Byzantine simulation tests.

import { expect } from 'vitest';
import { ScpTestNetwork, bftThreshold, flatQSet, makeSimValue, parseSimValue, type ByzantineMode } from './testnet';
import type { NominatePledge } from './types';

export const BYZ_SLOTS = 20;

export async function runByzantine(n: number, byzantine: number[], mode: ByzantineMode, seed: number, signing: boolean) {
  const net = new ScpTestNetwork({ seed, signing });
  const nodes = net.addNodes(
    Array.from({ length: n }, (_, i) => ({
      name: `byz-${mode}-${n}-${seed}-${i}`,
      byzantine: byzantine.includes(i) ? mode : undefined,
    })),
    (ids) => flatQSet(ids, bftThreshold(n)),
  );
  const ok = await net.run(BYZ_SLOTS, BYZ_SLOTS * 20_000);
  return { net, nodes, ok };
}

/** Honest nodes agree on every slot, externalized all of them, and only valid values. */
export function checkByzantineRun(net: ScpTestNetwork, ok: boolean): void {
  net.checkSafety();
  expect(ok, 'all honest nodes externalized every slot').toBe(true);
  for (const node of net.honestLive()) {
    for (let slot = 1; slot <= BYZ_SLOTS; slot++) {
      const v = node.externalized.get(slot)!;
      expect(v).toBe(net.decided.get(slot));
      expect(parseSimValue(v)?.slot).toBe(slot);
    }
  }
  expect(net.maxSlotLatency()).toBeLessThanOrEqual(30_000);
}

/** True if honest nodes of the two peer groups hold conflicting nominations from the Byzantine node. */
export function sawConflictingNominations(net: ScpTestNetwork, byzIndex: number): boolean {
  const byz = net.nodes[byzIndex];
  const honest = net.honestLive();
  for (const slot of honest[0].scp.getKnownSlots()) {
    const own = (group: number) => makeSimValue(slot, byzIndex, group === 0 ? 7001 : 7002);
    const seen = (node: (typeof honest)[number]) => {
      const st = node.scp.getSlotInfo(slot)?.latestStatements.find((s) => s.nodeId === byz.id)?.nomination
        ?.pledges as NominatePledge | undefined;
      return st?.votes ?? [];
    };
    const a = honest.find((h) => h.index % 2 === 0 && seen(h).includes(own(0)));
    const b = honest.find((h) => h.index % 2 === 1 && seen(h).includes(own(1)));
    if (a && b && !seen(a).includes(own(1)) && !seen(b).includes(own(0))) return true;
  }
  return false;
}
