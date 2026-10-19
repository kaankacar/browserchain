// Spec 1: four tabs of one browser are four validators. They sync, close
// ledgers together, agree on every hash, and see each other in the auto quorum.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, goHash, openNode, since, status, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

test('four tabs reach consensus and agree on every ledger', async ({ browser }, testInfo) => {
  const t0 = Date.now();
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    for (let i = 0; i < 4; i++) nodes.push(await openNode(context, 'transport=broadcast', `tab${i}`));
    expect(new Set(nodes.map((n) => n.info.nodeId)).size, 'distinct node ids').toBe(4);

    const synced = await waitAllSynced(nodes);
    testInfo.annotations.push({ type: 'timing', description: `all synced after ${since(t0)}` });
    const start = Math.max(...synced.map((s) => s.lcl.seq));

    const later = await waitMinLcl(nodes, start + 8, 150_000);
    testInfo.annotations.push({ type: 'timing', description: `LCL ${start} -> ${Math.min(...later.map((s) => s.lcl.seq))} after ${since(t0)}` });
    expect(later.every((s) => s.state === 'synced')).toBe(true);

    const shared = await expectSameChain(nodes);
    expect(shared).toBeGreaterThanOrEqual(start + 8);

    // The Validator page, as a user sees it: auto mode, 3 of 4, four validators.
    const page = nodes[0].page;
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Validator' }).click();
    const quorum = page.getByRole('region', { name: 'Quorum set' });
    await expect(quorum.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await expect(quorum.getByText('3 of 4', { exact: true }).first()).toBeVisible();
    await expect(quorum.locator('ul > li')).toHaveCount(4);
    const st = await status(page);
    expect(st.quorum.mode).toBe('auto');
    expect([...st.quorum.qset.validators].sort()).toEqual(nodes.map((n) => n.info.nodeId).sort());

    // The peers tab lists the three other tabs, each in our quorum.
    await goHash(page, '#/validator/peers');
    const peers = page.getByRole('region', { name: 'Connected peers' });
    await expect(peers.locator('tbody tr')).toHaveCount(3);
    await expect(peers.getByLabel('yes')).toHaveCount(3);

    // The header shows the live ledger number.
    await goHash(page, '#/');
    await expect(page.getByTitle('Last closed ledger')).toContainText(`#`);

    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
