// Verifier spec: the stranger-fork story through the UI (ARCHITECTURE 12.3,
// 14). Two groups of validators that formed apart meet. Each tab shows the
// "Another group of validators" alert. The user of each B tab presses
// "Resync to join them" and confirms in the page. The B tabs then join A's
// chain, the alert goes away on every tab, and nobody rolls back.
// BroadcastChannel only, and every WebSocket is mocked, as in fork.spec.ts.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, openNode, since, statuses, uniqueNetwork, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

const ALERT = 'Another group of validators is on a different chain';

test('two groups that formed apart: every tab shows the alert, and Resync in the UI joins the other group', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  await context.routeWebSocket(/.*/, () => undefined);
  const network = uniqueNetwork('stranger-ui');
  const q = `transport=broadcast&network=${network}`;
  const nodes: NodePage[] = [];
  try {
    // group B: two tabs with stored identities close a few ledgers, then close
    const groupB = [await openNode(context, q, 'B1'), await openNode(context, q, 'B2')];
    nodes.push(...groupB);
    await waitAllSynced(groupB);
    await waitMinLcl(groupB, 4);
    for (const n of groupB) await n.page.close();
    nodes.length = 0;

    // group A: two fresh tabs start a chain of their own from genesis
    const groupA = [await openNode(context, `fresh=1&${q}`, 'A1'), await openNode(context, `fresh=1&${q}`, 'A2')];
    nodes.push(...groupA);
    await waitAllSynced(groupA);
    await waitMinLcl(groupA, 4);
    const aLedger2 = (await groupA[0].page.evaluate(() => window.__browserchain!.getLedger(2)))!.hash;

    // group B comes back with its stored chain
    const t0 = Date.now();
    const back = [await openNode(context, q, 'B1'), await openNode(context, q, 'B2')];
    nodes.push(...back);

    // 2 against 2: every tab shows the alert
    for (const n of nodes) await expect(n.page.getByText(ALERT), `${n.label} alert`).toBeVisible({ timeout: 90_000 });
    testInfo.annotations.push({ type: 'timing', description: `every tab showed the alert ${since(t0)} after B came back` });

    // the user of each B tab resyncs from the alert and confirms in the page
    // (both at about the same time: once one B tab has moved, the other one
    // sees a validator it knew on A's chain, and the fork rule decides)
    const dialogs = [];
    for (const n of back) {
      await n.page.getByRole('button', { name: 'Resync to join them' }).click();
      const dialog = n.page.getByRole('dialog', { name: 'Resync to join the other group?' });
      await expect(dialog).toBeVisible();
      dialogs.push(dialog);
    }
    await Promise.all(dialogs.map((d) => d.getByRole('button', { name: 'Wipe and resync' }).click()));
    for (const n of back) {
      await expect(n.page.getByText('Resync started')).toBeVisible();
      await expect(n.page.getByText(ALERT)).toBeHidden();
    }

    // one chain of 4: A's
    const t1 = Date.now();
    await expect
      .poll(
        async () => {
          const st = await statuses(nodes);
          return st.every((s) => s.state === 'synced' && s.quorum.qset.validators.length === 4) && new Set(st.map((s) => s.lcl.hash)).size === 1;
        },
        { timeout: 90_000, intervals: [500, 1000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `one chain of 4 ${since(t1)} after the resyncs` });
    for (const n of back) {
      expect(await n.page.evaluate(() => window.__browserchain!.getLedger(2).then((l) => l?.hash ?? null)), `${n.label} ledger 2`).toBe(aLedger2);
    }

    // the fork is over: the alert leaves every tab once the last report is old
    for (const n of nodes) await expect(n.page.getByText(ALERT), `${n.label} alert after the merge`).toBeHidden({ timeout: 75_000 });
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
