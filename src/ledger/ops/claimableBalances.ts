// CreateClaimableBalance, ClaimClaimableBalance and ClawbackClaimableBalance.
// Ported from stellar-core (Apache-2.0): src/transactions/CreateClaimableBalanceOpFrame.cpp,
// src/transactions/ClaimClaimableBalanceOpFrame.cpp, src/transactions/ClawbackClaimableBalanceOpFrame.cpp

import { xdr } from '@stellar/stellar-sdk/base';
import { fromHex, toHex } from '../../lib/bytes';
import { sha256 } from '../../lib/hash';
import {
  addBalance,
  establishSponsorship,
  getAvailableBalance,
  isClawbackEnabledOnAccount,
  loadTrustLine,
  removeSponsorship,
} from '../balances';
import { accountKey, claimableBalanceKey } from '../keys';
import { INT64_MAX } from '../math';
import { opInner, opOuter } from '../results';
import type { LedgerTxn } from '../state';
import { CB_CLAWBACK_ENABLED_FLAG, type ClaimPredicate, type ClaimableBalanceEntry, type Claimant } from '../types';
import { accountIdFromString, accountIdToString, assetFromXdr, balanceIdToHex, isXdrAssetValid, opBody } from '../xdrutil';
import type { OpFrame } from './types';

// ---------------------------------------------------------------- predicates

/** validatePredicate (creation): depth <= 4, two children for and/or, non-negative times. */
export function validatePredicateXdr(p: xdr.ClaimPredicate, depth: number): boolean {
  if (depth > 4) return false;
  switch (p.type) {
    case 'claimPredicateUnconditional':
      return true;
    case 'claimPredicateAnd': {
      const ps = p.andPredicates;
      return ps.length === 2 && validatePredicateXdr(ps[0], depth + 1) && validatePredicateXdr(ps[1], depth + 1);
    }
    case 'claimPredicateOr': {
      const ps = p.orPredicates;
      return ps.length === 2 && validatePredicateXdr(ps[0], depth + 1) && validatePredicateXdr(ps[1], depth + 1);
    }
    case 'claimPredicateNot': {
      const inner = p.notPredicate;
      return inner != null && validatePredicateXdr(inner, depth + 1);
    }
    case 'claimPredicateBeforeAbsoluteTime':
      return p.absBefore >= 0n;
    case 'claimPredicateBeforeRelativeTime':
      return p.relBefore >= 0n;
    default:
      return false;
  }
}

/** updatePredicatesForApply: relative times become absolute (closeTime + relative, capped at INT64_MAX). */
export function predicateFromXdr(p: xdr.ClaimPredicate, closeTime: bigint): ClaimPredicate {
  switch (p.type) {
    case 'claimPredicateUnconditional':
      return { type: 'unconditional' };
    case 'claimPredicateAnd': {
      const ps = p.andPredicates;
      return { type: 'and', predicates: [predicateFromXdr(ps[0], closeTime), predicateFromXdr(ps[1], closeTime)] };
    }
    case 'claimPredicateOr': {
      const ps = p.orPredicates;
      return { type: 'or', predicates: [predicateFromXdr(ps[0], closeTime), predicateFromXdr(ps[1], closeTime)] };
    }
    case 'claimPredicateNot':
      return { type: 'not', predicate: predicateFromXdr(p.notPredicate!, closeTime) };
    case 'claimPredicateBeforeAbsoluteTime':
      return { type: 'beforeAbsoluteTime', time: p.absBefore };
    case 'claimPredicateBeforeRelativeTime': {
      const rel = p.relBefore;
      return { type: 'beforeAbsoluteTime', time: closeTime > INT64_MAX - rel ? INT64_MAX : closeTime + rel };
    }
    default:
      throw new Error('Invalid ClaimPredicate');
  }
}

/** Evaluate a predicate at a close time (ClaimClaimableBalanceOpFrame validatePredicate). */
export function evaluatePredicate(p: ClaimPredicate, closeTime: bigint): boolean {
  switch (p.type) {
    case 'unconditional':
      return true;
    case 'and':
      return evaluatePredicate(p.predicates[0], closeTime) && evaluatePredicate(p.predicates[1], closeTime);
    case 'or':
      return evaluatePredicate(p.predicates[0], closeTime) || evaluatePredicate(p.predicates[1], closeTime);
    case 'not':
      return !evaluatePredicate(p.predicate, closeTime);
    case 'beforeAbsoluteTime':
      return p.time > closeTime;
  }
}

/** Claimable balance id: SHA-256 of HashIDPreimage ENVELOPE_TYPE_OP_ID (tx source, tx seqNum, op index). */
export function claimableBalanceId(txSourceId: string, txSeqNum: bigint, opIndex: number): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeOpId(
    new xdr.HashIdPreimageOperationId({
      sourceAccount: accountIdFromString(txSourceId),
      seqNum: xdr.Int64(txSeqNum),
      opNum: opIndex,
    }),
  );
  return toHex(sha256(preimage.toXdr()));
}

// removeEntryWithPossibleSponsorship for a claimable balance: the sponsor gets its reserve back.
function releaseBalanceReserve(ltx: LedgerTxn, cb: Readonly<ClaimableBalanceEntry>): void {
  const sponsor = ltx.loadAccount(cb.sponsor);
  if (!sponsor) throw new Error('claimable balance sponsor missing');
  removeSponsorship(sponsor, cb.claimants.length);
}

// ---------------------------------------------------------------- operations

export const createClaimableBalance: OpFrame = {
  threshold: () => 'MEDIUM',

  checkValid({ op }) {
    const o = opBody(op, 'createClaimableBalance').createClaimableBalanceOp;
    const claimants = o.claimants;
    if (!isXdrAssetValid(o.asset) || o.amount <= 0n || claimants.length === 0) {
      return opInner('CREATE_CLAIMABLE_BALANCE_MALFORMED');
    }
    const seen = new Set<string>();
    for (const c of claimants) {
      const dest = accountIdToString(c.v0.destination);
      if (seen.has(dest)) return opInner('CREATE_CLAIMABLE_BALANCE_MALFORMED');
      seen.add(dest);
    }
    for (const c of claimants) {
      if (!validatePredicateXdr(c.v0.predicate, 1)) return opInner('CREATE_CLAIMABLE_BALANCE_MALFORMED');
    }
    return null;
  },

  apply({ tx, op, sourceId, ltx, closeTime }) {
    const o = opBody(op, 'createClaimableBalance').createClaimableBalanceOp;
    const asset = assetFromXdr(o.asset);
    const amount = o.amount;
    const header = ltx.header;
    const source = ltx.loadAccount(sourceId);
    if (!source) throw new Error('source account missing');

    let flags = 0;
    if (asset.type === 'native') {
      if (getAvailableBalance(header, source) < amount) return opInner('CREATE_CLAIMABLE_BALANCE_UNDERFUNDED');
      if (!addBalance(header, source, -amount)) throw new Error('addBalance failed');
    } else {
      const line = loadTrustLine(ltx, sourceId, asset);
      if (!line) return opInner('CREATE_CLAIMABLE_BALANCE_NO_TRUST');
      if (!line.isAuthorized()) return opInner('CREATE_CLAIMABLE_BALANCE_NOT_AUTHORIZED');
      if (!line.addBalance(header, -amount)) return opInner('CREATE_CLAIMABLE_BALANCE_UNDERFUNDED');
      const clawback = sourceId === asset.issuer ? isClawbackEnabledOnAccount(source) : line.isClawbackEnabled();
      if (clawback) flags = CB_CLAWBACK_ENABLED_FLAG;
    }

    const claimants: Claimant[] = o.claimants.map((c) => ({
      destination: accountIdToString(c.v0.destination),
      predicate: predicateFromXdr(c.v0.predicate, closeTime),
    }));
    const balanceId = claimableBalanceId(tx.sourceId, tx.seqNum, op.index);

    const r = establishSponsorship(header, source, claimants.length);
    if (r === 'LOW_RESERVE') return opInner('CREATE_CLAIMABLE_BALANCE_LOW_RESERVE');
    if (r !== 'SUCCESS') return opOuter('opTOO_MANY_SPONSORING');

    ltx.create<ClaimableBalanceEntry>({
      kind: 'claimableBalance',
      balanceId,
      claimants,
      asset,
      amount,
      flags,
      sponsor: sourceId,
      lastModifiedLedgerSeq: ltx.ledgerSeq,
    });
    return opInner('CREATE_CLAIMABLE_BALANCE_SUCCESS', xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(fromHex(balanceId)));
  },
};

export const claimClaimableBalance: OpFrame = {
  threshold: () => 'LOW',
  checkValid: () => null,

  apply({ op, sourceId, ltx, closeTime }) {
    const id = balanceIdToHex(opBody(op, 'claimClaimableBalance').claimClaimableBalanceOp.balanceId);
    const key = claimableBalanceKey(id);
    const cb = ltx.load(key) as ClaimableBalanceEntry | undefined;
    if (!cb) return opInner('CLAIM_CLAIMABLE_BALANCE_DOES_NOT_EXIST');

    const claimant = cb.claimants.find((c) => c.destination === sourceId);
    if (!claimant || !evaluatePredicate(claimant.predicate, closeTime)) {
      return opInner('CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM');
    }

    const header = ltx.header;
    if (cb.asset.type === 'native') {
      const acc = ltx.loadAccount(sourceId);
      if (!acc || !addBalance(header, acc, cb.amount)) return opInner('CLAIM_CLAIMABLE_BALANCE_LINE_FULL');
    } else {
      const line = loadTrustLine(ltx, sourceId, cb.asset);
      if (!line) return opInner('CLAIM_CLAIMABLE_BALANCE_NO_TRUST');
      if (!line.isAuthorized()) return opInner('CLAIM_CLAIMABLE_BALANCE_NOT_AUTHORIZED');
      if (!line.addBalance(header, cb.amount)) return opInner('CLAIM_CLAIMABLE_BALANCE_LINE_FULL');
    }

    releaseBalanceReserve(ltx, cb);
    ltx.erase(key);
    return opInner('CLAIM_CLAIMABLE_BALANCE_SUCCESS');
  },
};

export const clawbackClaimableBalance: OpFrame = {
  threshold: () => 'MEDIUM',
  checkValid: () => null,

  apply({ op, sourceId, ltx }) {
    const id = balanceIdToHex(opBody(op, 'clawbackClaimableBalance').clawbackClaimableBalanceOp.balanceId);
    const key = claimableBalanceKey(id);
    const cb = ltx.load(key) as ClaimableBalanceEntry | undefined;
    if (!cb) return opInner('CLAWBACK_CLAIMABLE_BALANCE_DOES_NOT_EXIST');
    if (cb.asset.type === 'native' || cb.asset.issuer !== sourceId) {
      return opInner('CLAWBACK_CLAIMABLE_BALANCE_NOT_ISSUER');
    }
    if ((cb.flags & CB_CLAWBACK_ENABLED_FLAG) === 0) {
      return opInner('CLAWBACK_CLAIMABLE_BALANCE_NOT_CLAWBACK_ENABLED');
    }
    if (!ltx.get(accountKey(sourceId))) throw new Error('source account missing');
    releaseBalanceReserve(ltx, cb);
    ltx.erase(key);
    return opInner('CLAWBACK_CLAIMABLE_BALANCE_SUCCESS');
  },
};
