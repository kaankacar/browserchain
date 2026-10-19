// AllowTrust and SetTrustLineFlags.
// Ported from stellar-core (Apache-2.0): src/transactions/TrustFlagsOpFrameBase.cpp,
// src/transactions/AllowTrustOpFrame.cpp, src/transactions/SetTrustLineFlagsOpFrame.cpp

import {
  TRUSTLINE_AUTH_FLAGS,
  isAuthRevocable,
  isAuthorized,
  isAuthorizedToMaintainLiabilities,
  isAuthorizedToMaintainLiabilitiesFlags,
  trustLineFlagAuthIsValid,
  trustLineFlagIsValid,
  trustLineFlagMaskCheckIsValid,
} from '../balances';
import { accountKey, trustlineKey } from '../keys';
import { removeOffersByAccountAndAsset } from '../offers';
import { opInner, type OpResult } from '../results';
import {
  TL_AUTHORIZED_FLAG,
  TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG,
  TL_CLAWBACK_ENABLED_FLAG,
  type AccountEntry,
  type CreditAsset,
  type TrustLineEntry,
} from '../types';
import { accountIdToString, assetFromCode, assetFromXdr, isXdrAssetValid, opBody } from '../xdrutil';
import type { ApplyEnv, OpFrame } from './types';

interface TrustFlagsSpec {
  prefix: 'ALLOW_TRUST' | 'SET_TRUST_LINE_FLAGS';
  trustor: string;
  asset: CreditAsset;
  /** isAuthRevocationValid: a failure result or null. */
  checkRevocation(source: Readonly<AccountEntry>): OpResult | null;
  /** calcExpectedFlagValue: the new flags or a failure result. */
  expectedFlags(tl: Readonly<TrustLineEntry>): number | OpResult;
  /** isRevocationToMaintainLiabilitiesValid */
  checkMaintainLiabilities(source: Readonly<AccountEntry>, tl: Readonly<TrustLineEntry>, flags: number): OpResult | null;
}

// TrustFlagsOpFrameBase::doApply
function applyTrustFlags(env: ApplyEnv, spec: TrustFlagsSpec): OpResult {
  const { ltx, sourceId } = env;
  if (spec.trustor === sourceId) return opInner(`${spec.prefix}_SELF_NOT_ALLOWED`);

  const source = ltx.get(accountKey(sourceId)) as Readonly<AccountEntry> | undefined;
  if (!source) throw new Error('source account missing');
  const revocation = spec.checkRevocation(source);
  if (revocation) return revocation;

  const key = trustlineKey(spec.trustor, spec.asset);
  const tl = ltx.load(key) as TrustLineEntry | undefined;
  if (!tl) return opInner(`${spec.prefix}_NO_TRUST_LINE`);

  const expected = spec.expectedFlags(tl);
  if (typeof expected !== 'number') return expected;

  const maintain = spec.checkMaintainLiabilities(source, tl, expected);
  if (maintain) return maintain;

  const shouldRemoveOffers =
    isAuthorizedToMaintainLiabilities(tl) && !isAuthorizedToMaintainLiabilitiesFlags(expected);
  if (shouldRemoveOffers) removeOffersByAccountAndAsset(ltx, spec.trustor, spec.asset);

  const line = ltx.load(key) as TrustLineEntry;
  line.flags = expected;
  return opInner(`${spec.prefix}_SUCCESS`);
}

export const allowTrust: OpFrame = {
  threshold: () => 'LOW',

  checkValid({ op, sourceId }) {
    const o = opBody(op, 'allowTrust').allowTrustOp;
    const authorize = o.authorize;
    if (authorize > TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG) return opInner('ALLOW_TRUST_MALFORMED');
    if (!trustLineFlagIsValid(authorize)) return opInner('ALLOW_TRUST_MALFORMED');
    if (!assetFromCode(sourceId, o.asset).valid) return opInner('ALLOW_TRUST_MALFORMED');
    if (accountIdToString(o.trustor) === sourceId) return opInner('ALLOW_TRUST_MALFORMED');
    return null;
  },

  apply(env) {
    const o = opBody(env.op, 'allowTrust').allowTrustOp;
    const authorize = o.authorize;
    let authRevocable = true;
    return applyTrustFlags(env, {
      prefix: 'ALLOW_TRUST',
      trustor: accountIdToString(o.trustor),
      asset: assetFromCode(env.sourceId, o.asset).asset,
      checkRevocation(source) {
        authRevocable = isAuthRevocable(source);
        if (!authRevocable && authorize === 0) return opInner('ALLOW_TRUST_CANT_REVOKE');
        return null;
      },
      expectedFlags(tl) {
        return (tl.flags & ~TRUSTLINE_AUTH_FLAGS) | authorize;
      },
      checkMaintainLiabilities(_source, tl, flags) {
        if (!authRevocable && isAuthorized(tl) && (flags & TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG) !== 0) {
          return opInner('ALLOW_TRUST_CANT_REVOKE');
        }
        return null;
      },
    });
  },
};

export const setTrustLineFlags: OpFrame = {
  threshold: () => 'LOW',

  checkValid({ op, sourceId }) {
    const o = opBody(op, 'setTrustLineFlags').setTrustLineFlagsOp;
    const a = o.asset;
    if (a.type === 'assetTypeNative') return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    if (!isXdrAssetValid(a)) return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    const asset = assetFromXdr(a) as CreditAsset;
    if (asset.issuer !== sourceId) return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    if (accountIdToString(o.trustor) === sourceId) return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    const setFlags = o.setFlags;
    const clearFlags = o.clearFlags;
    if ((setFlags & clearFlags) !== 0) return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    if (!trustLineFlagIsValid(setFlags) || (setFlags & TL_CLAWBACK_ENABLED_FLAG) !== 0) {
      return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    }
    if (!trustLineFlagMaskCheckIsValid(clearFlags)) return opInner('SET_TRUST_LINE_FLAGS_MALFORMED');
    return null;
  },

  apply(env) {
    const o = opBody(env.op, 'setTrustLineFlags').setTrustLineFlagsOp;
    const setFlags = o.setFlags;
    const clearFlags = o.clearFlags;
    return applyTrustFlags(env, {
      prefix: 'SET_TRUST_LINE_FLAGS',
      trustor: accountIdToString(o.trustor),
      asset: assetFromXdr(o.asset) as CreditAsset,
      checkRevocation(source) {
        if (isAuthRevocable(source)) return null;
        const clearingAnyAuth = (clearFlags & TRUSTLINE_AUTH_FLAGS) !== 0;
        const settingAuthorized = (setFlags & TL_AUTHORIZED_FLAG) !== 0;
        if (clearingAnyAuth && !settingAuthorized) return opInner('SET_TRUST_LINE_FLAGS_CANT_REVOKE');
        return null;
      },
      expectedFlags(tl) {
        const v = (tl.flags & ~clearFlags) | setFlags;
        if (!trustLineFlagAuthIsValid(v)) return opInner('SET_TRUST_LINE_FLAGS_INVALID_STATE');
        return v;
      },
      checkMaintainLiabilities: () => null,
    });
  },
};
