// Two groups of validators that formed apart meet (ARCHITECTURE 12.3, V-2).
// Group B (two tabs with stored identities) closes ledgers together, then
// its tabs close. Group A (two fresh tabs) starts a chain of its own from
// genesis and never sees B. B's tabs come back with their stored chain. To
// each group the other one is validators it did not know before the fork
// point, so nobody rolls back; the tabs report the fork with
// unknownValidators, again while it lasts, and the UI shows it. B's tabs
// resync: they wipe their chain and join A's as fresh nodes. BroadcastChannel
// only, and every WebSocket is mocked, as in fork.spec.ts.
import { expect, test } from '@playwright/test';
import type { ForkInfo } from '../src/node/api';
import { attachDiagnostics, expectSameChain, forks, openNode, since, statuses, uniqueNetwork, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

const isStrangerReport = (f: ForkInfo) => f.resolution === 'kept-ours' && (f.unknownValidators ?? 0) > 0;

test('two groups that formed apart meet: they report each other, and a resync joins the other group', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  await context.routeWebSocket(/.*/, () => undefined);
  const network = uniqueNetwork('stranger');
  const q = `transport=broadcast&network=${network}`;
  const nodes: NodePage[] = [];
  try {
    // group B: two tabs with stored identities close a few ledgers together
    const b1First = await openNode(context, q, 'B1');
    const b2First = await openNode(context, q, 'B2');
    const groupB = [b1First, b2First];
    nodes.push(...groupB);
    await waitAllSynced(groupB);
    await waitMinLcl(groupB, 4);
    const bLedger2 = (await b1First.page.evaluate(() => window.__browserchain!.getLedger(2)))!.hash;
    const bIds = groupB.map((n) => n.info.nodeId).sort();
    for (const n of groupB) await n.page.close();
    nodes.length = 0;

    // group A: two fresh tabs start a chain of their own from genesis
    const a1 = await openNode(context, `fresh=1&${q}`, 'A1');
    const a2 = await openNode(context, `fresh=1&${q}`, 'A2');
    const groupA = [a1, a2];
    nodes.push(...groupA);
    await waitAllSynced(groupA);
    await waitMinLcl(groupA, 4);
    const aLedger2 = (await a1.page.evaluate(() => window.__browserchain!.getLedger(2)))!.hash;
    expect(aLedger2, 'the groups built different chains').not.toBe(bLedger2);

    // group B comes back: same identities, same stored chain
    const t0 = Date.now();
    const b1 = await openNode(context, q, 'B1');
    const b2 = await openNode(context, q, 'B2');
    const back = [b1, b2];
    nodes.push(...back);
    expect(back.map((n) => n.info.nodeId).sort()).toEqual(bIds);

    // each tab of B reports that 2 validators it did not know are on the other branch
    for (const n of back) {
      await expect
        .poll(async () => (await forks(n.page)).filter(isStrangerReport).map((f) => [f.atSeq, f.unknownValidators]), { timeout: 90_000 })
        .toContainEqual([2, 2]);
    }
    testInfo.annotations.push({ type: 'timing', description: `both B tabs reported the strangers ${since(t0)} after they came back` });
    // the UI shows it
    await expect(b1.page.getByText('Another group of validators is on a different chain')).toBeVisible({ timeout: 30_000 });

    // nobody follows the strangers: each group keeps its chain and goes on
    const before = await statuses(nodes);
    await waitMinLcl(nodes, Math.max(...before.map((s) => s.lcl.seq)) + 2, 60_000);
    for (const n of nodes) expect((await forks(n.page)).filter((f) => f.resolution === 'rolled-back'), `${n.label} rollbacks`).toEqual([]);
    const ledger2 = await Promise.all(nodes.map((n) => n.page.evaluate(() => window.__browserchain!.getLedger(2).then((l) => l?.hash ?? null))));
    expect(ledger2).toEqual([aLedger2, aLedger2, bLedger2, bLedger2]);

    // while it lasts, the fork is reported again, so the alert stays fresh
    // (the node's list keeps the newest report of it; the events carry each one)
    const newestReport = async () => Math.max(...(await forks(b1.page)).filter(isStrangerReport).map((f) => f.ts));
    const firstSeen = await newestReport();
    await expect.poll(newestReport, { timeout: 60_000, intervals: [2000] }).toBeGreaterThanOrEqual(firstSeen + 10_000);
    expect((await forks(b1.page)).filter((f) => isStrangerReport(f) && f.atSeq === 2).length, 'one entry per stranger fork').toBe(1);

    // every B tab resyncs (as the alert says): they wipe their chain and join A's as fresh nodes
    const t1 = Date.now();
    await Promise.all(back.map((n) => n.page.evaluate(() => window.__browserchain!.resync())));
    await expect
      .poll(
        async () => {
          const st = await statuses(nodes);
          return st.every((s) => s.state === 'synced' && s.quorum.qset.validators.length === 4) && new Set(st.map((s) => s.lcl.hash)).size === 1;
        },
        { timeout: 90_000, intervals: [500, 1000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `one chain of 4 ${since(t1)} after the resync` });
    for (const n of back) {
      expect(await n.page.evaluate(() => window.__browserchain!.getLedger(2).then((l) => l?.hash ?? null)), `${n.label} ledger 2`).toBe(aLedger2);
    }
    const start = Math.max(...(await statuses(nodes)).map((s) => s.lcl.seq));
    await waitMinLcl(nodes, start + 2, 30_000);
    await expectSameChain(nodes);
    for (const n of nodes) {
      expect((await forks(n.page)).filter((f) => f.resolution === 'rolled-back'), `${n.label} rollbacks`).toEqual([]);
      expect(n.errors, `${n.label} console errors`).toEqual([]);
    }
  } catch (err) {
    await attachDiagnostics(testInfo, nodes.filter((n) => !n.page.isClosed()));
    throw err;
  } finally {
    await context.close();
  }
});
