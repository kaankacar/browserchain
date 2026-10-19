// Spec 8 (opt-in: E2E_WEBRTC=1): two separate browser contexts (separate
// BroadcastChannel scopes, so WebRTC is the only path between them) on a
// network nobody else uses. They find each other through Trystero over the
// public Nostr relays, then close the same ledgers. Depends on the internet
// and on public relays, so it is opt-in and may be flaky.
//
// Signalling can take longer than the 4 s boot wait, so each node may start
// alone and the two may fork at first; auto mode resolves that. The test
// records any fork and asserts that they end up on one chain.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, openNode, since, statuses, uniqueNetwork, type NodePage } from './helpers';

test.skip(!process.env.E2E_WEBRTC, 'set E2E_WEBRTC=1 to run (needs the internet and public Nostr relays)');

test('two browsers on WebRTC find each other and close the same ledgers', async ({ browser }, testInfo) => {
  test.setTimeout(420_000);
  const t0 = Date.now();
  const network = uniqueNetwork('e2e');
  const query = `transport=webrtc&network=${network}&fresh=1`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    nodes.push(await openNode(ctxA, query, 'A'));
    nodes.push(await openNode(ctxB, query, 'B'));
    const [A, B] = nodes;
    testInfo.annotations.push({ type: 'network', description: network });

    // They connect over WebRTC (the only transport between two contexts).
    await expect
      .poll(
        async () => {
          const peers = await A.page.evaluate(() => window.__browserchain!.getPeers());
          return peers.some((p) => p.nodeId === B.info.nodeId && p.transports.includes('webrtc'));
        },
        { timeout: 180_000, intervals: [1000, 2000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `WebRTC peers after ${since(t0)}` });

    // Same chain, both in each other's quorum, and they keep closing ledgers together.
    let start = 0;
    await expect
      .poll(
        async () => {
          const st = await statuses(nodes);
          start = Math.max(...st.map((s) => s.lcl.seq));
          return st.every((s) => s.state === 'synced' && s.quorum.qset.validators.length === 2) && st[0].lcl.seq === st[1].lcl.seq && st[0].lcl.hash === st[1].lcl.hash;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `one chain at ledger ${start} after ${since(t0)}` });
    await expect
      .poll(async () => Math.min(...(await statuses(nodes)).map((s) => s.lcl.seq)), { timeout: 120_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(start + 6);
    const shared = await expectSameChain(nodes);
    const f = [...(await forks(A.page)), ...(await forks(B.page))];
    testInfo.annotations.push({
      type: 'result',
      description: `closed ledgers together up to ${Math.min(...(await statuses(nodes)).map((s) => s.lcl.seq))}; ${shared} shared seqs, 0 mismatches; forks resolved on the way: ${f.length ? f.map((x) => `${x.resolution} at ${x.atSeq}`).join(', ') : 'none'}; total ${since(t0)}`,
    });
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
