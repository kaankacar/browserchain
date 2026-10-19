// Spec 2: the wallet through the UI on the real node. Page A creates and
// funds a key, page B adds a receiving key, A sends it 100 XLM, B sees the
// balance after the next ledger and the explorer on page C shows the tx.
// All pages share one localStorage (same origin), so they share one wallet
// key list: a key made in one tab must show up in the others and never be
// lost when another tab saves its list.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, goHash, openNode, since, status, waitAllSynced, type NodePage } from './helpers';
import { selectedAccountId, walletKeys } from './ui';

test('wallet: fund, send 100 XLM, see it on another tab and in the explorer', async ({ browser }, testInfo) => {
  const t0 = Date.now();
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, 'transport=broadcast', 'A', '#/wallet');
    const B = await openNode(context, 'transport=broadcast', 'B', '#/wallet');
    const C = await openNode(context, 'transport=broadcast', 'C', '#/');
    nodes.push(A, B, C);
    await waitAllSynced(nodes);

    // A: a new key, funded by friendbot.
    await A.page.getByRole('button', { name: 'Create a test account' }).click();
    await expect(A.page.getByRole('list', { name: 'Balances' })).toContainText('10,000', { timeout: 60_000 });
    const sender = await selectedAccountId(A.page);
    testInfo.annotations.push({ type: 'timing', description: `sender funded after ${since(t0)}` });

    // B was open before the key existed; it shows the shared key list and adds a receiving key.
    const keysB = B.page.getByRole('list', { name: 'Wallet keys' });
    await expect(keysB).toContainText('Account 1', { timeout: 10_000 });
    await B.page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(keysB.getByRole('button')).toHaveCount(2);
    await expect(B.page.getByText('This account is not on the network yet')).toBeVisible();
    const receiver = await selectedAccountId(B.page);
    expect(receiver).not.toBe(sender);

    // A sees the new key too (it is offered as a destination), and still has its own.
    await expect(A.page.getByRole('list', { name: 'Wallet keys' }).getByRole('button')).toHaveCount(2, { timeout: 10_000 });
    expect((await walletKeys(A.page)).map((k) => k.publicKey).sort()).toEqual([sender, receiver].sort());

    // A sends 100 XLM; the receiver does not exist yet, so this creates it.
    await A.page.getByLabel('Destination').fill(receiver);
    await A.page.getByLabel('Amount', { exact: true }).fill('100');
    await A.page.getByLabel('Memo (optional)').fill('e2e payment');
    await A.page.getByRole('button', { name: 'Send', exact: true }).click();
    const applied = A.page.getByText(/Applied in ledger #/);
    await expect(applied).toBeVisible({ timeout: 60_000 });
    const appliedSeq = Number((await applied.textContent())!.replace(/\D/g, ''));
    const txHref = await A.page.getByRole('link', { name: 'View transaction' }).getAttribute('href');
    const txHash = txHref!.replace('#/tx/', '');
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
    testInfo.annotations.push({ type: 'timing', description: `payment applied in ledger ${appliedSeq} after ${since(t0)}` });

    // B: the receiver's balance shows after the next ledger.
    await expect(B.page.getByRole('list', { name: 'Balances' })).toContainText('100', { timeout: 15_000 });
    expect((await status(B.page)).lcl.seq).toBeLessThanOrEqual(appliedSeq + 2);
    await expect(A.page.getByRole('list', { name: 'Balances' })).toContainText('9,899.9999');

    // C: the explorer finds the transaction by its hash. Below 1536 px the
    // header shows a search button instead of the box.
    const search = C.page.getByLabel('Search accounts, transactions and ledgers').filter({ visible: true });
    if ((await search.count()) === 0) await C.page.getByRole('button', { name: 'Search', exact: true }).click();
    await search.first().fill(txHash);
    await C.page.keyboard.press('Enter');
    await expect(C.page).toHaveURL(new RegExp(`#/tx/${txHash}$`));
    await expect(C.page.getByRole('heading', { name: 'Applied successfully' })).toBeVisible();
    await expect(C.page.getByText('e2e payment')).toBeVisible();
    await expect(C.page.getByRole('main').getByRole('link', { name: `#${appliedSeq}` }).first()).toBeVisible();
    // ... and on the receiver's account page: the balance and the tx in its history.
    await goHash(C.page, `#/account/${receiver}`);
    const row = C.page.getByRole('region', { name: 'Balances', exact: true }).locator('tbody tr').first();
    await expect(row.locator('td').nth(1)).toHaveText('100');
    await expect(C.page.getByRole('region', { name: 'History' }).locator(`a[href="#/tx/${txHash}"]`).first()).toBeVisible();

    // Both keys are still saved in the shared list.
    expect((await walletKeys(B.page)).map((k) => k.publicKey).sort()).toEqual([sender, receiver].sort());
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
