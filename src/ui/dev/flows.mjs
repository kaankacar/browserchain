// Drives the main UI flows in a real browser against whatever NodeApi main.tsx
// wires (the mock today): wallet create/fund, send, issue an asset, trade,
// claimable balances, lab decode/build/sign/submit, manual quorum, light theme.
// Usage: dev server on 5181, then `node src/ui/dev/flows.mjs [outDir] [--mobile]`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'test-results/ui-shots';
const mobile = args.includes('--mobile');
const base = process.env.BASE_URL ?? 'http://localhost:5181/';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
const t0 = Date.now();
const log = (msg) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${msg}`);
let n = 0;
const shot = async (name) => {
  const file = join(outDir, `flow-${mobile ? 'mobile-' : ''}${String(++n).padStart(2, '0')}-${name}.png`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true });
  log(`screenshot ${file}`);
};
const go = async (hash) => {
  await page.evaluate((h) => (window.location.hash = h), hash);
  await page.waitForTimeout(500);
};
const applied = async (scope = page, timeout = 30_000) => {
  await scope.getByText(/Applied in ledger/).last().waitFor({ timeout });
};
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`);
    await shot(`fail-${name.replace(/\W+/g, '-')}`);
  }
}

await page.goto(`${base}#/wallet`);
await page.waitForTimeout(3000);

let first = '';
let second = '';

await step('create and fund the first account', async () => {
  await page.getByRole('button', { name: 'Create a test account' }).click();
  await page.getByText('10,000 XLM').first().waitFor({ timeout: 30_000 });
  first = await page.evaluate(() => JSON.parse(localStorage.getItem('browserchain:wallet:main'))[0].publicKey);
});

await step('create and fund a second account', async () => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Fund with friendbot' }).first().click();
  await page.getByText('Funding this account').first().waitFor({ timeout: 5_000 });
  await page.getByText('10,000 XLM').nth(1).waitFor({ timeout: 30_000 });
  second = await page.evaluate(() => JSON.parse(localStorage.getItem('browserchain:wallet:main'))[1].publicKey);
});

await step('send a payment with a memo', async () => {
  await page.getByRole('button', { name: /Account 1/ }).first().click();
  await go('#/wallet/send');
  await page.getByLabel('Destination').fill(second);
  await page.getByLabel('Amount', { exact: true }).fill('12.5');
  await page.getByLabel('Memo (optional)').fill('hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await applied();
  await shot('sent');
});

await step('issue an asset', async () => {
  await go('#/wallet/issue');
  await page.getByLabel('Asset code').fill('PIZZA');
  await page.getByLabel('Amount to mint').fill('500');
  await page.getByRole('button', { name: 'Issue asset' }).click();
  await page.getByText('PIZZA is live').waitFor({ timeout: 60_000 });
  await shot('issued');
});

await step('trust USDB and buy from the book', async () => {
  await go('#/wallet/trade');
  await page.getByText('Bids').first().waitFor();
  const trust = page.getByRole('button', { name: /^Trust / });
  if (await trust.count()) {
    await trust.first().click();
    await page.getByText('Trustline needed').waitFor({ state: 'detached', timeout: 30_000 });
  }
  // Pick the best ask: sets the price and switches to Buy.
  await page.locator('ul li button[title^="Use price"]').nth(0).click();
  const askButtons = page.getByText('Asks').locator('xpath=../..').locator('button[title^="Use price"]');
  if (await askButtons.count()) await askButtons.first().click();
  await page.getByLabel(/Amount \(/).fill('5');
  await page.getByRole('button', { name: /^Buy / }).last().click();
  await applied();
  await shot('traded');
});

await step('create a claimable balance and claim it', async () => {
  await go('#/wallet/claim');
  await page.getByLabel('Recipient').fill(second);
  await page.getByLabel('Amount').fill('3');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await applied();
  await page.getByRole('button', { name: /Account 2/ }).first().click();
  await page.getByRole('button', { name: 'Claim', exact: true }).first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Claim', exact: true }).first().click();
  await applied();
  await shot('claimed');
});

await step('activity shows applied transactions', async () => {
  await go('#/wallet/activity');
  await page.getByText('Applied').first().waitFor();
  await shot('activity');
});

await step('decode the latest transaction in the lab', async () => {
  await go('#/lab');
  await page.getByRole('button', { name: 'Latest transaction' }).click();
  await page.getByText('envelopeTypeTx').first().waitFor({ timeout: 10_000 });
  await shot('lab-decode');
});

await step('build, sign and submit in the lab', async () => {
  await go('#/lab/build');
  await page.getByLabel('Source account').fill(first);
  await page.getByLabel('Destination').fill(second);
  await page.getByLabel('Amount').fill('1');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Build transaction' }).click();
  await page.getByRole('button', { name: 'Sign it' }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByText(/^Signed by/).waitFor();
  await shot('lab-signed');
  await page.getByRole('button', { name: 'Submit…' }).click();
  await page.getByRole('button', { name: 'Submit to the network' }).click();
  await applied();
  await shot('lab-submitted');
});

await step('explorer shows the account with balances', async () => {
  await go(`#/account/${first}`);
  await page.getByText('PIZZA').first().waitFor({ timeout: 10_000 });
  await shot('account');
});

await step('apply a manual quorum and return to auto', async () => {
  await go('#/validator');
  await page.getByRole('radio', { name: 'Manual' }).click();
  await page.getByRole('button', { name: 'Apply manual quorum' }).click();
  await page.getByText('Manual quorum set applied').waitFor({ timeout: 5_000 });
  await shot('quorum-manual');
  await page.getByRole('radio', { name: 'Auto' }).click();
  await page.getByText('Quorum set to auto').waitFor({ timeout: 5_000 });
});

await step('light theme', async () => {
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await go('#/');
  await page.waitForTimeout(2500);
  await shot('light-overview');
  await go('#/wallet/trade');
  await page.waitForTimeout(1200);
  await shot('light-trade');
  await go(`#/account/${first}`);
  await page.waitForTimeout(1200);
  await shot('light-account');
});

await browser.close();
for (const e of errors) console.log(e);
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : `all flows passed${errors.length ? ` (${errors.length} console errors)` : ''}`);
process.exit(failures.length ? 1 : 0);
