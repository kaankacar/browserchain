// Friendbot under concurrent use: four tabs (four validators) each get eight
// friendbot calls at the same moment. Every one of the 32 accounts must be
// funded once with exactly 10,000 XLM, on every tab. Each node builds its
// friendbot txs on channels it owns, so no tx loses its sequence number to
// another node's tx.
import { Keypair } from '@stellar/stellar-sdk/base';
import { expect, test } from '@playwright/test';
import type { NodeEvent, SubmitResult } from '../src/node/api';
import { attachDiagnostics, openNode, since, statuses, uniqueNetwork, waitAllSynced, type NodePage } from './helpers';

const TABS = 4;
const CALLS = 8;

declare global {
  interface Window {
    __fbEvents?: Extract<NodeEvent, { type: 'txStatus' }>[];
  }
}

/** Native balances of the accounts on one tab ('' when the account does not exist). */
function balances(n: NodePage, ids: string[]): Promise<string[]> {
  return n.page.evaluate(
    (list) =>
      Promise.all(
        list.map(async (id) => {
          const a = await window.__browserchain!.getAccount(id);
          return a ? (a.balances.find((b) => b.asset.type === 'native')?.balance ?? '?') : '';
        }),
      ),
    ids,
  );
}

test('friendbot: 4 tabs x 8 simultaneous calls fund all 32 accounts', async ({ browser }, testInfo) => {
  const t0 = Date.now();
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    const network = uniqueNetwork('fb');
    for (let i = 0; i < TABS; i++) nodes.push(await openNode(context, `transport=broadcast&network=${network}`, `tab${i}`));
    await waitAllSynced(nodes);
    // every tab sees the same four active validators (the channel owners)
    await expect
      .poll(async () => (await statuses(nodes)).map((s) => s.validatorsActive).join(','), { timeout: 60_000, intervals: [500] })
      .toBe(nodes.map(() => TABS).join(','));
    testInfo.annotations.push({ type: 'timing', description: `synced after ${since(t0)}` });

    for (const n of nodes) {
      await n.page.evaluate(() => {
        window.__fbEvents = [];
        window.__browserchain!.subscribe((ev) => {
          if (ev.type === 'txStatus') window.__fbEvents!.push(ev);
        });
      });
    }
    const accounts = nodes.map(() => Array.from({ length: CALLS }, () => Keypair.random().publicKey()));
    // all calls at once: 8 concurrent calls in each tab, the tabs in parallel
    const results: SubmitResult[][] = await Promise.all(
      nodes.map((n, i) => n.page.evaluate((ids) => Promise.all(ids.map((id) => window.__browserchain!.friendbot(id))), accounts[i])),
    );
    const flat = results.flat();
    expect(flat.map((r) => r.status)).toEqual(flat.map(() => 'PENDING'));
    const hashes = new Set(flat.map((r) => r.hash));
    expect(hashes.size).toBe(TABS * CALLS);

    const all = accounts.flat();
    await expect
      .poll(async () => (await balances(nodes[0], all)).filter((b) => b !== '').length, { timeout: 90_000, intervals: [1000] })
      .toBe(TABS * CALLS);
    testInfo.annotations.push({ type: 'timing', description: `all ${TABS * CALLS} accounts funded after ${since(t0)}` });

    // funded once, with the same balances on every tab
    await expect
      .poll(async () => (await Promise.all(nodes.map((n) => balances(n, all)))).flat().filter((b) => b !== '10000.0000000').length, {
        timeout: 30_000,
        intervals: [1000],
      })
      .toBe(0);

    // no tx lost its sequence number: none of the returned hashes was dropped
    const events = (await Promise.all(nodes.map((n) => n.page.evaluate(() => window.__fbEvents ?? [])))).flat();
    const dropped = events.filter((e) => e.status === 'dropped' && hashes.has(e.hash));
    testInfo.annotations.push({ type: 'friendbot', description: `${dropped.length} of ${hashes.size} txs dropped` });
    expect(dropped.map((e) => `${e.hash.slice(0, 8)} ${e.resultCode}`)).toEqual([]);
    const applied = new Set(events.filter((e) => e.status === 'applied' && hashes.has(e.hash)).map((e) => e.hash));
    expect(applied.size).toBe(TABS * CALLS);

    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
