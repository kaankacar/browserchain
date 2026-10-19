// Manual-mode fork, then auto mode. A node in manual quorum mode only reports
// a fork and keeps its own chain. When the user switches it to auto mode, it
// checks the fork again at once, although the peer stays ahead (a peer's LCL
// above ours cannot be compared with our chain), and the two tabs end on one
// chain. Setup as in ui-fork-alert.spec.ts: A on BroadcastChannel, B on
// WebRTC with every WebSocket mocked, so each closes its own ledgers; then B,
// in manual mode, reloads onto BroadcastChannel and meets A.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, openNode, since, status, statuses, uniqueNetwork, waitMinLcl, type NodePage } from './helpers';

test('manual-mode fork, then auto mode: the two tabs end on one chain', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  await context.routeWebSocket(/.*/, () => undefined);
  const network = uniqueNetwork('fork-mode');
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, `transport=broadcast&network=${network}`, 'A');
    nodes.push(A);
    // A gets well ahead: its branch is the heavier one (one validator each)
    await expect.poll(async () => (await status(A.page)).lcl.seq, { timeout: 120_000 }).toBeGreaterThanOrEqual(12);
    const B = await openNode(context, `transport=webrtc&network=${network}`, 'B');
    nodes.push(B);
    await expect
      .poll(
        async () => {
          const [a, b] = await statuses(nodes);
          return a.state === 'synced' && b.state === 'synced' && a.peers === 0 && b.peers === 0 && b.lcl.seq >= 3;
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    // B trusts only itself, in manual mode: it keeps its chain and reports the fork.
    await B.page.evaluate((id) => window.__browserchain!.setQuorumConfig({ mode: 'manual', qset: { threshold: 1, validators: [id], innerSets: [] } }), B.info.nodeId);
    await B.page.goto(`/?transport=broadcast&network=${network}#/`);
    await B.page.waitForFunction(() => !!window.__browserchain);
    await B.page.evaluate(() => window.__browserchain!.ready);
    await expect.poll(async () => (await forks(B.page)).map((f) => f.resolution), { timeout: 45_000 }).toContain('alert-only');
    // B reports the fork while it boots, then validates on its own chain
    await expect.poll(async () => (await status(B.page)).state, { timeout: 30_000 }).toBe('synced');
    const [a1, b1] = await statuses(nodes);
    expect(b1.quorum.mode).toBe('manual');
    expect(a1.lcl.seq, 'A stays ahead of B').toBeGreaterThan(b1.lcl.seq);
    const [la, lb] = await Promise.all(nodes.map((n) => n.page.evaluate(() => window.__browserchain!.getLedger(2))));
    expect(la?.hash, 'the two chains differ').not.toBe(lb?.hash);

    // Auto mode: B checks the fork again right away, rolls back and follows A.
    const t0 = Date.now();
    await B.page.evaluate(() => window.__browserchain!.setQuorumConfig({ mode: 'auto' }));
    await expect
      .poll(
        async () => {
          const [a, b] = await statuses(nodes);
          return a.state === 'synced' && b.state === 'synced' && a.lcl.hash === b.lcl.hash && b.quorum.qset.validators.length === 2;
        },
        { timeout: 60_000, intervals: [500, 1000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `one chain ${since(t0)} after switching B to auto mode` });
    expect((await forks(B.page)).map((f) => f.resolution)).toContain('rolled-back');
    expect((await forks(A.page)).map((f) => f.resolution)).not.toContain('rolled-back');

    // and they close ledgers together
    const start = Math.max(...(await statuses(nodes)).map((s) => s.lcl.seq));
    await waitMinLcl(nodes, start + 2, 30_000);
    await expectSameChain(nodes);
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
