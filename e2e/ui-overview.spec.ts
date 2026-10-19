// UI lens spec: the Overview on a real network.
// - A lone tab says it is the only validator, and the average close time
//   shows a dash (not "0 ms") until two ledgers closed.
// - With three tabs, the consensus card never says "Round 0": that is the
//   state before this node nominates, and it reads like a real round.
import { expect, test, type Page } from '@playwright/test';
import { attachDiagnostics, openNode, uniqueNetwork, waitAllSynced, type NodePage } from './helpers';

/** Sample a text every `everyMs` for `forMs`; returns the distinct values seen. */
async function sample(read: () => Promise<string>, forMs: number, everyMs = 100): Promise<string[]> {
  const seen = new Set<string>();
  const end = Date.now() + forMs;
  while (Date.now() < end) {
    seen.add((await read().catch(() => '')).trim());
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return [...seen];
}

function consensusSubtitle(page: Page): Promise<string> {
  return page.getByRole('region', { name: /^Consensus/ }).locator('header p').first().innerText();
}

function avgCloseTime(page: Page): Promise<string> {
  // the tile's big value under the "Avg close time" label
  return page.getByText('Avg close time', { exact: true }).locator('xpath=../..').locator('div.text-2xl').innerText();
}

test('overview: lone-tab hint, no "0 ms" average, never "Round 0"', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const q = `transport=broadcast&network=${uniqueNetwork('overview')}`;
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, q, 'A');
    nodes.push(A);
    await waitAllSynced(nodes);
    const hint = A.page.getByText('This tab is the only validator');
    await expect(hint).toBeVisible({ timeout: 15_000 });
    // the first ledgers of a lone validator: no interval yet, then real ones
    const averages = await sample(() => avgCloseTime(A.page), 12_000, 150);
    testInfo.annotations.push({ type: 'avg close time', description: averages.join(' | ') });
    expect(averages).not.toContain('0 ms');
    expect(averages.some((v) => /\d s$/.test(v))).toBe(true);

    const B = await openNode(context, q, 'B');
    const C = await openNode(context, q, 'C');
    nodes.push(B, C);
    await waitAllSynced(nodes);
    await expect(hint).toBeHidden({ timeout: 15_000 });
    const subtitles = await sample(() => consensusSubtitle(A.page), 25_000);
    testInfo.annotations.push({ type: 'consensus subtitles', description: subtitles.join(' | ') });
    expect(subtitles.filter((s) => /round 0/i.test(s))).toEqual([]);
    expect(subtitles.some((s) => /^Round [1-9]/.test(s))).toBe(true);

    // Phone width: new ledgers must not push the newest card out of the strip
    // (scroll snapping did), and default names ("node-XXXX") are not cut off.
    await A.page.setViewportSize({ width: 375, height: 812 });
    const lcl = () => A.page.evaluate(() => window.__browserchain!.getStatus().then((s) => s.lcl.seq));
    const start = await lcl();
    await expect.poll(lcl, { timeout: 30_000 }).toBeGreaterThanOrEqual(start + 2);
    const strip = await A.page.getByRole('list', { name: 'Most recent ledgers, newest first' }).evaluate((ol) => {
      const first = ol.querySelector('li')!.getBoundingClientRect();
      const box = ol.getBoundingClientRect();
      return { scrollLeft: ol.scrollLeft, firstVisible: first.left >= box.left - 1 && first.right <= box.right + 1 };
    });
    expect(strip).toEqual({ scrollLeft: 0, firstVisible: true });
    const cut = await A.page.getByRole('list', { name: 'Latest statement of each validator' }).evaluate((ul) =>
      [...ul.querySelectorAll('li span.truncate')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent),
    );
    expect(cut, 'names cut off in the consensus card').toEqual([]);
    for (const n of nodes) expect(n.errors, `${n.label} console errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
