// Runtime lens (opt-in: E2E_SLOW=1, about 7 minutes): a new tab catches up
// from a peer whose checkpoint snapshot is larger than one overlay message
// (4 MB, about 10k ledger entries). The snapshot travels as parts and is
// reassembled; before parts existed the catch-up failed with "response too
// large" and the new tab never synced.
//
// Tab A builds a state of 11,000 accounts and runs past checkpoint 64. Tab B
// then opens in fresh mode and must load snapshot 64. The public friendbot
// channel keys may only sign one CreateAccount or native Payment of
// FRIENDBOT_AMOUNT per transaction (channel policy), so each channel funds
// one funder account, and the 16 funders send 110 transactions of 100
// CreateAccount operations.
import { createHash } from 'node:crypto';
import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { expect, test, type Page } from '@playwright/test';
import { formatAmount } from '../src/lib/amount';
import { FRIENDBOT_AMOUNT, networkPassphrase } from '../src/lib/constants';
import { attachDiagnostics, nodeLog, openNode, since, status, uniqueNetwork, waitAllSynced, waitMinLcl, type NodePage } from './helpers';

test.skip(!process.env.E2E_SLOW, 'set E2E_SLOW=1 to run (about 7 minutes: the state must pass checkpoint 64)');

const ACCOUNTS = 11_000;
const OPS_PER_TX = 100;

function seededKey(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(createHash('sha256').update(label).digest());
}

/** Sequence number of an account in tab `page`, or null if it does not exist. */
async function sequenceOf(page: Page, id: string): Promise<bigint | null> {
  const acc = await page.evaluate((x) => window.__browserchain!.getAccount(x), id);
  return acc ? BigInt(acc.sequence) : null;
}

/** Submit envelopes in tab `page`; returns the statuses other than PENDING and DUPLICATE. */
async function submitAll(page: Page, envelopes: string[]): Promise<string[]> {
  const results = await page.evaluate(async (list) => {
    const out: string[] = [];
    for (const xdr of list) out.push((await window.__browserchain!.submitTransaction(xdr)).status);
    return out;
  }, envelopes);
  return results.filter((s) => s !== 'PENDING' && s !== 'DUPLICATE');
}

test('a new tab catches up from a peer whose snapshot is larger than one message', async ({ browser }, testInfo) => {
  test.setTimeout(900_000);
  const t0 = Date.now();
  const network = uniqueNetwork('big');
  const passphrase = networkPassphrase(network);
  const context = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    const A = await openNode(context, `transport=broadcast&network=${network}`, 'A');
    nodes.push(A);
    await waitAllSynced([A]);

    // Each friendbot channel funds one funder with FRIENDBOT_AMOUNT (one operation per transaction).
    const channels = Array.from({ length: 16 }, (_, i) => seededKey(`${passphrase}|friendbot|${i}`));
    const funders = channels.map((_, i) => seededKey(`${network}|big-funder|${i}`));
    const funding: string[] = [];
    for (let i = 0; i < channels.length; i++) {
      const seq = await sequenceOf(A.page, channels[i].publicKey());
      expect(seq, `channel ${channels[i].publicKey()}`).not.toBeNull();
      const tx = new TransactionBuilder(new Account(channels[i].publicKey(), seq!.toString()), { fee: '100', networkPassphrase: passphrase })
        .addOperation(Operation.createAccount({ destination: funders[i].publicKey(), startingBalance: formatAmount(FRIENDBOT_AMOUNT) }))
        .setTimeout(0)
        .build();
      tx.sign(channels[i]);
      funding.push(tx.toEnvelope().toXDR('base64'));
    }
    expect(await submitAll(A.page, funding)).toEqual([]);
    const seqs: bigint[] = [];
    for (const f of funders) {
      await expect.poll(() => sequenceOf(A.page, f.publicKey()), { timeout: 60_000, intervals: [1000] }).not.toBeNull();
      seqs.push((await sequenceOf(A.page, f.publicKey()))!);
    }

    // 110 transactions of 100 CreateAccount operations, at most 7 per funder.
    const envelopes: string[] = [];
    for (let made = 0, n = 0; made < ACCOUNTS; n++) {
      const fi = n % funders.length;
      const account = new Account(funders[fi].publicKey(), seqs[fi].toString());
      seqs[fi] += 1n;
      const builder = new TransactionBuilder(account, { fee: '100', networkPassphrase: passphrase }).setTimeout(0);
      for (let k = 0; k < OPS_PER_TX && made < ACCOUNTS; k++, made++) {
        const dest = seededKey(`${network}|big-account|${made}`);
        builder.addOperation(Operation.createAccount({ destination: dest.publicKey(), startingBalance: '2' }));
      }
      const tx = builder.build();
      tx.sign(funders[fi]);
      envelopes.push(tx.toEnvelope().toXDR('base64'));
    }
    expect(await submitAll(A.page, envelopes)).toEqual([]);
    await expect
      .poll(async () => (await A.page.evaluate(() => window.__browserchain!.getStats())).totalAccounts, { timeout: 180_000, intervals: [2000] })
      .toBeGreaterThanOrEqual(ACCOUNTS);
    testInfo.annotations.push({ type: 'timing', description: `${ACCOUNTS} accounts at ledger ${(await status(A.page)).lcl.seq} after ${since(t0)}` });

    // Past checkpoint 64, so a catching-up node starts from snapshot 64.
    await waitMinLcl([A], 66, 420_000);
    testInfo.annotations.push({ type: 'timing', description: `A passed checkpoint 64 after ${since(t0)}` });

    const t1 = Date.now();
    const B = await openNode(context, `transport=broadcast&network=${network}&fresh=1`, 'B');
    nodes.push(B);
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([status(A.page), status(B.page)]);
          return b.state === 'synced' && b.lcl.seq >= a.lcl.seq - 1;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);
    const log = await nodeLog(B.page, 400);
    expect(log).toMatch(/loaded snapshot 64 from/);
    const [sa, sb] = await Promise.all([A.page.evaluate(() => window.__browserchain!.getStats()), B.page.evaluate(() => window.__browserchain!.getStats())]);
    expect(sb.totalAccounts).toBe(sa.totalAccounts);
    // same chain: once both are at the same seq, the hashes agree
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([status(A.page), status(B.page)]);
          return a.lcl.seq === b.lcl.seq ? (a.lcl.hash === b.lcl.hash ? 'same' : `fork at ${a.lcl.seq}`) : 'apart';
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBe('same');
    testInfo.annotations.push({ type: 'result', description: `B loaded snapshot 64 (${sa.totalAccounts} accounts) and synced ${since(t1)} after opening` });
    for (const n of nodes) expect(n.errors, `${n.label} page errors`).toEqual([]);
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await context.close();
  }
});
