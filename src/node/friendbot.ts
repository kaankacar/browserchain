// Friendbot (ARCHITECTURE 11): fund an account from one of the genesis
// channel accounts. The channel keys are public (derived from the passphrase).

import { Account, Asset, Keypair, Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { formatAmount } from '../lib/amount';
import { FRIENDBOT_AMOUNT, FRIENDBOT_CHANNELS } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { sortNodeIds } from '../scp/quorum';

/** Channel index for the n-th friendbot request of a node: hash(nodeId + counter) mod 16. */
export function friendbotChannel(nodeId: string, counter: number): number {
  return sha256(`${nodeId}|${counter}`)[0] % FRIENDBOT_CHANNELS;
}

/**
 * Channels a node owns, so that nodes never build txs for the same channel
 * and sequence number: node i of the n sorted participants owns the channels
 * c with c mod n == i. Empty when the node is not a participant or i >= 16
 * (it then falls back to friendbotChannel).
 */
export function ownedFriendbotChannels(selfId: string, participants: Iterable<string>): number[] {
  const sorted = sortNodeIds(new Set(participants));
  const i = sorted.indexOf(selfId);
  const out: number[] = [];
  if (i < 0) return out;
  for (let c = i; c < FRIENDBOT_CHANNELS; c += sorted.length) out.push(c);
  return out;
}

export interface FriendbotTxInput {
  passphrase: string;
  channel: Keypair;
  /** Sequence number of the new transaction. */
  seqNum: bigint;
  destination: string;
  /** CreateAccount when true, else Payment. */
  create: boolean;
  amount?: bigint;
  baseFee?: number;
}

/** True when the envelope (base64) holds a CreateAccount for `destination`. */
export function createsAccount(envelopeXdr: string, destination: string): boolean {
  try {
    const env = xdr.TransactionEnvelope.fromXdr(envelopeXdr, 'base64');
    if (env.type !== 'envelopeTypeTx') return false;
    return env.v1.tx.operations.some((op) => {
      const body = op.body;
      if (body.type !== 'createAccount') return false;
      return StrKey.encodeEd25519PublicKey(body.createAccountOp.destination.ed25519.toBytes()) === destination;
    });
  } catch {
    return false;
  }
}

/** Signed envelope (base64) funding `destination`. */
export function buildFriendbotTx(input: FriendbotTxInput): string {
  if (!StrKey.isValidEd25519PublicKey(input.destination)) throw new Error(`invalid account id: ${input.destination}`);
  const amount = formatAmount(input.amount ?? FRIENDBOT_AMOUNT);
  const op = input.create
    ? Operation.createAccount({ destination: input.destination, startingBalance: amount })
    : Operation.payment({ destination: input.destination, asset: Asset.native(), amount });
  const account = new Account(input.channel.publicKey(), (input.seqNum - 1n).toString());
  const tx = new TransactionBuilder(account, {
    fee: String(input.baseFee ?? 100),
    networkPassphrase: input.passphrase,
  })
    .addOperation(op)
    .setTimeout(0)
    .build();
  tx.sign(input.channel);
  return tx.toEnvelope().toXdr('base64');
}
