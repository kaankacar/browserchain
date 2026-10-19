// UI helpers for the wallet pages: read what the user sees (or what this
// browser stores) without assuming which tab created which key.
import { expect, type Page } from '@playwright/test';

export interface StoredKey {
  name: string;
  publicKey: string;
}

/** The account id of the key selected in the wallet (from its "Explorer" link). */
export async function selectedAccountId(page: Page): Promise<string> {
  const link = page.getByRole('main').getByRole('link', { name: 'Explorer', exact: true });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href')) ?? '';
  const id = href.replace('#/account/', '');
  expect(id).toMatch(/^G[A-Z2-7]{55}$/);
  return id;
}

/** Wallet keys saved in this browser (shared by every tab of the origin). */
export function walletKeys(page: Page, network = 'main'): Promise<StoredKey[]> {
  return page.evaluate((net) => {
    const raw = localStorage.getItem(`browserchain:wallet:${net}`);
    const list = raw ? (JSON.parse(raw) as StoredKey[]) : [];
    return list.map((k) => ({ name: k.name, publicKey: k.publicKey }));
  }, network);
}

/** Select a wallet key by its name in the Keys card. */
export async function selectKey(page: Page, name: string): Promise<void> {
  const button = page.getByRole('list', { name: 'Wallet keys' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Wait until the newest "Applied in ledger #N" line shows; returns N. */
export async function waitApplied(page: Page, timeout = 60_000): Promise<number> {
  const line = page.getByText(/Applied in ledger #/).last();
  await expect(line).toBeVisible({ timeout });
  return Number(((await line.textContent()) ?? '').replace(/\D/g, ''));
}
