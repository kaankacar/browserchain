// Ported from stellar-core (Apache-2.0): src/transactions/ChangeTrustOpFrame.cpp

import {
  createSubentry,
  getMinimumLimit,
  isAuthRequired,
  isClawbackEnabledOnAccount,
  removeSubentry,
} from '../balances';
import { accountKey, trustlineKey } from '../keys';
import { opInner, opOuter } from '../results';
import { TL_AUTHORIZED_FLAG, TL_CLAWBACK_ENABLED_FLAG, type AccountEntry, type CreditAsset, type TrustLineEntry } from '../types';
import { assetFromXdr, isXdrAssetValid, opBody } from '../xdrutil';
import type { OpFrame } from './types';

export const changeTrust: OpFrame = {
  threshold: () => 'MEDIUM',

  checkValid({ op, sourceId }) {
    const o = opBody(op, 'changeTrust').changeTrustOp;
    if (o.limit < 0n) return opInner('CHANGE_TRUST_MALFORMED');
    const line = o.line;
    // Liquidity pool shares are not supported on this network.
    if (line.type === 'assetTypePoolShare') return opInner('CHANGE_TRUST_MALFORMED');
    if (!isXdrAssetValid(line)) return opInner('CHANGE_TRUST_MALFORMED');
    if (line.type === 'assetTypeNative') return opInner('CHANGE_TRUST_MALFORMED');
    const asset = assetFromXdr(line) as CreditAsset;
    if (asset.issuer === sourceId) return opInner('CHANGE_TRUST_MALFORMED');
    return null;
  },

  apply({ op, sourceId, ltx }) {
    const o = opBody(op, 'changeTrust').changeTrustOp;
    const asset = assetFromXdr(o.line) as CreditAsset;
    const limit = o.limit;
    if (asset.issuer === sourceId) return opInner('CHANGE_TRUST_SELF_NOT_ALLOWED');

    const key = trustlineKey(sourceId, asset);
    const header = ltx.header;
    const tl = ltx.load(key) as TrustLineEntry | undefined;
    if (tl) {
      if (limit < getMinimumLimit(tl)) return opInner('CHANGE_TRUST_INVALID_LIMIT');
      if (limit === 0n) {
        const acc = ltx.loadAccount(sourceId);
        if (!acc) throw new Error('source account missing');
        removeSubentry(acc, 1);
        ltx.erase(key);
      } else {
        if (!ltx.get(accountKey(asset.issuer))) return opInner('CHANGE_TRUST_NO_ISSUER');
        tl.limit = limit;
      }
      return opInner('CHANGE_TRUST_SUCCESS');
    }

    if (limit === 0n) return opInner('CHANGE_TRUST_INVALID_LIMIT');
    const issuer = ltx.get(accountKey(asset.issuer)) as Readonly<AccountEntry> | undefined;
    if (!issuer) return opInner('CHANGE_TRUST_NO_ISSUER');
    let flags = 0;
    if (!isAuthRequired(issuer)) flags = TL_AUTHORIZED_FLAG;
    if (isClawbackEnabledOnAccount(issuer)) flags |= TL_CLAWBACK_ENABLED_FLAG;

    const acc = ltx.loadAccount(sourceId);
    if (!acc) throw new Error('source account missing');
    const r = createSubentry(header, acc, 1);
    if (r === 'LOW_RESERVE') return opInner('CHANGE_TRUST_LOW_RESERVE');
    if (r === 'TOO_MANY_SUBENTRIES') return opOuter('opTOO_MANY_SUBENTRIES');
    if (r === 'TOO_MANY_SPONSORING') return opOuter('opTOO_MANY_SPONSORING');

    ltx.create<TrustLineEntry>({
      kind: 'trustline',
      accountId: sourceId,
      asset,
      balance: 0n,
      limit,
      flags,
      buyingLiabilities: 0n,
      sellingLiabilities: 0n,
      lastModifiedLedgerSeq: ltx.ledgerSeq,
    });
    return opInner('CHANGE_TRUST_SUCCESS');
  },
};
