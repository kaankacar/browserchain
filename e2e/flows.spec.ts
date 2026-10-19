// Spec 4: the twelve UI flows of src/ui/dev/flows.mjs (written against the
// mock), on the real node. One tab drives the UI; a second tab is a peer
// validator, so ledgers close by consensus of two nodes (about every 5 s).
// Waits are on state ("Applied in ledger"), never on time.
//
// Adapted: flow 5 bought USDB from the order book the mock seeds. The real
// network starts empty, so Account 1 first offers its PIZZA on the book and
// Account 2 trusts PIZZA and buys from that ask.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { attachDiagnostics, goHash, openNode, waitAllSynced, type NodePage } from './helpers';
import { selectKey, waitApplied, walletKeys } from './ui';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let nodes: NodePage[] = [];
let page: Page;
let first = '';
let second = '';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  const main = await openNode(context, 'transport=broadcast', 'ui', '#/wallet');
  const peer = await openNode(context, 'transport=broadcast', 'peer', '#/');
  nodes = [main, peer];
  page = main.page;
  await waitAllSynced(nodes);
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) await attachDiagnostics(testInfo, nodes);
});

test.afterAll(async () => {
  await context?.close();
});

/** Navigate inside the app (no reload). */
async function go(hash: string): Promise<void> {
  await goHash(page, hash);
  await expect(page).toHaveURL(new RegExp(`${hash.replace(/[/?]/g, '\\$&')}$`));
}

test('1. create and fund the first account', async () => {
  await page.getByRole('button', { name: 'Create a test account' }).click();
  await expect(page.getByText('10,000 XLM').first()).toBeVisible({ timeout: 60_000 });
  first = (await walletKeys(page)).find((k) => k.name === 'Account 1')!.publicKey;
});

test('2. create and fund a second account', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Fund with friendbot' }).first().click();
  await expect(page.getByText('Funding this account').first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('10,000 XLM').nth(1)).toBeVisible({ timeout: 60_000 });
  second = (await walletKeys(page)).find((k) => k.name === 'Account 2')!.publicKey;
});

test('3. send a payment with a memo', async () => {
  await selectKey(page, 'Account 1');
  await go('#/wallet/send');
  await page.getByLabel('Destination').fill(second);
  await page.getByLabel('Amount', { exact: true }).fill('12.5');
  await page.getByLabel('Memo (optional)').fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitApplied(page);
});

test('4. issue an asset', async () => {
  await go('#/wallet/issue');
  await page.getByLabel('Asset code').fill('PIZZA');
  await page.getByLabel('Amount to mint').fill('500');
  await page.getByRole('button', { name: 'Issue asset' }).click();
  await expect(page.getByText('PIZZA is live')).toBeVisible({ timeout: 90_000 });
});

test('5. trust an asset and buy from the book (adapted: PIZZA instead of the mock USDB)', async () => {
  // Account 1 (holds 500 PIZZA) puts an ask on the book.
  await go('#/wallet/trade');
  await expect(page.getByLabel('Base asset')).toHaveValue(/^PIZZA:/);
  await expect(page.getByLabel('Counter asset')).toHaveValue('XLM');
  await page.getByRole('radio', { name: 'Sell PIZZA' }).click();
  await page.getByLabel('Amount (PIZZA)').fill('20');
  await page.getByLabel('Price (XLM)').fill('1.5');
  await page.getByRole('button', { name: 'Sell PIZZA' }).click();
  await waitApplied(page);
  await expect(page.getByRole('region', { name: 'My open offers' })).toContainText('PIZZA');

  // Account 2 trusts PIZZA from the trade panel, then buys from the best ask.
  await selectKey(page, 'Account 2');
  const trust = page.getByRole('button', { name: /^Trust / });
  await expect(trust).toHaveText('Trust PIZZA');
  await trust.click();
  await expect(page.getByText('Trustline needed')).toBeHidden({ timeout: 60_000 });
  const ask = page.getByRole('region', { name: 'Order book' }).locator('li button[title="Use price 1.5"]');
  await expect(ask.locator('span.relative')).toHaveText(['1.5', '20', '30']);
  await ask.click();
  await expect(page.getByRole('radio', { name: 'Buy PIZZA' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Price (XLM)')).toHaveValue('1.5');
  await page.getByLabel(/Amount \(/).fill('5');
  await page.getByRole('button', { name: /^Buy / }).last().click();
  await waitApplied(page);
  await expect(page.getByRole('list', { name: 'Balances' })).toContainText('PIZZA');
  // the ask shrank from 20 to 15
  await expect(ask.locator('span.relative')).toHaveText(['1.5', '15', '22.5']);
});

test('6. create a claimable balance and claim it', async () => {
  await selectKey(page, 'Account 1');
  await go('#/wallet/claim');
  await page.getByLabel('Recipient').fill(second);
  await page.getByLabel('Amount').fill('3');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await waitApplied(page);
  await selectKey(page, 'Account 2');
  const claim = page.getByRole('button', { name: 'Claim', exact: true }).first();
  await expect(claim).toBeVisible({ timeout: 15_000 });
  await claim.click();
  await waitApplied(page);
  await expect(page.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0);
});

test('7. activity shows applied transactions', async () => {
  await go('#/wallet/activity');
  await expect(page.getByText('Applied').first()).toBeVisible();
  await expect(page.getByText('Pending')).toHaveCount(0, { timeout: 15_000 });
});

test('7b. after a reload: same validator, and activity keeps its final statuses', async () => {
  const before = nodes[0].info.nodeId;
  await page.reload();
  await page.waitForFunction(() => !!window.__browserchain);
  const info = await page.evaluate(() => window.__browserchain!.ready);
  expect(info.nodeId).toBe(before);
  expect(info.storage).toBe('indexeddb');
  nodes[0] = { ...nodes[0], info };
  const rows = page.getByRole('region', { name: 'Activity' }).locator('li');
  await expect.poll(() => rows.filter({ hasText: 'Applied' }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
  await expect(rows.filter({ hasText: /Pending|Unknown/ })).toHaveCount(0);
});

test('8. decode the latest transaction in the lab', async () => {
  await go('#/lab');
  await page.getByRole('button', { name: 'Latest transaction' }).click();
  await expect(page.getByText('envelopeTypeTx').first()).toBeVisible({ timeout: 10_000 });
});

test('9. build, sign and submit in the lab', async () => {
  await go('#/lab/build');
  await page.getByLabel('Source account').fill(first);
  await expect(page.getByText(/Current sequence \d+/)).toBeVisible();
  await page.getByLabel('Destination').fill(second);
  await page.getByLabel('Amount').fill('1');
  await page.getByRole('button', { name: 'Build transaction' }).click();
  await page.getByRole('button', { name: 'Sign it' }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByText(/^Signed by/)).toBeVisible();
  await page.getByRole('button', { name: 'Submit…' }).click();
  await page.getByRole('button', { name: 'Submit to the network' }).click();
  await waitApplied(page);
});

test('10. explorer shows the account with balances', async () => {
  await go(`#/account/${first}`);
  const balances = page.getByRole('region', { name: 'Balances', exact: true });
  await expect(balances.getByText('PIZZA').first()).toBeVisible({ timeout: 10_000 });
  // 500 minted, 5 sold to Account 2 (15 more still rest on the book)
  await expect(balances.locator('tbody tr').filter({ hasText: 'PIZZA' }).locator('td').nth(1)).toHaveText('495');
});

test('11. apply a manual quorum and return to auto', async () => {
  await go('#/validator');
  await page.getByRole('radio', { name: 'Manual' }).click();
  await page.getByRole('button', { name: 'Apply manual quorum' }).click();
  await expect(page.getByText('Manual quorum set applied')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('radio', { name: 'Manual' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.getByText('Quorum set to auto')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  // consensus still works after the round trip
  const before = await page.evaluate(() => window.__browserchain!.getStatus().then((s) => s.lcl.seq));
  await expect.poll(() => page.evaluate(() => window.__browserchain!.getStatus().then((s) => s.lcl.seq)), { timeout: 30_000 }).toBeGreaterThan(before);
});

test('12. light theme', async () => {
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await go('#/');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
  await go('#/wallet/trade');
  await expect(page.getByRole('region', { name: 'Order book' })).toBeVisible();
  await go(`#/account/${first}`);
  await expect(page.getByRole('region', { name: 'Balances', exact: true })).toBeVisible();
});

test('no console errors during the flows', async () => {
  for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
});
