// Extra spec: a real fork in the browser. Tab A uses BroadcastChannel, tab B
// only WebRTC (with every WebSocket mocked, so it reaches no relay): they
// cannot see each other and each closes its own ledgers on one network.
// Then B reloads onto BroadcastChannel with its stored chain. The two must
// detect the fork, agree on one branch (one keeps, one rolls back), end up on
// one chain and close ledgers together. Both UIs list the fork.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, goHash, openNode, statuses, uniqueNetwork, waitMinLcl, type NodePage } from './helpers';

test('two tabs that built separate chains meet: the fork is resolved to one chain', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  // keep it offline: B's Trystero relays are mocked sockets that never answer
  await context.routeWebSocket(/.*/, () => undefined);
  const network = uniqueNetwork('fork');
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, `transport=broadcast&network=${network}`, 'A');
    const B = await openNode(context, `transport=webrtc&network=${network}`, 'B');
    nodes.push(A, B);
    await expect
      .poll(async () => (await statuses(nodes)).every((s) => s.state === 'synced' && s.peers === 0 && s.lcl.seq >= 4), { timeout: 60_000 })
      .toBe(true);
    const [a0, b0] = await statuses(nodes);
    expect(a0.lcl.hash).not.toBe(b0.lcl.hash);

    // B comes back on BroadcastChannel with its own chain: same slot, same identity.
    await B.page.goto(`/?transport=broadcast&network=${network}#/validator/peers`);
    await B.page.waitForFunction(() => !!window.__browserchain);
    const info = await B.page.evaluate(() => window.__browserchain!.ready);
    expect(info.nodeId).toBe(B.info.nodeId);

    await expect
      .poll(
        async () => {
          const [a, b] = await statuses(nodes);
          return a.state === 'synced' && b.state === 'synced' && a.lcl.hash === b.lcl.hash && b.quorum.qset.validators.length === 2;
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    const [fa, fb] = [await forks(A.page), await forks(B.page)];
    const resolutions = [...fa, ...fb].map((f) => f.resolution).sort();
    testInfo.annotations.push({ type: 'fork', description: `A: ${JSON.stringify(fa.map((f) => [f.resolution, f.atSeq, f.rolledBackLedgers]))}; B: ${JSON.stringify(fb.map((f) => [f.resolution, f.atSeq, f.rolledBackLedgers]))}` });
    expect(resolutions).toEqual(['kept-ours', 'rolled-back']);
    for (const f of [...fa, ...fb]) expect(f.atSeq).toBe(2);

    const start = Math.max(...(await statuses(nodes)).map((s) => s.lcl.seq));
    await waitMinLcl(nodes, start + 2, 30_000);
    await expectSameChain(nodes);

    // Each UI shows the fork with its own outcome.
    const loser = fa.some((f) => f.resolution === 'rolled-back') ? A : B;
    await goHash(loser.page, '#/validator/peers');
    await expect(loser.page.getByRole('region', { name: 'Recent forks' })).toContainText(/Rolled back \d+ ledgers?/);
    const winner = loser === A ? B : A;
    await goHash(winner.page, '#/validator/peers');
    await expect(winner.page.getByRole('region', { name: 'Recent forks' })).toContainText('Kept our branch');
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
