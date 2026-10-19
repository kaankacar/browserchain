// Spec 7: the other two ways to open the app.
// - ?fresh=1: an ephemeral identity on memory storage, no Web Lock slot, no
//   IndexedDB; still a full validator.
// - ?mock=1: the UI demo on simulated data (no worker), with the DEMO badge.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, openNode, waitAllSynced, waitMinLcl, watchErrors, type NodePage } from './helpers';

test('fresh mode: memory storage and a new identity per load, still validating', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    nodes.push(await openNode(context, 'fresh=1&transport=broadcast', 'fresh-a'));
    nodes.push(await openNode(context, 'fresh=1&transport=broadcast', 'fresh-b'));
    for (const n of nodes) {
      expect(n.info.storage).toBe('memory');
      expect(n.info.slot).toBeNull();
    }
    expect(nodes[0].info.nodeId).not.toBe(nodes[1].info.nodeId);
    const synced = await waitAllSynced(nodes);
    await waitMinLcl(nodes, Math.max(...synced.map((s) => s.lcl.seq)) + 2);
    await expectSameChain(nodes);

    // Nothing persistent: no slot lock, no IndexedDB database.
    const page = nodes[0].page;
    const held = await page.evaluate(async () => ((await navigator.locks.query()).held ?? []).map((l) => l.name));
    expect(held.filter((n) => n?.startsWith('browserchain:'))).toEqual([]);
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    expect(dbs.filter((n) => n?.startsWith('browserchain:'))).toEqual([]);

    // The UI is the real one: no demo badge, live ledger number, synced state.
    await expect(page.getByRole('link', { name: /main.*synced/i }).first()).toBeVisible();
    await expect(page.getByText('demo', { exact: true })).toHaveCount(0);
    await expect(page.getByTitle('Last closed ledger')).toContainText('#');
    // A new network: the ledger strip labels genesis (close time 0) instead of "20742d ago".
    const genesis = page.getByRole('list', { name: 'Most recent ledgers, newest first' }).locator('a[href="#/ledger/1"]');
    await expect(genesis).toContainText('genesis');
    await expect(genesis).not.toContainText('ago');

    // A reload starts over with another identity.
    const before = nodes[0].info.nodeId;
    await page.reload();
    await page.waitForFunction(() => !!window.__browserchain);
    const info = await page.evaluate(() => window.__browserchain!.ready);
    expect(info.nodeId).not.toBe(before);
    expect(info.storage).toBe('memory');
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});

test('mock mode: the demo renders on simulated data', async ({ page }) => {
  const errors: string[] = [];
  watchErrors(page, errors);
  await page.goto('/?mock=1#/');
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Last closed ledger')).toContainText('#');
  await expect(page.getByText('You are looking at simulated demo data.')).toBeVisible();
  expect(page.workers()).toHaveLength(0);

  // Every main section renders.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Validator' }).click();
  await expect(page.getByRole('region', { name: 'Quorum set' })).toBeVisible();
  await nav.getByRole('link', { name: 'Explorer' }).click();
  await expect(page.getByRole('main').locator('a[href^="#/ledger/"]').first()).toBeVisible();
  await nav.getByRole('link', { name: 'Wallet' }).click();
  await expect(page.getByRole('button', { name: 'Create a test account' })).toBeVisible();
  await nav.getByRole('link', { name: 'Lab' }).click();
  await expect(page.getByRole('button', { name: 'Latest transaction' })).toBeVisible();
  await nav.getByRole('link', { name: 'About' }).click();
  await expect(page.getByRole('main')).toContainText('SCP');
  expect(errors).toEqual([]);
});

// The demo flags play two node states that need the user: a group of
// validators this tab does not know runs another chain (the node keeps its
// own and re-reports the fork), and peers are ahead but this tab cannot catch
// up from them safely, so it does not vote. Both offer a resync, confirmed in
// the page (no window.confirm).
test('mock mode: the demo flags show a fork with unknown validators and a blocked catch-up', async ({ page }) => {
  const errors: string[] = [];
  watchErrors(page, errors);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const nav = page.getByRole('navigation', { name: 'Main' });
  const pill = page.getByRole('banner').getByRole('link', { name: /^main/ });

  await page.goto('/?mock=1&demo=strangers#/');
  const strangers = page.getByText('Another group of validators is on a different chain');
  await expect(strangers).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('main')).toContainText('3 validators that this tab did not know before');
  await expect(page.getByRole('main')).toContainText('every tab of this browser that shows this alert');
  await nav.getByRole('link', { name: 'Validator' }).click();
  await expect(strangers).toBeVisible();
  await page.getByRole('button', { name: 'Resync to join them' }).click();
  const join = page.getByRole('dialog', { name: 'Resync to join the other group?' });
  await expect(join).toBeVisible();
  await expect(join).toContainText('identity');
  await join.getByRole('button', { name: 'Wipe and resync' }).click();
  await expect(strangers).toBeHidden();
  await expect(page.getByText('Resync started')).toBeVisible();
  // in sync on the other chain: the earlier reports do not bring the alert back
  await expect(pill).toHaveAccessibleName(/synced/i, { timeout: 15_000 });
  await page.waitForTimeout(12_000);
  await expect(strangers).toHaveCount(0);

  await page.goto('/?mock=1&demo=blocked#/');
  const blocked = page.getByText('This node is not voting');
  await expect(blocked).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('main')).toContainText('validators this tab did not know before');
  await expect(pill).toHaveAccessibleName(/blocked/i);
  await expect(pill).not.toHaveAccessibleName(/synced/i);
  await expect(page.getByRole('region', { name: 'Last closed ledger' }).getByText('Blocked', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Validator' }).click();
  await expect(blocked).toBeVisible();
  await expect(page.getByRole('region', { name: 'This node' }).getByText('Blocked', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resync to join them' }).click();
  const resync = page.getByRole('dialog', { name: 'Resync to join the peers ahead?' });
  await expect(resync).toBeVisible();
  await resync.getByRole('button', { name: 'Wipe and resync' }).click();
  await expect(blocked).toBeHidden({ timeout: 15_000 });
  await expect(pill).toHaveAccessibleName(/synced/i, { timeout: 15_000 });

  // phone width: the alert and its button fit
  await page.goto('/?mock=1&demo=strangers#/');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(strangers).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Resync to join them' })).toBeInViewport();
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});
