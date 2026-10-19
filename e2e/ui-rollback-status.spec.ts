// UI lens spec: after an auto-mode rollback, the wallet must not keep showing
// a payment as "Applied" when it is no longer on the chain.
// The worker script is served with a small prefix that can block its
// BroadcastChannel (self.__bcBlocked), so a tab can leave and rejoin the
// network without a reload (the UI keeps its state). A, B and C share a chain
// and a wallet key K. B is cut off and closes ledgers alone; meanwhile B pays
// from K with the wallet, and A pays from K with the same sequence number.
// After the heal B (the lighter branch) rolls back, and its payment cannot
// apply again (bad sequence), so the node never reports it again.
import { Account, Asset, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { expect, test, type Page } from '@playwright/test';
import { attachDiagnostics, forks, goHash, openNode, status, uniqueNetwork, waitAllSynced, type NodePage } from './helpers';

const PATCH = `(() => {
  const Real = self.BroadcastChannel;
  self.__bcBlocked = false;
  self.BroadcastChannel = class extends Real {
    postMessage(m) { if (!self.__bcBlocked) super.postMessage(m); }
    set onmessage(h) { super.onmessage = h ? (e) => { if (!self.__bcBlocked) h(e); } : null; }
    get onmessage() { return super.onmessage; }
  };
})();
`;

async function setBlocked(page: Page, blocked: boolean): Promise<void> {
  const worker = page.workers().find((w) => /\/worker[^/]*\.js/.test(w.url()));
  if (!worker) throw new Error('node worker not found');
  await worker.evaluate((b) => {
    (self as unknown as { __bcBlocked: boolean }).__bcBlocked = b;
  }, blocked);
}

function getAccount(page: Page, id: string) {
  return page.evaluate((pk) => window.__browserchain!.getAccount(pk), id);
}

test('wallet: a payment dropped by a rollback no longer shows as applied', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  await context.route(/\/assets\/worker-[^/]*\.js$/, async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, body: PATCH + (await resp.text()) });
  });
  const network = uniqueNetwork('rollback-status');
  const q = `transport=broadcast&network=${network}`;
  const K = Keypair.random();
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, q, 'A');
    nodes.push(A);
    await A.page.evaluate(
      ([n, k]) => localStorage.setItem(`browserchain:wallet:${n}`, JSON.stringify([k])),
      [network, { name: 'Shared key', publicKey: K.publicKey(), secret: K.secret(), createdAt: Date.now() }] as const,
    );
    const B = await openNode(context, q, 'B', '#/wallet/send');
    const C = await openNode(context, q, 'C');
    nodes.push(B, C);
    await waitAllSynced(nodes);
    await A.page.evaluate((pk) => window.__browserchain!.friendbot(pk), K.publicKey());
    await expect.poll(async () => (await Promise.all(nodes.map((n) => getAccount(n.page, K.publicKey())))).every(Boolean), { timeout: 60_000 }).toBe(true);
    const seq0 = (await getAccount(A.page, K.publicKey()))!.sequence;

    // B alone closes its own ledgers
    await setBlocked(B.page, true);
    const bStart = (await status(B.page)).lcl.seq;
    await expect.poll(async () => (await status(B.page)).lcl.seq, { timeout: 90_000 }).toBeGreaterThanOrEqual(bStart + 2);

    // B pays from K with the wallet
    const passphrase = (await status(B.page)).networkPassphrase;
    const root = Keypair.master(passphrase).publicKey();
    await B.page.getByLabel('Destination').fill(root);
    await B.page.getByLabel('Amount', { exact: true }).fill('12');
    await B.page.getByRole('button', { name: 'Send', exact: true }).click();
    await goHash(B.page, '#/wallet/activity');
    const row = B.page.getByRole('region', { name: 'Activity' }).locator('li').first();
    await expect(row).toContainText('Applied', { timeout: 60_000 });
    const payHash = await B.page.evaluate((n) => JSON.parse(localStorage.getItem(`browserchain:wallet:activity:${n}`)!).items[0].hash as string, network);

    // A pays from K with the same sequence number on its branch
    const tx = new TransactionBuilder(new Account(K.publicKey(), seq0), { fee: '100', networkPassphrase: passphrase })
      .addOperation(Operation.payment({ destination: root, asset: Asset.native(), amount: '7' }))
      .setTimeout(0)
      .build();
    tx.sign(K);
    const res = await A.page.evaluate((x) => window.__browserchain!.submitTransaction(x), tx.toXDR());
    expect(res.status).toBe('PENDING');
    await expect.poll(() => A.page.evaluate((h) => window.__browserchain!.getTransaction(h), res.hash), { timeout: 60_000 }).not.toBeNull();

    // heal: B rolls back to A's branch, where its payment does not exist
    await setBlocked(B.page, false);
    await expect.poll(async () => (await forks(B.page)).map((f) => f.resolution), { timeout: 60_000 }).toContain('rolled-back');
    await expect.poll(() => B.page.evaluate((h) => window.__browserchain!.getTransaction(h), payHash), { timeout: 60_000 }).toBeNull();
    await expect(row).not.toContainText('Applied', { timeout: 15_000 });
    testInfo.annotations.push({ type: 'activity row', description: (await row.innerText()).replace(/\s+/g, ' ') });
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
