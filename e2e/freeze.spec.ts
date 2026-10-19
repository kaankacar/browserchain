// Spec 6: freezing a tab.
//
// a) CDP Page.setWebLifecycleState 'frozen' for 30 s, then 'active'. In the
//    Playwright Chromium builds this freezes nothing (no freeze/resume
//    events, page timers keep running) and the node worker keeps running, so
//    the node stays in consensus. The test checks the network is unharmed and
//    records whether the worker ran.
// b) A real freeze as Chrome does it to a page and its dedicated workers:
//    'freeze' event, the worker's event loop stops for 30 s (no timer, no
//    message runs), then 'resume'. The others drop the frozen node from the
//    auto quorum and keep closing ledgers; on resume the node notices the
//    pause, catches up and rejoins, with no fork and no divergent hash.
import { expect, test, type BrowserContext, type Page, type TestInfo, type Worker } from '@playwright/test';
import { attachDiagnostics, expectSameChain, forks, nodeLog, openNode, since, status, statuses, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

const FREEZE_MS = 30_000;

async function fourNodes(context: BrowserContext): Promise<NodePage[]> {
  const nodes: NodePage[] = [];
  for (const label of ['A', 'B', 'C', 'D']) nodes.push(await openNode(context, 'transport=broadcast', label));
  const synced = await waitAllSynced(nodes);
  await waitMinLcl(nodes, Math.max(...synced.map((s) => s.lcl.seq)) + 3);
  return nodes;
}

function nodeWorker(page: Page): Worker {
  const w = page.workers().find((x) => /\/worker[^/]*\.js/.test(x.url()));
  if (!w) throw new Error('node worker not found');
  return w;
}

/** Whether `id` is in the quorum set of each node, and what each sees of it as a peer. */
async function viewOf(nodes: NodePage[], id: string): Promise<{ inQuorum: boolean[]; peerAgeMs: (number | null)[] }> {
  const st = await statuses(nodes);
  const peers = await Promise.all(
    nodes.map((n) => n.page.evaluate((x) => window.__browserchain!.getPeers().then((ps) => ps.find((p) => p.nodeId === x)?.lastSeen ?? null), id)),
  );
  return { inQuorum: st.map((s) => s.quorum.qset.validators.includes(id)), peerAgeMs: peers.map((t) => (t === null ? null : Date.now() - t)) };
}

/** After the pause: D synced at the network LCL, in every quorum, ledgers close, one chain, no forks. */
async function expectRejoined(nodes: NodePage[], D: NodePage, resumedAt: number, testInfo: TestInfo): Promise<void> {
  const others = nodes.filter((n) => n !== D);
  await expect
    .poll(
      async () => {
        const net = Math.max(...(await statuses(others)).map((s) => s.lcl.seq));
        const d = await status(D.page);
        return d.state === 'synced' && d.lcl.seq >= net - 1;
      },
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .toBe(true);
  testInfo.annotations.push({ type: 'timing', description: `D synced ${since(resumedAt)} after resume` });
  await expect
    .poll(async () => (await statuses(nodes)).every((s) => s.quorum.qset.validators.length === 4), { timeout: 45_000 })
    .toBe(true);
  const st = await statuses(nodes);
  await waitMinLcl(nodes, Math.max(...st.map((s) => s.lcl.seq)) + 2, 30_000);
  testInfo.annotations.push({ type: 'timing', description: `D back in every quorum, ledgers closing, ${since(resumedAt)} after resume` });
  await expectSameChain(nodes);
  for (const n of nodes) expect(await forks(n.page), `${n.label} forks`).toEqual([]);
}

test('CDP freeze for 30 s: the network is unharmed (and does the worker keep running?)', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  let nodes: NodePage[] = [];
  try {
    nodes = await fourNodes(context);
    const D = nodes[3];
    const others = nodes.slice(0, 3);
    const dId = D.info.nodeId;
    await D.page.evaluate(() => {
      const w = window as unknown as { __lifecycle: string[]; __ticks: number };
      w.__lifecycle = [];
      w.__ticks = 0;
      for (const n of ['freeze', 'resume', 'visibilitychange']) document.addEventListener(n, () => w.__lifecycle.push(`${n}:${document.visibilityState}`));
      setInterval(() => w.__ticks++, 1000);
    });
    const cdp = await context.newCDPSession(D.page);
    const start = Math.max(...(await statuses(others)).map((s) => s.lcl.seq));
    const frozenAt = Date.now();
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });

    // Sample what the others see of D while its page is "frozen".
    let droppedFromQuorum = false;
    let maxPeerAge = 0;
    while (Date.now() - frozenAt < FREEZE_MS) {
      const v = await viewOf(others, dId);
      if (v.inQuorum.some((x) => !x)) droppedFromQuorum = true;
      for (const a of v.peerAgeMs) maxPeerAge = Math.max(maxPeerAge, a ?? Infinity);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const othersLcl = (await statuses(others)).map((s) => s.lcl.seq);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    const resumedAt = Date.now();
    const page = await D.page.evaluate(() => {
      const w = window as unknown as { __lifecycle: string[]; __ticks: number };
      return { events: w.__lifecycle, ticks: w.__ticks };
    });
    const workerRan = !droppedFromQuorum && maxPeerAge < 7000;
    testInfo.annotations.push({
      type: 'freeze',
      description:
        `worker kept running while frozen: ${workerRan} (max peer silence ${(maxPeerAge / 1000).toFixed(1)} s, dropped from quorum: ${droppedFromQuorum}); ` +
        `page timer ticks during the 30 s: ${page.ticks}; lifecycle events: ${page.events.join(',') || 'none'}; ` +
        `network went ${start} -> ${Math.max(...othersLcl)}`,
    });

    // Whatever the browser did, the network kept closing ledgers and stays one chain.
    expect(Math.min(...othersLcl)).toBeGreaterThanOrEqual(start + 4);
    await expectRejoined(nodes, D, resumedAt, testInfo);
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});

test('frozen worker for 30 s: dropped from the quorum, then catches up and rejoins', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  let nodes: NodePage[] = [];
  try {
    nodes = await fourNodes(context);
    const D = nodes[3];
    const others = nodes.slice(0, 3);
    const dId = D.info.nodeId;
    const before = await status(D.page);
    const cdp = await context.newCDPSession(D.page);

    // Freeze as Chrome does: 'freeze' event, then the page and its worker stop.
    await D.page.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    const frozenAt = Date.now();
    const worker = nodeWorker(D.page);
    // the worker's event loop is blocked: no timer, message or RPC call runs
    const stall = worker.evaluate((ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // frozen
      }
    }, FREEZE_MS);

    // The others drop D from the auto quorum (3 of 4 -> 2 of 3) and keep closing ledgers.
    // inactive after VALIDATOR_ACTIVE_MS (9 s), removed at the next slot boundary (up to 5 s later)
    await expect.poll(async () => (await viewOf(others, dId)).inQuorum.every((x) => !x), { timeout: 30_000 }).toBe(true);
    testInfo.annotations.push({ type: 'freeze', description: `D dropped from every quorum ${since(frozenAt)} after freezing` });
    const during = await waitMinLcl(others, before.lcl.seq + 4, FREEZE_MS);
    for (const s of during) expect(s.quorum.qset).toMatchObject({ threshold: 2 });
    await stall;
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await D.page.evaluate(() => document.dispatchEvent(new Event('resume')));
    const resumedAt = Date.now();
    const net = Math.max(...(await statuses(others)).map((s) => s.lcl.seq));
    testInfo.annotations.push({ type: 'freeze', description: `D frozen at LCL ${before.lcl.seq}; network at ${net} on resume (${since(frozenAt)} later)` });

    await expectRejoined(nodes, D, resumedAt, testInfo);
    const log = await nodeLog(D.page, 400);
    const resumed = log.split('\n').filter((l) => /resumed \(|caught up to/.test(l));
    testInfo.annotations.push({ type: 'resume', description: resumed.map((l) => l.slice(13)).join(' | ') || 'no resume line' });
    expect(resumed.some((l) => /resumed \(/.test(l)), 'D noticed the pause').toBe(true);
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
