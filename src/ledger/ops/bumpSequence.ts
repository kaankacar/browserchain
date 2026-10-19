// Ported from stellar-core (Apache-2.0): src/transactions/BumpSequenceOpFrame.cpp

import { opInner } from '../results';
import { opBody } from '../xdrutil';
import type { OpFrame } from './types';

export const bumpSequence: OpFrame = {
  threshold: () => 'LOW',

  checkValid({ op }) {
    if (opBody(op, 'bumpSequence').bumpSequenceOp.bumpTo < 0n) return opInner('BUMP_SEQUENCE_BAD_SEQ');
    return null;
  },

  apply({ op, sourceId, ltx, ledgerSeq, closeTime }) {
    const bumpTo = opBody(op, 'bumpSequence').bumpSequenceOp.bumpTo;
    const acc = ltx.loadAccount(sourceId);
    if (!acc) throw new Error('source account missing');
    // maybeUpdateAccountOnLedgerSeqUpdate (protocol 19+)
    acc.seqLedger = ledgerSeq;
    acc.seqTime = closeTime;
    if (bumpTo > acc.seqNum) acc.seqNum = bumpTo;
    return opInner('BUMP_SEQUENCE_SUCCESS');
  },
};
