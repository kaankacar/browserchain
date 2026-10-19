// Friendbot channel policy (docs/ARCHITECTURE.md 4 and 7.3). A BrowserChain
// rule, not in stellar-core: the channel keys are public (derived from the
// passphrase), so a channel may only hand out FRIENDBOT_AMOUNT, and only in
// an operation that can succeed (channelDestinationResult).

import { FRIENDBOT_AMOUNT, STROOPS_PER_XLM } from '../lib/constants';
import { opInner, type OpResult } from './results';
import type { DecodedOp, DecodedTx } from './tx';
import { accountIdToString, muxedToAccountId, opBody } from './xdrutil';

/** Detail of a txNOT_SUPPORTED result caused by the policy. */
export const CHANNEL_POLICY_DETAIL = `friendbot channel policy: a transaction that uses a channel account may only hold one CreateAccount or native Payment of ${FRIENDBOT_AMOUNT / STROOPS_PER_XLM} XLM from it and must bid exactly the base fee, and a channel's own transaction may not set a minimum sequence number`;

/** Added to the detail of a channel operation refused for its destination. */
export const CHANNEL_DESTINATION_DETAIL =
  'friendbot channel policy: a channel only creates an account that does not exist and only pays an account that exists';

/**
 * True when the transaction's source or an operation's source is one of the
 * channels. Such transactions fall under the policy and count against
 * MAX_FRIENDBOT_TXS_IN_TX_SET.
 */
export function usesChannel(tx: DecodedTx, channels: ReadonlySet<string>): boolean {
  return channels.has(tx.sourceId) || tx.ops.some((op) => channels.has(op.sourceId));
}

/**
 * True when the transaction may use the friendbot channels `channels`. A
 * transaction whose source, or any of whose operation sources, is a channel
 * account must have exactly one operation, sourced from that channel: a
 * CreateAccount with startingBalance FRIENDBOT_AMOUNT, or a native Payment of
 * FRIENDBOT_AMOUNT. Destinations are not restricted. Its fee bid must be
 * exactly `baseFee` (the base fee for one operation), so nobody outbids
 * friendbot transactions or replaces a queued one by fee. (The fee charged
 * was already at most the base fee.) A transaction sourced from a channel
 * may not carry minSeqNum: the relaxed sequence check would let it set the
 * channel's sequence number to INT64_MAX, after which no transaction of the
 * channel is valid. Other transactions pass.
 */
export function channelPolicyAllows(tx: DecodedTx, channels: ReadonlySet<string>, baseFee: number): boolean {
  if (!usesChannel(tx, channels)) return true;
  const fromChannel = channels.has(tx.sourceId);
  if (tx.ops.length !== 1) return false;
  if (tx.fee !== BigInt(baseFee)) return false;
  if (fromChannel && tx.minSeqNum !== null) return false;
  const op = tx.ops[0];
  // The operation is the channel's: its own source when the transaction is from a channel.
  if (!channels.has(op.sourceId) || (fromChannel && op.sourceId !== tx.sourceId)) return false;
  switch (op.type) {
    case 'createAccount':
      return opBody(op, 'createAccount').createAccountOp.startingBalance === FRIENDBOT_AMOUNT;
    case 'payment': {
      const p = opBody(op, 'payment').paymentOp;
      return p.asset.type === 'assetTypeNative' && p.amount === FRIENDBOT_AMOUNT;
    }
    default:
      return false;
  }
}

/**
 * Destination rule of the policy, for checkValid (the mempool and tx sets)
 * and not when applying. A channel CreateAccount must create an account that
 * does not exist, and a channel Payment must pay an account that exists.
 * Else the operation could only fail when applied: that costs the channels
 * nothing, and such transactions could fill the friendbot lane for the base
 * fee. Returns the result the operation would get when applied, or null.
 *
 * `exists` answers for the state checkValid uses (the LCL). `chainCreates`:
 * accounts that channel CreateAccounts earlier in the source account's chain
 * create, which exist when this transaction applies. Null when unknown (a
 * single check of a transaction that follows queued ones): then a missing
 * Payment destination is left to the tx set check.
 */
export function channelDestinationResult(
  op: DecodedOp,
  channels: ReadonlySet<string>,
  exists: (accountId: string) => boolean,
  chainCreates: ReadonlySet<string> | null,
): OpResult | null {
  if (!channels.has(op.sourceId)) return null;
  switch (op.type) {
    case 'createAccount': {
      const dest = accountIdToString(opBody(op, 'createAccount').createAccountOp.destination);
      return exists(dest) || chainCreates?.has(dest) ? opInner('CREATE_ACCOUNT_ALREADY_EXIST') : null;
    }
    case 'payment': {
      const dest = muxedToAccountId(opBody(op, 'payment').paymentOp.destination);
      return exists(dest) || !chainCreates || chainCreates.has(dest) ? null : opInner('PAYMENT_NO_DESTINATION');
    }
    default:
      return null;
  }
}

/** Accounts that the transaction's channel CreateAccounts create (for chainCreates). */
export function channelCreatedAccounts(tx: DecodedTx, channels: ReadonlySet<string>): string[] {
  return tx.ops
    .filter((op) => op.type === 'createAccount' && channels.has(op.sourceId))
    .map((op) => accountIdToString(opBody(op, 'createAccount').createAccountOp.destination));
}
