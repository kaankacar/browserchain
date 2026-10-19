// UI lens spec: the wallet activity list is shared by every tab of the
// browser (one localStorage). A tab must never drop entries another tab
// added: tabs merge the list by tx hash and show each other's entries live.
// "Clear" clears the list in every tab, and cleared entries stay cleared.
import { expect, test, type Page } from '@playwright/test';
import { attachDiagnostics, openNode, uniqueNetwork, waitAllSynced, type NodePage } from './helpers';

/** Hashes in the saved activity list (any stored format). */
function storedHashes(page: Page, network: string): Promise<string[]> {
  return page.evaluate((net) => {
    const raw = localStorage.getItem(`browserchain:wallet:activity:${net}`);
    const v: unknown = raw ? JSON.parse(raw) : [];
    const items = (Array.isArray(v) ? v : ((v as { items?: unknown[] }).items ?? [])) as { hash: string }[];
    return items.map((a) => a.hash).sort();
  }, network);
}

function activityRows(page: Page) {
  return page.getByRole('region', { name: 'Activity' }).locator('li');
}

test('wallet activity: tabs merge the shared list by tx hash and clear it together', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const network = uniqueNetwork('activity');
  const q = `transport=broadcast&network=${network}`;
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, q, 'A', '#/wallet/activity');
    const B = await openNode(context, q, 'B', '#/wallet/activity');
    nodes.push(A, B);
    await waitAllSynced(nodes);

    // A creates and funds Account 1: its entry is saved.
    await A.page.getByRole('button', { name: 'Create a test account' }).click();
    await expect(activityRows(A.page).filter({ hasText: 'Account 1' })).toContainText('Applied', { timeout: 60_000 });
    await expect.poll(() => storedHashes(A.page, network)).toHaveLength(1);

    // B loaded the list while it was empty. It sees A's entry, then funds Account 2.
    await expect(activityRows(B.page).filter({ hasText: 'Account 1' })).toBeVisible({ timeout: 10_000 });
    await B.page.getByRole('button', { name: 'New', exact: true }).click();
    await B.page.getByRole('button', { name: 'Fund with friendbot' }).click();
    await expect(activityRows(B.page).filter({ hasText: 'Account 2' })).toContainText('Applied', { timeout: 60_000 });

    // Both entries are saved, and both tabs list both with their final status.
    await expect.poll(() => storedHashes(B.page, network)).toHaveLength(2);
    for (const n of nodes) {
      await expect(activityRows(n.page), `${n.label} rows`).toHaveCount(2, { timeout: 10_000 });
      await expect(activityRows(n.page).filter({ hasText: 'Applied' }), `${n.label} applied rows`).toHaveCount(2, { timeout: 15_000 });
    }

    // A reload keeps both.
    await A.page.reload();
    await A.page.waitForFunction(() => !!window.__browserchain);
    await expect(activityRows(A.page)).toHaveCount(2, { timeout: 15_000 });

    // Clear in B clears A too, and a later entry from A does not bring the old ones back.
    await B.page.getByRole('region', { name: 'Activity' }).getByRole('button', { name: 'Clear' }).click();
    for (const n of nodes) await expect(n.page.getByText('Nothing sent yet'), `${n.label} cleared`).toBeVisible({ timeout: 10_000 });
    await A.page.getByRole('list', { name: 'Wallet keys' }).getByRole('button', { name: /^Account 1\b/ }).click();
    await A.page.getByRole('button', { name: 'Top up' }).click();
    for (const n of nodes) {
      await expect(activityRows(n.page), `${n.label} rows after clear`).toHaveCount(1, { timeout: 10_000 });
      await expect(activityRows(n.page)).toContainText('Friendbot top-up');
    }
    await expect.poll(() => storedHashes(A.page, network)).toHaveLength(1);
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
