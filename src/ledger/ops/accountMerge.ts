// Ported from stellar-core (Apache-2.0): src/transactions/MergeOpFrame.cpp (doApplyFromV16)

import { addBalance, isImmutableAuth } from '../balances';
import { accountKey } from '../keys';
import { opInner } from '../results';
import { startingSequenceNumber } from '../tx';
import { int64, muxedToAccountId, opBody } from '../xdrutil';
import type { OpFrame } from './types';

export const accountMerge: OpFrame = {
  threshold: () => 'HIGH',

  checkValid({ op, sourceId }) {
    if (muxedToAccountId(opBody(op, 'accountMerge').destination) === sourceId) return opInner('ACCOUNT_MERGE_MALFORMED');
    return null;
  },

  apply({ op, sourceId, ltx, ledgerSeq }) {
    const destId = muxedToAccountId(opBody(op, 'accountMerge').destination);
    if (!ltx.get(accountKey(destId))) return opInner('ACCOUNT_MERGE_NO_ACCOUNT');

    const header = ltx.header;
    const source = ltx.loadAccount(sourceId);
    if (!source) throw new Error('source account missing');
    if (isImmutableAuth(source)) return opInner('ACCOUNT_MERGE_IMMUTABLE_SET');
    if (source.numSubEntries !== source.signers.length) return opInner('ACCOUNT_MERGE_HAS_SUB_ENTRIES');
    // isSeqnumTooFar: re-creating the account must not move its sequence backwards.
    if (source.seqNum >= startingSequenceNumber(ledgerSeq)) return opInner('ACCOUNT_MERGE_SEQNUM_TOO_FAR');
    if (source.numSponsoring > 0) return opInner('ACCOUNT_MERGE_IS_SPONSOR');

    // Remove signers (each one is a sub-entry).
    source.numSubEntries -= source.signers.length;
    source.signers = [];

    const balance = source.balance;
    const dest = ltx.loadAccount(destId);
    if (!dest || !addBalance(header, dest, balance)) return opInner('ACCOUNT_MERGE_DEST_FULL');

    ltx.erase(accountKey(sourceId));
    return opInner('ACCOUNT_MERGE_SUCCESS', int64(balance));
  },
};
