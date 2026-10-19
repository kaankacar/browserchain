// UI lens spec: in manual quorum mode a node only reports a fork and keeps
// its own chain, so the UI must say so on the Overview and the Validator
// page (the Recent forks card alone is easy to miss), for as long as the
// fork lasts. Setup as in fork.spec.ts: A on BroadcastChannel, B on WebRTC
// with every WebSocket mocked, so each closes its own ledgers; then B, in
// manual mode, reloads onto BroadcastChannel and meets A. A starts first and
// stays ahead. A node checks a fork again only when the peer is not ahead,
// so B reports this fork once: the alert must not depend on new reports.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, forks, goHash, openNode, status, statuses, uniqueNetwork, type NodePage } from './helpers';

test('manual quorum mode: a fork shows an alert on the Overview and the Validator page while it lasts', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  await context.routeWebSocket(/.*/, () => undefined);
  const network = uniqueNetwork('fork-alert');
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, `transport=broadcast&network=${network}`, 'A');
    nodes.push(A);
    await expect.poll(async () => (await status(A.page)).lcl.seq, { timeout: 90_000 }).toBeGreaterThanOrEqual(6);
    const B = await openNode(context, `transport=webrtc&network=${network}`, 'B');
    nodes.push(B);
    await expect
      .poll(async () => (await statuses(nodes)).every((s) => s.state === 'synced' && s.peers === 0 && s.lcl.seq >= 3), { timeout: 60_000 })
      .toBe(true);

    // B trusts only itself, in manual mode: it will keep its chain and report the fork.
    await B.page.evaluate((id) => window.__browserchain!.setQuorumConfig({ mode: 'manual', qset: { threshold: 1, validators: [id], innerSets: [] } }), B.info.nodeId);
    await B.page.goto(`/?transport=broadcast&network=${network}#/`);
    await B.page.waitForFunction(() => !!window.__browserchain);
    await B.page.evaluate(() => window.__browserchain!.ready);

    const title = 'Fork: this node and a peer disagree';
    await expect(B.page.getByText(title)).toBeVisible({ timeout: 45_000 });
    await expect(B.page.getByRole('main')).toContainText('In manual quorum mode the node keeps its own chain');
    await expect(B.page.getByRole('main').getByRole('link', { name: 'Validator', exact: true })).toBeVisible();
    await goHash(B.page, '#/validator');
    await expect(B.page.getByText(title)).toBeVisible();
    await goHash(B.page, '#/validator/peers');
    await expect(B.page.getByRole('region', { name: 'Recent forks' })).toContainText('Alert only');

    // A (auto mode) kept its branch: nothing to act on there.
    expect((await A.page.evaluate(() => window.__browserchain!.getForks())).map((f) => f.resolution)).not.toContain('alert-only');
    await expect(A.page.getByText(title)).toHaveCount(0);

    // The alert stays while the fork lasts, long after the first report.
    const first = (await forks(B.page)).find((f) => f.resolution === 'alert-only')!;
    await goHash(B.page, '#/');
    await B.page.waitForTimeout(Math.max(0, first.ts + 45_000 - Date.now()));
    const [la, lb] = await Promise.all(nodes.map((n) => n.page.evaluate((s) => window.__browserchain!.getLedger(s), first.atSeq)));
    expect(la?.hash, 'the fork still exists').not.toBe(lb?.hash);
    const newest = (await forks(B.page)).at(-1)!;
    testInfo.annotations.push({ type: 'fork reports', description: `newest report ${((Date.now() - newest.ts) / 1000).toFixed(0)} s old` });
    await expect(B.page.getByText(title)).toBeVisible();
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
