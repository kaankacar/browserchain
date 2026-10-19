// Extra spec: two of four tabs crash (renderer killed over CDP: no pagehide,
// no bye). The two left must notice the departures, shrink the auto quorum
// and keep closing ledgers. New tabs then get the freed identity slots back
// and rejoin.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, openNode, since, statuses, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

test('two of four tabs crash: the rest recover liveness; new tabs rejoin with the freed identities', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    for (const label of ['A', 'B', 'C', 'D']) nodes.push(await openNode(context, 'transport=broadcast', label));
    const synced = await waitAllSynced(nodes);
    await waitMinLcl(nodes, Math.max(...synced.map((s) => s.lcl.seq)) + 2);
    const [A, B, C, D] = nodes;
    const crashed = [C, D];
    const crashedIds = crashed.map((n) => n.info.nodeId).sort();
    const crashedSlots = crashed.map((n) => n.info.slot).sort();
    for (const n of crashed) {
      const cdp = await context.newCDPSession(n.page);
      // the call never answers: the target is gone
      void cdp.send('Page.crash').catch(() => undefined);
    }
    const crashedAt = Date.now();
    nodes.splice(2, 2);

    // A and B (2 of the old 3-of-4 quorum) stall until they drop C and D, then go on as 2 of 2.
    const before = Math.max(...(await statuses([A, B])).map((s) => s.lcl.seq));
    await expect
      .poll(async () => (await statuses([A, B])).map((s) => `${s.quorum.qset.threshold}/${s.quorum.qset.validators.length}`).join(','), { timeout: 30_000 })
      .toBe('2/2,2/2');
    await waitMinLcl([A, B], before + 2, 40_000);
    testInfo.annotations.push({ type: 'timing', description: `2 of 4 crashed: ledgers closing again ${since(crashedAt)} later` });

    // Two new tabs claim the freed slots: the crashed validators come back.
    const E = await openNode(context, 'transport=broadcast', 'E');
    const F = await openNode(context, 'transport=broadcast', 'F');
    nodes.push(E, F);
    expect([E.info.slot, F.info.slot].sort()).toEqual(crashedSlots);
    expect([E.info.nodeId, F.info.nodeId].sort()).toEqual(crashedIds);
    await expect
      .poll(async () => {
        const st = await statuses(nodes);
        const net = Math.max(...st.map((s) => s.lcl.seq));
        return st.every((s) => s.state === 'synced' && s.lcl.seq >= net - 1 && s.quorum.qset.validators.length === 4);
      }, { timeout: 45_000 })
      .toBe(true);
    const back = Math.max(...(await statuses(nodes)).map((s) => s.lcl.seq));
    await waitMinLcl(nodes, back + 2, 30_000);
    await expectSameChain(nodes);
    for (const n of nodes) expect(await forks(n.page), `${n.label} forks`).toEqual([]);
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
