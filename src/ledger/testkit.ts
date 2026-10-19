// Test helpers for the ledger module: build signed transactions and close ledgers.

import {
  Account,
  Asset,
  Keypair,
  Memo,
  MuxedAccount,
  Operation,
  TransactionBuilder,
  xdr,
  type AuthFlag,
  type Transaction,
} from '@stellar/stellar-sdk/base';
import { FRIENDBOT_AMOUNT, networkPassphrase } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { decodeLedgerHeader, encodeLedgerHeader, hashLedgerHeader } from './header';
import { friendbotKeypairs, genesisHeader, rootKeypair } from './genesis';
import { computeStateHash, serializeEntry } from './entries';
import { LedgerManager, createGenesisLedger, loadLedgerFromSnapshot } from './manager';
import { newAccountEntry } from './ops/createAccount';
import type { LedgerCloseResult, LedgerEntry, LedgerHeader, TxApplyResult } from './types';
import { makeSignedStellarValue } from './value';

export const TEST_PASSPHRASE = networkPassphrase('ledger-test');
export const XLM = 10_000_000n;

export interface TxOptions {
  /** Fee per operation (stroops). Default 100. */
  baseFee?: number;
  /** Explicit sequence number. Default: account seq + 1 (+ offset). */
  seq?: bigint;
  /** Added to the default sequence number. */
  seqOffset?: bigint;
  memo?: Memo;
  timebounds?: { minTime: number | string; maxTime: number | string };
  ledgerbounds?: { minLedger: number; maxLedger: number };
  /** Keys that sign. Default: the source key. */
  signers?: Keypair[];
  /** Hash-x preimages to add as signatures. */
  hashX?: Uint8Array[];
  /** Muxed id for the transaction source (M... address). */
  muxedId?: string;
}

export class TestLedger {
  readonly lm: LedgerManager;
  readonly passphrase: string;
  readonly root: Keypair;
  readonly channels: Keypair[];
  /** Node key that signs the StellarValues of closed ledgers. */
  node = Keypair.random();
  closeTime: number;

  /**
   * Without `lm` the ledger starts at genesis. On the testkit's own network
   * (TEST_PASSPHRASE, the default) the root is unlocked (the unlockRoot test
   * option), so fund() pays exact amounts from it. Any other passphrase gets
   * the genesis a node of that network has: the root is locked, and fund()
   * pays from the friendbot channels.
   */
  constructor(lm?: LedgerManager, passphrase = TEST_PASSPHRASE) {
    this.passphrase = passphrase;
    this.lm = lm ?? createGenesisLedger(passphrase, { unlockRoot: passphrase === TEST_PASSPHRASE });
    this.root = rootKeypair(passphrase);
    this.channels = friendbotKeypairs(passphrase);
    this.closeTime = Math.max(1_790_000_000, this.lm.lastClosed().header.scpValue.closeTime);
  }

  get ledgerSeq(): number {
    return this.lm.lastClosed().header.ledgerSeq;
  }

  seqOf(accountId: string): bigint {
    const a = this.lm.getAccount(accountId);
    if (!a) throw new Error(`no account ${accountId}`);
    return a.seqNum;
  }

  balanceOf(accountId: string): bigint {
    return this.lm.getAccount(accountId)?.balance ?? 0n;
  }

  build(source: Keypair | string, ops: xdr.Operation[], opts: TxOptions = {}): Transaction {
    const id = typeof source === 'string' ? source : source.publicKey();
    const seq = opts.seq ?? this.seqOf(id) + 1n + (opts.seqOffset ?? 0n);
    const base = new Account(id, (seq - 1n).toString());
    const acc = opts.muxedId ? new MuxedAccount(base, opts.muxedId) : base;
    const b = new TransactionBuilder(acc, {
      fee: String(opts.baseFee ?? 100),
      networkPassphrase: this.passphrase,
      memo: opts.memo,
      timebounds: opts.timebounds ?? { minTime: 0, maxTime: 0 },
      ledgerbounds: opts.ledgerbounds,
    });
    for (const op of ops) b.addOperation(op);
    const tx = b.build();
    const signers = opts.signers ?? (typeof source === 'string' ? [] : [source]);
    for (const kp of signers) tx.sign(kp);
    for (const x of opts.hashX ?? []) tx.signHashX(x);
    return tx;
  }

  /** Signed envelope (base64). */
  tx(source: Keypair | string, ops: xdr.Operation[], opts: TxOptions = {}): string {
    return this.build(source, ops, opts).toEnvelope().toXdr('base64');
  }

  /** Envelope built directly from XDR (no SDK argument checks), signed by `signers`. */
  rawTx(source: Keypair, ops: xdr.Operation[], opts: { seq?: bigint; fee?: number; signers?: Keypair[] } = {}): string {
    const seq = opts.seq ?? this.seqOf(source.publicKey()) + 1n;
    const tx = new xdr.Transaction({
      sourceAccount: xdr.MuxedAccount.keyTypeEd25519(source.rawPublicKey()),
      fee: opts.fee ?? 100 * Math.max(1, ops.length),
      seqNum: xdr.Int64(seq),
      cond: xdr.Preconditions.precondNone(),
      memo: xdr.Memo.memoNone(),
      operations: ops,
      ext: xdr.TransactionExt.v0(),
    });
    const payload = new xdr.TransactionSignaturePayload({
      networkId: this.lm.networkId,
      taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(tx),
    });
    const hash = sha256(payload.toXdr());
    const signatures = (opts.signers ?? [source]).map((kp) => kp.signDecorated(hash));
    return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({ tx, signatures })).toXdr('base64');
  }

  /** Close the next ledger with these envelopes (in any order). */
  close(envelopes: string[], dt = 5): LedgerCloseResult {
    const lcl = this.lm.lastClosed();
    const txSet = this.lm.makeTxSet(lcl.hash, envelopes);
    this.closeTime += dt;
    const value = makeSignedStellarValue(this.lm.networkId, this.node, txSet.hash, this.closeTime);
    return this.lm.closeLedger(txSet, value);
  }

  /** Close a ledger with one transaction and return its result. */
  apply(envelope: string, dt = 5): TxApplyResult {
    const r = this.close([envelope], dt);
    return r.results[0];
  }

  /** True when the root account can sign (a genesis with the unlockRoot test option). */
  rootCanSign(): boolean {
    return (this.lm.getAccount(this.root.publicKey())?.thresholds.master ?? 0) > 0;
  }

  /**
   * Create and fund accounts in one ledger. A root that can sign pays exactly
   * `amount` to each, in one transaction. A locked root cannot, so the
   * friendbot channels pay, as the channel policy allows: a CreateAccount of
   * FRIENDBOT_AMOUNT per account, then Payments of FRIENDBOT_AMOUNT until the
   * account holds at least `amount`.
   */
  fund(accounts: (Keypair | string)[], amount = 1000n * XLM): LedgerCloseResult {
    const ids = accounts.map((a) => (typeof a === 'string' ? a : a.publicKey()));
    const envs = this.rootCanSign()
      ? [this.tx(this.root, ids.map((destination) => Operation.createAccount({ destination, startingBalance: stroopsToString(amount) })))]
      : this.channelFunding(ids, amount);
    const r = this.close(envs);
    const failed = r.results.find((x) => !x.successful);
    if (failed) throw new Error(`fund failed: ${failed.resultCode}`);
    return r;
  }

  /** Friendbot channel transactions that create `ids` with at least `amount` each (see fund). */
  private channelFunding(ids: string[], amount: bigint): string[] {
    const units = amount > FRIENDBOT_AMOUNT ? (amount + FRIENDBOT_AMOUNT - 1n) / FRIENDBOT_AMOUNT : 1n;
    const fb = stroopsToString(FRIENDBOT_AMOUNT);
    const nextSeq = new Map<Keypair, bigint>();
    const envs: string[] = [];
    ids.forEach((destination, i) => {
      // One channel per account, so its create comes before its payments.
      const ch = this.channels[i % this.channels.length];
      for (let k = 0n; k < units; k++) {
        const seq = nextSeq.get(ch) ?? this.seqOf(ch.publicKey()) + 1n;
        nextSeq.set(ch, seq + 1n);
        const op =
          k === 0n
            ? Operation.createAccount({ destination, startingBalance: fb })
            : Operation.payment({ destination, asset: Asset.native(), amount: fb });
        envs.push(this.tx(ch, [op], { seq }));
      }
    });
    return envs;
  }
}

/**
 * A copy of an operation with another body. SDK XDR values are immutable, so
 * tests build malformed operations from a copy instead of setting fields.
 */
export function withBody(op: xdr.Operation, body: xdr.OperationBody): xdr.Operation {
  return new xdr.Operation({ sourceAccount: op.sourceAccount, body });
}

/** The inner result (OperationResultTr) of operation `i` of a base64 TransactionResult. */
export function opResultTr(resultXdr: string, i = 0): xdr.OperationResultTr {
  const res = xdr.TransactionResult.fromXdr(resultXdr, 'base64').result;
  if (res.type !== 'txSuccess' && res.type !== 'txFailed') throw new Error(`no operation results (${res.type})`);
  return xdr.expectUnionVariant(res.results[i], 'opInner').tr;
}

/** Account flag bits typed for the SDK's SetOptions (which only types single flags). */
export function af(flags: number): AuthFlag {
  return flags as AuthFlag;
}

/** Stroops -> SDK amount string ("12.3456789"). */
export function stroopsToString(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = `${a / XLM}.${(a % XLM).toString().padStart(7, '0')}`;
  return neg ? `-${s}` : s;
}

/** A ledger whose state is exactly `entries` (plus a fresh header), for edge-case tests. */
export function customLedger(entries: LedgerEntry[], passphrase = TEST_PASSPHRASE, tweak?: (h: LedgerHeader) => void): LedgerManager {
  const header = genesisHeader(passphrase);
  tweak?.(header);
  header.bucketListHash = computeStateHash(entries);
  const headerXdr = encodeLedgerHeader(header);
  return loadLedgerFromSnapshot({
    version: 1,
    networkPassphrase: passphrase,
    seq: header.ledgerSeq,
    hash: hashLedgerHeader(decodeLedgerHeader(headerXdr)),
    headerXdr,
    entries: entries.map(serializeEntry),
  });
}

export { newAccountEntry };
