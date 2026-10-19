// Ported from stellar-core (Apache-2.0): src/transactions/CreateAccountOpFrame.cpp

import { addBalance, getAvailableBalance, minBalance } from '../balances';
import { accountKey } from '../keys';
import { opInner } from '../results';
import { startingSequenceNumber } from '../tx';
import type { AccountEntry } from '../types';
import { accountIdToString, opBody } from '../xdrutil';
import type { OpFrame } from './types';

/** A fresh account entry as created by CreateAccount. */
export function newAccountEntry(accountId: string, balance: bigint, seqNum: bigint, ledgerSeq: number): AccountEntry {
  return {
    kind: 'account',
    accountId,
    balance,
    seqNum,
    numSubEntries: 0,
    numSponsoring: 0,
    numSponsored: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: { master: 1, low: 0, med: 0, high: 0 },
    signers: [],
    buyingLiabilities: 0n,
    sellingLiabilities: 0n,
    seqLedger: 0,
    seqTime: 0n,
    lastModifiedLedgerSeq: ledgerSeq,
  };
}

export const createAccount: OpFrame = {
  threshold: () => 'MEDIUM',

  checkValid({ op, sourceId }) {
    const o = opBody(op, 'createAccount').createAccountOp;
    if (o.startingBalance < 0n) return opInner('CREATE_ACCOUNT_MALFORMED');
    if (accountIdToString(o.destination) === sourceId) return opInner('CREATE_ACCOUNT_MALFORMED');
    return null;
  },

  // CreateAccountOpFrame::doApply / doApplyFromV14
  apply({ op, sourceId, ltx, ledgerSeq }) {
    const o = opBody(op, 'createAccount').createAccountOp;
    const dest = accountIdToString(o.destination);
    const startingBalance = o.startingBalance;
    if (ltx.get(accountKey(dest))) return opInner('CREATE_ACCOUNT_ALREADY_EXIST');

    const header = ltx.header;
    const fresh = newAccountEntry(dest, startingBalance, startingSequenceNumber(ledgerSeq), ledgerSeq);
    // canCreateEntryWithoutSponsorship for an account: balance must cover its own reserve.
    if (startingBalance < minBalance(header, fresh)) return opInner('CREATE_ACCOUNT_LOW_RESERVE');

    const source = ltx.loadAccount(sourceId);
    if (!source) throw new Error('source account missing');
    if (getAvailableBalance(header, source) < startingBalance) return opInner('CREATE_ACCOUNT_UNDERFUNDED');
    if (!addBalance(header, source, -startingBalance)) throw new Error('addBalance failed');

    ltx.create(fresh);
    return opInner('CREATE_ACCOUNT_SUCCESS');
  },
};
