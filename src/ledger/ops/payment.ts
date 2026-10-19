// Ported from stellar-core (Apache-2.0): src/transactions/PaymentOpFrame.cpp,
// src/transactions/PathPaymentStrictReceiveOpFrame.cpp (the no-path case)

import { accountKey } from '../keys';
import { opInner } from '../results';
import { assetFromXdr, isXdrAssetValid, muxedToAccountId, opBody } from '../xdrutil';
import { creditDestination, debitSource, shouldBypassIssuerCheck } from './transfer';
import type { OpFrame } from './types';

export const payment: OpFrame = {
  threshold: () => 'MEDIUM',

  checkValid({ op }) {
    const o = opBody(op, 'payment').paymentOp;
    if (o.amount <= 0n) return opInner('PAYMENT_MALFORMED');
    if (!isXdrAssetValid(o.asset)) return opInner('PAYMENT_MALFORMED');
    return null;
  },

  // PaymentOpFrame::doApply: a path payment with sendAsset == destAsset and no path.
  apply({ op, sourceId, ltx }) {
    const o = opBody(op, 'payment').paymentOp;
    const destId = muxedToAccountId(o.destination);
    const asset = assetFromXdr(o.asset);
    const amount = o.amount;

    if (destId === sourceId && asset.type === 'native') return opInner('PAYMENT_SUCCESS');

    const bypassIssuerCheck = shouldBypassIssuerCheck(asset, asset, 0, destId);
    if (!bypassIssuerCheck && !ltx.get(accountKey(destId))) return opInner('PAYMENT_NO_DESTINATION');

    const credit = creditDestination(ltx, destId, asset, amount);
    if (credit) return opInner(`PAYMENT_${credit}`);

    const debit = debitSource(ltx, sourceId, asset, amount);
    if (debit) return opInner(`PAYMENT_${debit}`);

    return opInner('PAYMENT_SUCCESS');
  },
};
