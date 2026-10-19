// Ported from stellar-core (Apache-2.0): src/transactions/SetOptionsOpFrame.cpp

import {
  MASK_ACCOUNT_FLAGS,
  MAX_SIGNERS,
  accountFlagClawbackIsValid,
  accountFlagMaskCheckIsValid,
  createSubentry,
  isImmutableAuth,
  removeSubentry,
} from '../balances';
import { accountKey } from '../keys';
import { opInner, opOuter } from '../results';
import { accountIdToString, isStringValid, opBody, signerKeyToString, xdrStringBytes, xdrStringToText } from '../xdrutil';
import type { OpFrame } from './types';

export const setOptions: OpFrame = {
  threshold({ op }) {
    const o = opBody(op, 'setOptions').setOptionsOp;
    const high =
      o.masterWeight != null ||
      o.lowThreshold != null ||
      o.medThreshold != null ||
      o.highThreshold != null ||
      o.signer != null;
    return high ? 'HIGH' : 'MEDIUM';
  },

  checkValid({ op, sourceId }) {
    const o = opBody(op, 'setOptions').setOptionsOp;
    const setFlags = o.setFlags;
    const clearFlags = o.clearFlags;
    if (
      (setFlags != null && !accountFlagMaskCheckIsValid(setFlags)) ||
      (clearFlags != null && !accountFlagMaskCheckIsValid(clearFlags))
    ) {
      return opInner('SET_OPTIONS_UNKNOWN_FLAG');
    }
    if (setFlags != null && clearFlags != null && (setFlags & clearFlags) !== 0) {
      return opInner('SET_OPTIONS_BAD_FLAGS');
    }
    for (const t of [o.masterWeight, o.lowThreshold, o.medThreshold, o.highThreshold]) {
      if (t != null && t > 255) return opInner('SET_OPTIONS_THRESHOLD_OUT_OF_RANGE');
    }
    const signer = o.signer;
    if (signer != null) {
      const kind = signer.key.type;
      // Signed payload signers are not supported on this network.
      if (kind === 'signerKeyTypeEd25519SignedPayload') return opInner('SET_OPTIONS_BAD_SIGNER');
      if (kind === 'signerKeyTypeEd25519' && signerKeyToString(signer.key) === sourceId) {
        return opInner('SET_OPTIONS_BAD_SIGNER');
      }
      if (signer.weight > 255) return opInner('SET_OPTIONS_BAD_SIGNER');
    }
    const homeDomain = o.homeDomain;
    if (homeDomain != null && !isStringValid(xdrStringBytes(homeDomain))) {
      return opInner('SET_OPTIONS_INVALID_HOME_DOMAIN');
    }
    return null;
  },

  apply({ op, sourceId, ltx }) {
    const o = opBody(op, 'setOptions').setOptionsOp;
    const header = ltx.header;
    const acc = ltx.loadAccount(sourceId);
    if (!acc) throw new Error('source account missing');

    const inflationDest = o.inflationDest;
    if (inflationDest != null) {
      const id = accountIdToString(inflationDest);
      if (id !== sourceId && !ltx.get(accountKey(id))) return opInner('SET_OPTIONS_INVALID_INFLATION');
      acc.inflationDest = id;
    }

    const clearFlags = o.clearFlags;
    if (clearFlags != null) {
      if ((clearFlags & MASK_ACCOUNT_FLAGS) !== 0 && isImmutableAuth(acc)) return opInner('SET_OPTIONS_CANT_CHANGE');
      acc.flags = acc.flags & ~clearFlags;
    }
    const setFlags = o.setFlags;
    if (setFlags != null) {
      if ((setFlags & MASK_ACCOUNT_FLAGS) !== 0 && isImmutableAuth(acc)) return opInner('SET_OPTIONS_CANT_CHANGE');
      acc.flags = acc.flags | setFlags;
    }
    if ((setFlags != null || clearFlags != null) && !accountFlagClawbackIsValid(acc.flags)) {
      return opInner('SET_OPTIONS_AUTH_REVOCABLE_REQUIRED');
    }

    const homeDomain = o.homeDomain;
    if (homeDomain != null) acc.homeDomain = xdrStringToText(homeDomain);

    const mw = o.masterWeight;
    if (mw != null) acc.thresholds.master = mw & 0xff;
    const low = o.lowThreshold;
    if (low != null) acc.thresholds.low = low & 0xff;
    const med = o.medThreshold;
    if (med != null) acc.thresholds.med = med & 0xff;
    const high = o.highThreshold;
    if (high != null) acc.thresholds.high = high & 0xff;

    const signer = o.signer;
    if (signer != null) {
      const key = signerKeyToString(signer.key);
      const weight = signer.weight;
      const idx = acc.signers.findIndex((s) => s.key === key);
      if (weight > 0) {
        if (idx >= 0) {
          acc.signers[idx].weight = weight;
        } else {
          if (acc.signers.length >= MAX_SIGNERS) return opInner('SET_OPTIONS_TOO_MANY_SIGNERS');
          const r = createSubentry(header, acc, 1);
          if (r === 'LOW_RESERVE') return opInner('SET_OPTIONS_LOW_RESERVE');
          if (r === 'TOO_MANY_SUBENTRIES') return opOuter('opTOO_MANY_SUBENTRIES');
          if (r === 'TOO_MANY_SPONSORING') return opOuter('opTOO_MANY_SPONSORING');
          acc.signers.push({ key, weight });
          acc.signers.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        }
      } else if (idx >= 0) {
        acc.signers.splice(idx, 1);
        removeSubentry(acc, 1);
      }
    }

    return opInner('SET_OPTIONS_SUCCESS');
  },
};
