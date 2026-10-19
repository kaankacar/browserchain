// Visual check: screenshots every UI route at desktop and phone sizes.
// Usage: start `npx vite --port 5181 --strictPort`, then
//   node src/ui/dev/screenshots.mjs [outDir] [--only=name,name] [--light]
// Prints console errors and page errors it sees.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'test-results/ui-shots';
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const light = args.includes('--light');
const onlyVp = args.find((a) => a.startsWith('--viewport='))?.slice(11) ?? null;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const base = process.env.BASE_URL ?? 'http://localhost:5181/';
mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const browser = await chromium.launch();
let problems = 0;

async function setHash(page, hash) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForTimeout(900);
}

for (const vp of viewports) {
  if (onlyVp && vp.name !== onlyVp) continue;
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      problems++;
      console.log(`[${vp.name}] console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    problems++;
    console.log(`[${vp.name}] pageerror: ${err.message}`);
  });

  await page.goto(`${base}#/`);
  if (light) {
    await page.evaluate(() => localStorage.setItem('browserchain:theme', '"light"'));
    await page.reload();
  }
  // Boot, catch up and close a couple of ledgers.
  await page.waitForTimeout(9000);

  console.log(`[${vp.name}] ${stamp()} booted`);
  // Wallet: create a key and fund it so wallet pages have content.
  await setHash(page, '#/wallet');
  const create = page.getByRole('button', { name: /create (a |your first )?(test )?account/i }).first();
  if (await create.count()) {
    await create.click();
    console.log(`[${vp.name}] ${stamp()} created a key`);
    await page.waitForTimeout(400);
    const fund = page.getByRole('button', { name: /friendbot/i }).first();
    if (await fund.count()) await fund.click({ timeout: 5000 }).catch((e) => console.log(`[${vp.name}] fund click skipped: ${e.message.split('\n')[0]}`));
    console.log(`[${vp.name}] ${stamp()} funding`);
    await page.waitForTimeout(6500);
  }

  const txHref = await page.evaluate(async () => {
    window.location.hash = '#/txs';
    await new Promise((r) => setTimeout(r, 800));
    return document.querySelector('main a[href^="#/tx/"]')?.getAttribute('href') ?? null;
  });
  const accountHref = await page.evaluate(() => document.querySelector('main a[href^="#/account/"]')?.getAttribute('href') ?? null);

  const routes = [
    ['overview', '#/'],
    ['validator', '#/validator'],
    ['validator-scp', '#/validator/scp'],
    ['validator-peers', '#/validator/peers'],
    ['validator-logs', '#/validator/logs'],
    ['ledgers', '#/ledgers'],
    ['ledger', '#/ledger/6'],
    ['txs', '#/txs'],
    ['tx', txHref],
    ['account', accountHref],
    ['assets', '#/assets'],
    ['search', '#/search/hello'],
    ['wallet', '#/wallet'],
    ['wallet-trust', '#/wallet/trust'],
    ['wallet-issue', '#/wallet/issue'],
    ['wallet-trade', '#/wallet/trade'],
    ['wallet-claim', '#/wallet/claim'],
    ['wallet-activity', '#/wallet/activity'],
    ['lab', '#/lab'],
    ['lab-build', '#/lab/build'],
    ['lab-sign', '#/lab/sign'],
    ['lab-submit', '#/lab/submit'],
    ['about', '#/about'],
    ['notfound', '#/nowhere'],
  ];

  for (const [name, hash] of routes) {
    if (!hash) {
      console.log(`[${vp.name}] skip ${name}: no link found`);
      continue;
    }
    if (only && !only.includes(name)) continue;
    await setHash(page, hash);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) {
      problems++;
      console.log(`[${vp.name}] ${name}: horizontal overflow of ${overflow}px`);
    }
    const file = join(outDir, `${vp.name}-${light ? 'light-' : ''}${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[${vp.name}] ${stamp()} ${name} -> ${file}`);
  }
  await context.close();
}

await browser.close();
console.log(problems ? `done with ${problems} problem(s)` : 'done, no console errors');
