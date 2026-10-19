// Spec 3: the DEX through the UI on the real node. Page A issues an asset,
// page B trusts it and places a buy offer, page C (watching the Trade tab
// from the start, before the asset exists) sees the bid in the order book.
// Then A sells into the bid and everyone sees the trade.
import { Keypair } from '@stellar/stellar-sdk/base';
import { expect, test, type Page } from '@playwright/test';
import { attachDiagnostics, goHash, openNode, since, waitAllSynced, type NodePage } from './helpers';
import { selectedAccountId, waitApplied, walletKeys } from './ui';

const CODE = 'E2EX';

/** One side of the order book card ("Bids" or "Asks"). */
function bookSide(page: Page, title: 'Bids' | 'Asks') {
  return page
    .getByRole('region', { name: 'Order book' })
    .locator('div.min-w-0')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${title}$`) }) });
}

/** Rows of a book side as [price, base amount, counter amount] texts. */
async function bookRows(page: Page, title: 'Bids' | 'Asks'): Promise<string[][]> {
  const rows = bookSide(page, title).locator('li button');
  const out: string[][] = [];
  for (let i = 0; i < (await rows.count()); i++) out.push(await rows.nth(i).locator('span.relative').allTextContents());
  return out;
}

test('DEX: issue on A, trust and bid on B, order book on C, then a trade', async ({ browser }, testInfo) => {
  const t0 = Date.now();
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, 'transport=broadcast', 'A', '#/wallet');
    const B = await openNode(context, 'transport=broadcast', 'B', '#/wallet');
    const C = await openNode(context, 'transport=broadcast', 'C', '#/wallet/trade');
    nodes.push(A, B, C);
    // C remembers a trade pair from another network (the pair is kept in localStorage)
    await C.page.evaluate((issuer) => localStorage.setItem('browserchain:trade:pair', JSON.stringify({ base: `GHOST:${issuer}`, counter: 'XLM' })), Keypair.random().publicKey());
    await waitAllSynced(nodes);

    // A: a funded account, then a new asset minted to it.
    await A.page.getByRole('button', { name: 'Create a test account' }).click();
    await expect(A.page.getByRole('list', { name: 'Balances' })).toContainText('10,000', { timeout: 60_000 });
    const holder = await selectedAccountId(A.page);
    // C sees the shared key now; its Trade tab says there is nothing to trade yet.
    await expect(C.page.getByText('No assets to trade yet')).toBeVisible({ timeout: 15_000 });
    await goHash(A.page, '#/wallet/issue');
    await A.page.getByLabel('Asset code').fill(CODE);
    await A.page.getByLabel('Amount to mint').fill('500');
    await A.page.getByRole('button', { name: 'Issue asset' }).click();
    await expect(A.page.getByText(`${CODE} is live`)).toBeVisible({ timeout: 90_000 });
    const issuer = (await walletKeys(A.page)).find((k) => k.name === `${CODE} issuer`)!.publicKey;
    const assetKey = `${CODE}:${issuer}`;
    testInfo.annotations.push({ type: 'timing', description: `asset issued after ${since(t0)}` });

    // B: its own funded account, a trustline, then a buy offer (10 E2EX at 2 XLM).
    await B.page.getByRole('button', { name: 'New', exact: true }).click();
    await B.page.getByRole('button', { name: 'Fund with friendbot' }).click();
    await expect(B.page.getByRole('list', { name: 'Balances' })).toContainText('10,000', { timeout: 60_000 });
    const buyer = await selectedAccountId(B.page);
    await goHash(B.page, '#/wallet/trust');
    await B.page.getByLabel('Asset', { exact: true }).selectOption(assetKey);
    await B.page.getByRole('button', { name: 'Add trustline' }).click();
    await waitApplied(B.page);
    await expect(B.page.getByRole('list', { name: 'Balances' })).toContainText(CODE);
    await goHash(B.page, '#/wallet/trade');
    await B.page.getByLabel('Base asset').selectOption(assetKey);
    await B.page.getByLabel('Counter asset').selectOption('XLM');
    await B.page.getByRole('radio', { name: `Buy ${CODE}` }).click();
    await B.page.getByLabel(`Amount (${CODE})`).fill('10');
    await B.page.getByLabel('Price (XLM)').fill('2');
    await B.page.getByRole('button', { name: `Buy ${CODE}` }).click();
    await waitApplied(B.page);
    await expect(B.page.getByRole('region', { name: 'My open offers' })).toContainText('20');
    testInfo.annotations.push({ type: 'timing', description: `bid placed after ${since(t0)}` });

    // C: the Trade tab it has shown all along switched to the new asset by itself and lists the bid.
    await expect(C.page.getByLabel('Base asset')).toHaveValue(assetKey);
    await C.page.getByLabel('Base asset').selectOption(assetKey);
    await C.page.getByLabel('Counter asset').selectOption('XLM');
    await expect.poll(() => bookRows(C.page, 'Bids'), { timeout: 15_000 }).toEqual([['2', '10', '20']]);
    expect(await bookRows(C.page, 'Asks')).toEqual([]);
    const book = await C.page.evaluate(
      ([code, iss]) => window.__browserchain!.getOrderBook({ type: 'credit_alphanum4', code, issuer: iss }, { type: 'native', code: 'XLM' }),
      [CODE, issuer],
    );
    expect(book.bids).toEqual([{ price: '2', amount: '20.0000000', priceR: { n: 2, d: 1 } }]);

    // A sells 4 E2EX into the bid (clicking the bid sets the price and the side).
    await goHash(A.page, '#/wallet/trade');
    await A.page.getByLabel('Base asset').selectOption(assetKey);
    await A.page.getByLabel('Counter asset').selectOption('XLM');
    await bookSide(A.page, 'Bids').locator('li button').first().click();
    await expect(A.page.getByRole('radio', { name: `Sell ${CODE}` })).toHaveAttribute('aria-checked', 'true');
    await A.page.getByLabel(`Amount (${CODE})`).fill('4');
    await A.page.getByRole('button', { name: `Sell ${CODE}` }).click();
    await waitApplied(A.page);

    // Everyone sees the trade: the bid shrinks to 6, B holds 4 E2EX, A has 496 left.
    await expect.poll(() => bookRows(C.page, 'Bids'), { timeout: 15_000 }).toEqual([['2', '6', '12']]);
    const bal = (page: Page, id: string) =>
      page.evaluate(
        ([acc, code]) => window.__browserchain!.getAccount(acc).then((a) => a?.balances.find((b) => b.asset.code === code)?.balance ?? null),
        [id, CODE],
      );
    await expect.poll(() => bal(C.page, buyer)).toBe('4.0000000');
    await expect.poll(() => bal(C.page, holder)).toBe('496.0000000');
    await expect(B.page.getByRole('list', { name: 'Balances' }).locator('li').filter({ hasText: CODE }).locator('p').first()).toHaveText('4');

    // The explorer's asset list on C: two holders, 500 minted.
    await goHash(C.page, '#/assets');
    const row = C.page.getByRole('region', { name: 'Assets' }).locator('tbody tr').filter({ hasText: CODE });
    await expect(row.locator('td').nth(2)).toHaveText('2');
    await expect(row.locator('td').nth(3)).toHaveText('500');

    // Phone width: the wide table says that it scrolls and fades the side that hides columns.
    const assets = C.page.getByRole('region', { name: 'Assets' });
    const cue = assets.getByText('Scroll sideways to see all columns');
    const scroller = assets.locator('[data-scroll-fade]');
    await expect(cue).toBeHidden();
    await C.page.setViewportSize({ width: 375, height: 812 });
    await expect(cue).toBeVisible();
    await expect(scroller).toHaveAttribute('data-scroll-fade', 'right');
    await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(scroller).toHaveAttribute('data-scroll-fade', 'left');
    await C.page.setViewportSize({ width: 1440, height: 900 });
    await expect(cue).toBeHidden();

    // The transaction page shows the id of the offer B's bid left in the book.
    const bTxs = await C.page.evaluate((acc) => window.__browserchain!.getTransactions({ limit: 20, account: acc }), buyer);
    const bid = bTxs.find((t) => t.operations.some((o) => o.type === 'manageBuyOffer'));
    const offerId = String(bid?.operations[0].details.createdOfferId ?? '');
    expect(offerId).toMatch(/^[1-9]\d*$/);
    await goHash(C.page, `#/tx/${bid!.hash}`);
    const opCard = C.page.getByRole('main').locator('li').filter({ hasText: 'New offer ID' });
    await expect(opCard.locator('dd').last()).toHaveText(offerId);

    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
