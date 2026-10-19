// Spec 5: a closed tab gives back its identity slot. A new tab claims the
// freed Web Locks slot, so it is the same validator (same node id) on the
// same IndexedDB chain; it catches up the ledgers it missed and validates
// again.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, nodeLog, openNode, since, status, statuses, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

test('closed tab: the next tab reuses its slot, identity and stored chain, then catches up', async ({ browser }, testInfo) => {
  const t0 = Date.now();
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    for (const label of ['A', 'B', 'C', 'D']) nodes.push(await openNode(context, 'transport=broadcast', label));
    for (const n of nodes) expect(n.info.storage).toBe('indexeddb');
    expect(nodes.map((n) => n.info.slot).sort()).toEqual([0, 1, 2, 3]);
    const synced = await waitAllSynced(nodes);
    await waitMinLcl(nodes, Math.max(...synced.map((s) => s.lcl.seq)) + 3);

    // Close D. Its bye drops it from the others' quorum.
    const D = nodes[3];
    const others = nodes.slice(0, 3);
    const dLcl = (await status(D.page)).lcl.seq;
    await D.page.close();
    nodes.pop();
    testInfo.annotations.push({ type: 'timing', description: `D closed at LCL ${dLcl} (slot ${D.info.slot}) after ${since(t0)}` });
    await expect
      .poll(async () => (await statuses(others)).map((s) => s.quorum.qset.validators.length).join(','), { timeout: 20_000 })
      .toBe('3,3,3');

    // The others keep closing ledgers without D.
    const closed = await waitMinLcl(others, dLcl + 5, 60_000);
    testInfo.annotations.push({ type: 'timing', description: `others reached ${Math.min(...closed.map((s) => s.lcl.seq))} after ${since(t0)}` });

    // A new tab gets D's slot back: same node id, same IndexedDB chain.
    const t1 = Date.now();
    const E = await openNode(context, 'transport=broadcast', 'E');
    nodes.push(E);
    expect(E.info.slot).toBe(D.info.slot);
    expect(E.info.storage).toBe('indexeddb');
    expect(E.info.nodeId).toBe(D.info.nodeId);
    const loaded = /ledger (\d+) loaded/.exec(await nodeLog(E.page, 300));
    expect(loaded, 'load line in the node log').not.toBeNull();
    // the stored chain is there (it may miss the last ledger or two that were not flushed yet)
    expect(Number(loaded![1])).toBeGreaterThanOrEqual(dLcl - 2);

    // It catches up and validates again: synced, in everyone's quorum, closing ledgers by consensus.
    await expect
      .poll(
        async () => {
          const net = Math.max(...(await statuses(others)).map((s) => s.lcl.seq));
          const e = await status(E.page);
          return e.state === 'synced' && e.isValidator && e.lcl.seq >= net - 1;
        },
        { timeout: 45_000, intervals: [500, 1000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `E synced ${since(t1)} after opening` });
    await expect
      .poll(async () => (await statuses(nodes)).every((s) => s.quorum.qset.validators.includes(E.info.nodeId)), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(() => E.page.evaluate(() => window.__browserchain!.getStats().then((s) => s.ledgersClosedHere)), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    testInfo.annotations.push({ type: 'timing', description: `E validating ${since(t1)} after opening` });
    const caught = /caught up to (\d+) from .*?, (\d+) ledgers replayed/.exec(await nodeLog(E.page, 300));
    if (caught) testInfo.annotations.push({ type: 'catch-up', description: caught[0] });

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
