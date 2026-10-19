// Ported from stellar-core (Apache-2.0): src/transactions/ClawbackOpFrame.cpp

import { addBalanceSkipAuthorization, isClawbackEnabledOnTrustline } from '../balances';
import { trustlineKey } from '../keys';
import { opInner } from '../results';
import type { CreditAsset, TrustLineEntry } from '../types';
import { assetFromXdr, isMuxed, isXdrAssetValid, muxedToAccountId, opBody } from '../xdrutil';
import type { OpFrame } from './types';

export const clawback: OpFrame = {
  threshold: () => 'MEDIUM',

  checkValid({ op, sourceId }) {
    const o = opBody(op, 'clawback').clawbackOp;
    // mClawback.from == toMuxedAccount(getSourceID()): only a plain (non-muxed) self address.
    if (!isMuxed(o.from) && muxedToAccountId(o.from) === sourceId) return opInner('CLAWBACK_MALFORMED');
    if (o.amount < 1n) return opInner('CLAWBACK_MALFORMED');
    const a = o.asset;
    if (a.type === 'assetTypeNative') return opInner('CLAWBACK_MALFORMED');
    if (!isXdrAssetValid(a)) return opInner('CLAWBACK_MALFORMED');
    if ((assetFromXdr(a) as CreditAsset).issuer !== sourceId) return opInner('CLAWBACK_MALFORMED');
    return null;
  },

  apply({ op, ltx }) {
    const o = opBody(op, 'clawback').clawbackOp;
    const from = muxedToAccountId(o.from);
    const asset = assetFromXdr(o.asset) as CreditAsset;
    const tl = ltx.load(trustlineKey(from, asset)) as TrustLineEntry | undefined;
    if (!tl) return opInner('CLAWBACK_NO_TRUST');
    if (!isClawbackEnabledOnTrustline(tl)) return opInner('CLAWBACK_NOT_CLAWBACK_ENABLED');
    if (!addBalanceSkipAuthorization(tl, -o.amount)) return opInner('CLAWBACK_UNDERFUNDED');
    return opInner('CLAWBACK_SUCCESS');
  },
};
