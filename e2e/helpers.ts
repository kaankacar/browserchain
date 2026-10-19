// Shared e2e helpers: open validator tabs, read node state through
// window.__browserchain (the NodeApi client boot.ts exposes), and check that
// tabs agree on the chain. Real ledgers close about every 5 s: wait on state.
import { expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { ForkInfo, LedgerSummary, NodeApi, NodeStatus } from '../src/node/api';
import type { ReadyInfo } from '../src/node/rpc';

/** What boot.ts puts on window (WorkerNodeClient). */
type Client = NodeApi & { ready: Promise<ReadyInfo>; info: ReadyInfo | null };

declare global {
  interface Window {
    __browserchain?: Client;
  }
}

export interface NodePage {
  page: Page;
  label: string;
  /** Page errors and console errors seen so far. */
  errors: string[];
  info: ReadyInfo;
}

/** Console noise that is not a product error. */
const IGNORED = [/Failed to load resource.*favicon/i];

export function watchErrors(page: Page, errors: string[]): void {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (!IGNORED.some((re) => re.test(text))) errors.push(`console.error: ${text}`);
  });
}

/** Open one validator tab and wait until its node runs (state 'booting' or later). */
export async function openNode(context: BrowserContext, query: string, label: string, hash = '#/'): Promise<NodePage> {
  const page = await context.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);
  await page.goto(`/?${query}${hash}`);
  await page.waitForFunction(() => !!window.__browserchain, null, { timeout: 30_000 });
  const info = await page.evaluate(() => window.__browserchain!.ready);
  return { page, label, errors, info };
}

export function status(page: Page): Promise<NodeStatus> {
  return page.evaluate(() => window.__browserchain!.getStatus());
}

export function statuses(nodes: NodePage[]): Promise<NodeStatus[]> {
  return Promise.all(nodes.map((n) => status(n.page)));
}

export function forks(page: Page): Promise<ForkInfo[]> {
  return page.evaluate(() => window.__browserchain!.getForks());
}

/** Newest first, up to `limit` (the API caps a page at 200). */
export function ledgers(page: Page, limit = 200): Promise<LedgerSummary[]> {
  return page.evaluate((n) => window.__browserchain!.getLedgers({ limit: n }), limit);
}

/** Wait until every node is synced. Returns the statuses. */
export async function waitAllSynced(nodes: NodePage[], timeout = 90_000): Promise<NodeStatus[]> {
  let last: NodeStatus[] = [];
  await expect
    .poll(
      async () => {
        last = await statuses(nodes);
        return last.map((s) => s.state).join(',');
      },
      { timeout, intervals: [500, 1000] },
    )
    .toBe(nodes.map(() => 'synced').join(','));
  return last;
}

/** Wait until the lowest LCL of the nodes reaches `seq`. */
export async function waitMinLcl(nodes: NodePage[], seq: number, timeout = 120_000): Promise<NodeStatus[]> {
  let last: NodeStatus[] = [];
  await expect
    .poll(
      async () => {
        last = await statuses(nodes);
        return Math.min(...last.map((s) => s.lcl.seq));
      },
      { timeout, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(seq);
  return last;
}

/**
 * Every seq known to two or more nodes has one hash, and each node's chain
 * links (prevHash of seq n+1 = hash of seq n). Returns the number of seqs
 * compared across nodes.
 */
export async function expectSameChain(nodes: NodePage[]): Promise<number> {
  const chains = await Promise.all(nodes.map((n) => ledgers(n.page)));
  const bySeq = new Map<number, { label: string; hash: string }[]>();
  chains.forEach((chain, i) => {
    const sorted = [...chain].sort((a, b) => a.seq - b.seq);
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].seq === sorted[k - 1].seq + 1) {
        expect(sorted[k].prevHash, `${nodes[i].label}: ledger ${sorted[k].seq} links to ${sorted[k - 1].seq}`).toBe(sorted[k - 1].hash);
      }
    }
    for (const l of chain) {
      const list = bySeq.get(l.seq) ?? [];
      list.push({ label: nodes[i].label, hash: l.hash });
      bySeq.set(l.seq, list);
    }
  });
  let shared = 0;
  const mismatches: string[] = [];
  for (const [seq, list] of [...bySeq].sort((a, b) => a[0] - b[0])) {
    if (list.length < 2) continue;
    shared++;
    if (new Set(list.map((x) => x.hash)).size > 1) mismatches.push(`ledger ${seq}: ${list.map((x) => `${x.label}=${x.hash.slice(0, 8)}`).join(' ')}`);
  }
  expect(mismatches, 'hash mismatches').toEqual([]);
  return shared;
}

/** Recent node log lines (oldest first) for failure reports. */
export async function nodeLog(page: Page, limit = 150): Promise<string> {
  try {
    const logs = await page.evaluate((n) => window.__browserchain!.getLogs(n), limit);
    return logs
      .reverse()
      .map((l) => `${new Date(l.ts).toISOString().slice(11, 23)} ${l.level.padEnd(5)} ${l.scope}: ${l.msg}`)
      .join('\n');
  } catch (err) {
    return `(no log: ${(err as Error).message})`;
  }
}

/** Attach node logs and page errors to the test report. */
export async function attachDiagnostics(testInfo: TestInfo, nodes: NodePage[]): Promise<void> {
  for (const n of nodes) {
    if (n.page.isClosed()) continue;
    await testInfo.attach(`${n.label}-log.txt`, { body: await nodeLog(n.page), contentType: 'text/plain' });
    if (n.errors.length) await testInfo.attach(`${n.label}-errors.txt`, { body: n.errors.join('\n'), contentType: 'text/plain' });
  }
}

/** Go to a hash route like a link click (no reload: the node keeps running). */
export async function goHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

/** A network name nobody else uses, so runs and specs never share a chain. */
export function uniqueNetwork(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Elapsed seconds since t0, for timing notes in the report. */
export function since(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
}
