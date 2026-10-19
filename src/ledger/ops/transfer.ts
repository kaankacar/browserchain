// Crediting and debiting balances for payments (also usable by path payments).
// Ported from stellar-core (Apache-2.0): src/transactions/PathPaymentOpFrameBase.cpp

import { addBalance, getAvailableBalance, loadTrustLine } from '../balances';
import type { LedgerTxn } from '../state';
import type { Asset } from '../types';

export type CreditFailure = 'NO_TRUST' | 'NOT_AUTHORIZED' | 'LINE_FULL';
export type DebitFailure = 'MALFORMED' | 'UNDERFUNDED' | 'SRC_NO_TRUST' | 'SRC_NOT_AUTHORIZED';

/**
 * shouldBypassIssuerCheck: a direct payment of a credit asset back to its
 * issuer does not need the destination account to exist.
 */
export function shouldBypassIssuerCheck(sendAsset: Asset, destAsset: Asset, pathLength: number, destId: string): boolean {
  return (
    destAsset.type !== 'native' &&
    pathLength === 0 &&
    sendAsset.type !== 'native' &&
    sendAsset.code === destAsset.code &&
    sendAsset.issuer === destAsset.issuer &&
    destAsset.issuer === destId
  );
}

/** PathPaymentOpFrameBase::updateDestBalance (protocol 13+). Null on success. */
export function creditDestination(ltx: LedgerTxn, destId: string, asset: Asset, amount: bigint): CreditFailure | null {
  const header = ltx.header;
  if (asset.type === 'native') {
    const dest = ltx.loadAccount(destId);
    if (!dest || !addBalance(header, dest, amount)) return 'LINE_FULL';
    return null;
  }
  const line = loadTrustLine(ltx, destId, asset);
  if (!line) return 'NO_TRUST';
  if (!line.isAuthorized()) return 'NOT_AUTHORIZED';
  if (!line.addBalance(header, amount)) return 'LINE_FULL';
  return null;
}

/** PathPaymentOpFrameBase::updateSourceBalance (protocol 13+). Null on success. */
export function debitSource(ltx: LedgerTxn, sourceId: string, asset: Asset, amount: bigint): DebitFailure | null {
  const header = ltx.header;
  if (asset.type === 'native') {
    const source = ltx.loadAccount(sourceId);
    if (!source) return 'MALFORMED';
    if (amount > getAvailableBalance(header, source)) return 'UNDERFUNDED';
    if (!addBalance(header, source, -amount)) throw new Error('addBalance failed');
    return null;
  }
  const line = loadTrustLine(ltx, sourceId, asset);
  if (!line) return 'SRC_NO_TRUST';
  if (!line.isAuthorized()) return 'SRC_NOT_AUTHORIZED';
  if (!line.addBalance(header, -amount)) return 'UNDERFUNDED';
  return null;
}
