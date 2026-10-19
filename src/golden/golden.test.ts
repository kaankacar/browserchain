// Golden vectors: consensus-critical bytes (StrKeys, transaction envelopes and
// hashes, ledger close outputs, StellarValue and SCP signatures, SCP hashing,
// overlay messages, a deterministic simulation) frozen in vectors.json, so a
// refactor (for example the move from @stellar/stellar-base to the '/base'
// subpath of @stellar/stellar-sdk) cannot change them silently.
//
// Compare:     npx vitest run src/golden
// Regenerate:  GOLDEN_UPDATE=1 npx vitest run src/golden
//
// Regenerating rewrites vectors.json and prints what changed. Do it only for
// an intended protocol change, and review the printed diff first. Record each
// regeneration in CHANGES.md (next to this file).
// All inputs are fixed here: keys come from node:crypto SHA-256 of labels, not
// from test kits or src/lib, so a change in the code under test cannot move them.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Memo,
  MuxedAccount,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
  type AuthFlag,
  type Transaction,
} from '@stellar/stellar-sdk/base';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fromBase64, fromHex, toHex, writeUint64BE } from '../lib/bytes';
import { APP_VERSION, CHECKPOINT_FREQUENCY, DEFAULT_NETWORK_NAME, networkPassphrase } from '../lib/constants';
import { networkIdOf, sha256Hex } from '../lib/hash';
import { seededRng } from '../lib/random';
import {
  canonicalJson as ledgerCanonicalJson,
  claimableBalanceId,
  createGenesisLedger,
  decodeLedgerHeader,
  decodeStellarValue,
  decodeTransaction,
  encodeLedgerHeader,
  encodeStellarValue,
  entryHash,
  friendbotKeypairs,
  fromXdrEnumName,
  genesisEntries,
  genesisHeader,
  hashLedgerHeader,
  hashLedgerHeaderXdr,
  loadLedgerFromSnapshot,
  makeSignedStellarValue,
  makeTxSet,
  rootKeypair,
  serializeEntry,
  signStellarValue,
  stellarValueSignaturePayload,
  verifyStellarValueSignature,
  type LedgerCloseResult,
  type LedgerManager,
  type LedgerSnapshot,
  type StellarValueInfo,
  type TxSetInfo,
} from '../ledger';
import { muxedToAddress, signerKeyToString } from '../ledger/xdrutil';
import { autoQuorumSet } from '../herder/quorumManager';
import { computeScpTimeout } from '../herder/scpDriver';
import { canonicalJson as overlayCanonicalJson } from '../overlay/canonicalJson';
import {
  makeDontHaveMessage,
  makeGetScpQuorumSetMessage,
  makeGetTxSetMessage,
  makeScpMessage,
  makeScpQuorumSetMessage,
  makeTransactionMessage,
  makeTxSetMessage,
  parseStellarMessage,
  type ParsedStellarMessage,
} from '../overlay/stellarMessage';
import type { NodeAnnouncement } from '../overlay/types';
import { announcementDigest, signAnnouncement, verifyAnnouncement } from '../overlay/wire';
import type { SCPDriver } from '../scp/driver';
import { computeHashNode as scpHashNode, computeValueHash as scpValueHash } from '../scp/hash';
import { getNodeWeight, normalizeQSet, qsetNodes } from '../scp/quorum';
import { SCP } from '../scp/scp';
import { TIMER_NOMINATION, ValidationLevel } from '../scp/types';
import type { Envelope, Hash, NodeId, QuorumSet, Statement, Value } from '../scp/types';
import {
  envelopeFromBase64,
  envelopeToBase64,
  hashQuorumSet,
  qsetFromXdr,
  qsetToBase64,
  signEnvelope as signScpEnvelope,
  statementSignaturePayload,
  verifyEnvelope,
} from '../scp/xdr';
import { SIM_NETWORK, Simulation } from '../sim/simulation';

// ---------------------------------------------------------------- JSON and the vectors file

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const VECTORS_PATH = fileURLToPath(new URL('./vectors.json', import.meta.url));
const UPDATE = process.env.GOLDEN_UPDATE === '1';
const REGENERATE = 'GOLDEN_UPDATE=1 npx vitest run src/golden';

/** Group order in vectors.json (the task numbering). */
const GROUPS = [
  'genesis',
  'strkey',
  'transactions',
  'ledgerClose',
  'stellarValue',
  'scp',
  'overlay',
  'simulation',
  'checkpoint',
] as const;
type Group = (typeof GROUPS)[number];

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function loadVectors(): JsonObject | null {
  if (!existsSync(VECTORS_PATH)) return null;
  const parsed = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Json;
  if (!isObject(parsed)) throw new Error(`${VECTORS_PATH} is not a JSON object`);
  return parsed;
}

const stored = loadVectors();
const fresh: Partial<Record<Group, Json>> = {};

function show(v: Json | undefined): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length <= 90 ? s : `${s.slice(0, 60)}…${s.slice(-20)} (${s.length} chars)`;
}

function stringDiff(path: string, exp: string, act: string): string {
  if (exp.length <= 90 && act.length <= 90) {
    return `${path}\n      expected ${JSON.stringify(exp)}\n      actual   ${JSON.stringify(act)}`;
  }
  let i = 0;
  while (i < exp.length && i < act.length && exp[i] === act[i]) i++;
  const from = Math.max(0, i - 24);
  const window = (s: string) => `${from > 0 ? '…' : ''}${s.slice(from, i + 40)}${s.length > i + 40 ? '…' : ''}`;
  return (
    `${path}: first difference at char ${i} (lengths ${exp.length} and ${act.length})\n` +
    `      expected ${window(exp)}\n      actual   ${window(act)}`
  );
}

/** Path-by-path differences between the stored and the fresh vectors. */
function diffJson(exp: Json | undefined, act: Json | undefined, path: string, out: string[]): void {
  if (isObject(exp) && isObject(act)) {
    for (const k of Object.keys(exp)) diffJson(exp[k], act[k], `${path}.${k}`, out);
    for (const k of Object.keys(act)) if (!(k in exp)) diffJson(undefined, act[k], `${path}.${k}`, out);
    return;
  }
  if (Array.isArray(exp) && Array.isArray(act)) {
    if (exp.length !== act.length) out.push(`${path}: array length ${exp.length} became ${act.length}`);
    for (let i = 0; i < Math.max(exp.length, act.length); i++) diffJson(exp[i], act[i], `${path}[${i}]`, out);
    return;
  }
  if (exp === act) return;
  if (exp === undefined) out.push(`${path}: new value ${show(act)}`);
  else if (act === undefined) out.push(`${path}: missing now (was ${show(exp)})`);
  else if (typeof exp === 'string' && typeof act === 'string') out.push(stringDiff(path, exp, act));
  else out.push(`${path}\n      expected ${show(exp)}\n      actual   ${show(act)}`);
}

function formatDiffs(group: Group, diffs: string[]): string {
  const shown = diffs.slice(0, 40).map((d) => `  - ${d}`);
  if (diffs.length > shown.length) shown.push(`  ... and ${diffs.length - shown.length} more`);
  return `golden vectors "${group}": ${diffs.length} difference(s)\n${shown.join('\n')}`;
}

/** Compare a group with vectors.json, or record it when GOLDEN_UPDATE=1. */
function check(group: Group, value: JsonObject): void {
  // A JSON round trip rejects bigint and drops undefined, like the file does.
  const actual = JSON.parse(JSON.stringify(value)) as Json;
  fresh[group] = actual;
  const expected = stored?.[group];
  const diffs: string[] = [];
  if (expected === undefined) diffs.push(`${group}: not in vectors.json yet`);
  else diffJson(expected, actual, group, diffs);
  if (UPDATE) {
    if (diffs.length > 0) console.log(`${formatDiffs(group, diffs)}\n(vectors.json will be rewritten)`);
    return;
  }
  if (diffs.length > 0) {
    throw new Error(`${formatDiffs(group, diffs)}\nIf this change is intended, regenerate with: ${REGENERATE}`);
  }
}

afterAll(() => {
  if (!UPDATE) return;
  const merged: JsonObject = {
    _about: `Generated by src/golden/golden.test.ts. Do not edit by hand. Regenerate: ${REGENERATE}`,
  };
  for (const g of GROUPS) {
    const v = fresh[g] ?? stored?.[g];
    if (v !== undefined) merged[g] = v;
  }
  writeFileSync(VECTORS_PATH, `${JSON.stringify(merged, null, 2)}\n`);
});

// ---------------------------------------------------------------- fixed inputs

/** 32 bytes for a label: SHA-256 from node:crypto, independent of the code under test. */
function seed(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`browserchain-golden|${label}`).digest());
}

/** The same 32 bytes as seed(label), as lowercase hex (also straight from node:crypto). */
function seedHex(label: string): string {
  return createHash('sha256').update(`browserchain-golden|${label}`).digest('hex');
}

function key(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(seed(label));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Account flag bits typed for the SDK (which only types single flags). */
function authFlags(bits: number): AuthFlag {
  return bits as AuthFlag;
}

const MAIN = networkPassphrase(DEFAULT_NETWORK_NAME);
const MAIN_ID = networkIdOf(MAIN);
/** Close time of ledger `seq` in the ledger-close scenario. */
const closeTimeOf = (seq: number): number => 1_790_000_000 + 5 * (seq - 1);

interface TxSpec {
  source: Keypair;
  /** Sequence number of the transaction. */
  seq: bigint;
  ops: xdr.Operation[];
  memo?: Memo;
  timebounds?: { minTime: number; maxTime: number };
  ledgerbounds?: { minLedger: number; maxLedger: number };
  /** Default: the source key. */
  signers?: Keypair[];
  /** Hash-x preimages added as signatures. */
  hashX?: Uint8Array[];
  /** Muxed id of the source (M... address). */
  muxedId?: string;
  /** Fee per operation. Default 100. */
  fee?: number;
}

function buildTx(passphrase: string, s: TxSpec): Transaction {
  const base = new Account(s.source.publicKey(), (s.seq - 1n).toString());
  const source = s.muxedId !== undefined ? new MuxedAccount(base, s.muxedId) : base;
  const b = new TransactionBuilder(source, {
    fee: String(s.fee ?? 100),
    networkPassphrase: passphrase,
    memo: s.memo,
    timebounds: s.timebounds ?? { minTime: 0, maxTime: 0 },
    ledgerbounds: s.ledgerbounds,
    // stellar-base 15 wrote minSeqNum = 0 into every V2 precondition (here:
    // ledger bounds). The stellar-sdk 17 builder leaves minSeqNum out unless
    // it is set. Set it, so the envelopes keep the bytes of the vectors.
    minAccountSequence: s.ledgerbounds ? '0' : undefined,
  });
  for (const op of s.ops) b.addOperation(op);
  const tx = b.build();
  for (const kp of s.signers ?? [s.source]) tx.sign(kp);
  for (const x of s.hashX ?? []) tx.signHashX(x);
  return tx;
}

function envelopeOf(passphrase: string, s: TxSpec): string {
  return buildTx(passphrase, s).toEnvelope().toXdr('base64');
}

/** Readable result code of each operation, decoded from a TransactionResult (base64). */
function opResultCodes(resultXdr: string): string[] {
  const res = xdr.TransactionResult.fromXdr(resultXdr, 'base64').result;
  if (res.type !== 'txSuccess' && res.type !== 'txFailed') return [];
  return res.results.map((op) => {
    if (op.type !== 'opInner') return fromXdrEnumName(op.type);
    return fromXdrEnumName(op.tr.value.type);
  });
}

// ---------------------------------------------------------------- 1. genesis

function genesisVectors(): JsonObject {
  const out: JsonObject = {};
  for (const name of [DEFAULT_NETWORK_NAME, 'test']) {
    const passphrase = networkPassphrase(name);
    const lm = createGenesisLedger(passphrase);
    const lcl = lm.lastClosed();
    // the codecs agree with the manager
    expect(encodeLedgerHeader(genesisHeader(passphrase))).toBe(lcl.headerXdr);
    expect(hashLedgerHeaderXdr(lcl.headerXdr)).toBe(lcl.hash);
    expect(lm.stateHash()).toBe(lcl.header.bucketListHash);
    const rootEntry = genesisEntries(passphrase)[0];
    // the root key is public: the root is locked (master weight 0, no signers)
    expect(rootEntry.thresholds.master).toBe(0);
    expect(rootEntry.signers).toEqual([]);
    out[name] = {
      passphrase,
      networkId: toHex(networkIdOf(passphrase)),
      root: rootKeypair(passphrase).publicKey(),
      friendbotChannels: friendbotKeypairs(passphrase).map((k) => k.publicKey()),
      rootEntryJson: ledgerCanonicalJson(serializeEntry(rootEntry)),
      rootEntryHash: toHex(entryHash(rootEntry)),
      headerXdr: lcl.headerXdr,
      headerHash: lcl.hash,
      stateHash: lcl.header.bucketListHash,
    };
  }
  return out;
}

// ---------------------------------------------------------------- 2. StrKey

function strkeyVectors(): JsonObject {
  const inputs: [string, Uint8Array][] = [
    ['zero', new Uint8Array(32)],
    ['ff', new Uint8Array(32).fill(0xff)],
    ['seeded', seed('strkey')],
  ];
  const out: JsonObject = {};
  for (const [name, raw] of inputs) {
    const G = StrKey.encodeEd25519PublicKey(raw);
    const S = StrKey.encodeEd25519SecretSeed(raw);
    const T = StrKey.encodePreAuthTx(raw);
    const X = StrKey.encodeSha256Hash(raw);
    expect(toHex(StrKey.decodeEd25519PublicKey(G))).toBe(toHex(raw));
    expect(toHex(StrKey.decodeEd25519SecretSeed(S))).toBe(toHex(raw));
    expect(toHex(StrKey.decodePreAuthTx(T))).toBe(toHex(raw));
    expect(toHex(StrKey.decodeSha256Hash(X))).toBe(toHex(raw));
    // the ledger stores signers with these strings (they enter the state hash)
    expect(signerKeyToString(xdr.SignerKey.signerKeyTypeEd25519(raw))).toBe(G);
    expect(signerKeyToString(xdr.SignerKey.signerKeyTypePreAuthTx(raw))).toBe(T);
    expect(signerKeyToString(xdr.SignerKey.signerKeyTypeHashX(raw))).toBe(X);
    const kp = Keypair.fromRawEd25519Seed(raw);
    expect(kp.secret()).toBe(S);
    out[name] = { raw: toHex(raw), G, S, T, X, publicKeyOfSeed: kp.publicKey() };
  }
  const raw = seed('strkey');
  const G = StrKey.encodeEd25519PublicKey(raw);
  const muxed: JsonObject = {};
  for (const id of ['0', '1', '1234567890', '18446744073709551615']) {
    const m = xdr.MuxedAccount.keyTypeMuxedEd25519(
      new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString(id), ed25519: raw }),
    );
    const address = muxedToAddress(m);
    expect(StrKey.encodeMed25519PublicKey(Uint8Array.of(...raw, ...writeUint64BE(BigInt(id))))).toBe(address);
    expect(new MuxedAccount(new Account(G, '0'), id).accountId()).toBe(address);
    muxed[id] = address;
  }
  out.muxedOfSeeded = muxed;
  return out;
}

// ---------------------------------------------------------------- 3. transactions

const TX_SEQ = 123_456_789_012_346n;

function txRecord(tx: Transaction): JsonObject {
  const env = tx.toEnvelope().toXdr('base64');
  const d = decodeTransaction(env, MAIN_ID);
  // the SDK and the ledger agree on the transaction hash
  expect(toHex(tx.hash())).toBe(d.hashHex);
  expect(xdr.TransactionEnvelope.fromXdr(env, 'base64').toXdr('base64')).toBe(env);
  return {
    xdr: env,
    hash: d.hashHex,
    envelopeHash: d.fullHashHex,
    ops: d.ops.map((o) => o.type),
    signatures: d.signatures.map((s) => ({ hint: toHex(s.hint), signature: toHex(s.signature) })),
  };
}

function transactionVectors(): JsonObject {
  const src = key('tx-source');
  const dst = key('tx-dest');
  const issuer = key('tx-issuer');
  const cosigner = key('tx-cosigner');
  const usd = new Asset('USD', issuer.publicKey());
  const long = new Asset('GOLDENASSET1', issuer.publicKey());
  const xlm = Asset.native();
  const preimage = seed('tx-hashx-preimage');
  const preAuthHash = seed('tx-preauth');
  const balanceId = claimableBalanceId(src.publicKey(), TX_SEQ, 0);
  const balanceIdXdr = `00000000${balanceId}`;
  const muxedDest = new MuxedAccount(new Account(dst.publicKey(), '0'), '7').accountId();
  const pay = (): xdr.Operation => Operation.payment({ destination: dst.publicKey(), asset: xlm, amount: '1' });
  const bounds = { minTime: 1_790_000_000, maxTime: 1_790_003_600 };

  const cases: [string, Partial<TxSpec> & { ops: xdr.Operation[] }][] = [
    // one envelope per supported operation type (and a few variants)
    ['createAccount', { ops: [Operation.createAccount({ destination: dst.publicKey(), startingBalance: '100.5' })] }],
    ['payment', { ops: [Operation.payment({ destination: dst.publicKey(), asset: xlm, amount: '12.3456789' })] }],
    ['paymentCredit', { ops: [Operation.payment({ destination: dst.publicKey(), asset: usd, amount: '1000' })] }],
    [
      'pathPaymentStrictReceive',
      {
        ops: [
          Operation.pathPaymentStrictReceive({
            sendAsset: xlm,
            sendMax: '50',
            destination: dst.publicKey(),
            destAsset: usd,
            destAmount: '10',
            path: [long],
          }),
        ],
      },
    ],
    [
      'pathPaymentStrictSend',
      {
        ops: [
          Operation.pathPaymentStrictSend({
            sendAsset: usd,
            sendAmount: '10',
            destination: dst.publicKey(),
            destAsset: xlm,
            destMin: '1.5',
            path: [long],
          }),
        ],
      },
    ],
    [
      'manageSellOffer',
      { ops: [Operation.manageSellOffer({ selling: usd, buying: xlm, amount: '100', price: { n: 3, d: 7 } })] },
    ],
    [
      'manageSellOfferDelete',
      { ops: [Operation.manageSellOffer({ selling: usd, buying: xlm, amount: '0', price: { n: 1, d: 1 }, offerId: '42' })] },
    ],
    [
      'manageBuyOffer',
      {
        ops: [
          Operation.manageBuyOffer({ selling: xlm, buying: usd, buyAmount: '25', price: { n: 7, d: 3 }, offerId: '9' }),
        ],
      },
    ],
    [
      'createPassiveSellOffer',
      { ops: [Operation.createPassiveSellOffer({ selling: long, buying: usd, amount: '5', price: { n: 1, d: 1 } })] },
    ],
    [
      'setOptions',
      {
        ops: [
          Operation.setOptions({
            inflationDest: dst.publicKey(),
            clearFlags: authFlags(1),
            setFlags: authFlags(2 | 8),
            masterWeight: 10,
            lowThreshold: 1,
            medThreshold: 2,
            highThreshold: 3,
            homeDomain: 'golden.example',
            signer: { ed25519PublicKey: cosigner.publicKey(), weight: 5 },
          }),
        ],
      },
    ],
    ['setOptionsPreAuthSigner', { ops: [Operation.setOptions({ signer: { preAuthTx: preAuthHash, weight: 1 } })] }],
    [
      'setOptionsHashXSigner',
      { ops: [Operation.setOptions({ signer: { sha256Hash: new Uint8Array(createHash('sha256').update(preimage).digest()), weight: 2 } })] },
    ],
    [
      'setOptionsRemoveSigner',
      { ops: [Operation.setOptions({ signer: { ed25519PublicKey: cosigner.publicKey(), weight: 0 } })] },
    ],
    ['changeTrust', { ops: [Operation.changeTrust({ asset: usd, limit: '1000000' })] }],
    ['changeTrustAlphanum12', { ops: [Operation.changeTrust({ asset: long })] }],
    [
      'allowTrust',
      { source: issuer, ops: [Operation.allowTrust({ trustor: dst.publicKey(), assetCode: 'USD', authorize: 1 })] },
    ],
    [
      'allowTrustMaintainLiabilities',
      { source: issuer, ops: [Operation.allowTrust({ trustor: dst.publicKey(), assetCode: 'GOLDENASSET1', authorize: 2 })] },
    ],
    [
      'setTrustLineFlags',
      {
        source: issuer,
        ops: [
          Operation.setTrustLineFlags({
            trustor: dst.publicKey(),
            asset: usd,
            flags: { authorized: false, authorizedToMaintainLiabilities: true, clawbackEnabled: false },
          }),
        ],
      },
    ],
    ['accountMerge', { ops: [Operation.accountMerge({ destination: dst.publicKey() })] }],
    ['manageData', { ops: [Operation.manageData({ name: 'golden', value: 'golden value' })] }],
    ['manageDataDelete', { ops: [Operation.manageData({ name: 'golden', value: null })] }],
    ['bumpSequence', { ops: [Operation.bumpSequence({ bumpTo: '123456789099999' })] }],
    [
      'createClaimableBalance',
      {
        ops: [
          Operation.createClaimableBalance({
            asset: usd,
            amount: '10',
            claimants: [
              new Claimant(dst.publicKey(), Claimant.predicateUnconditional()),
              new Claimant(
                cosigner.publicKey(),
                Claimant.predicateAnd(
                  Claimant.predicateNot(Claimant.predicateBeforeRelativeTime('3600')),
                  Claimant.predicateOr(
                    Claimant.predicateBeforeAbsoluteTime('1790086400'),
                    Claimant.predicateUnconditional(),
                  ),
                ),
              ),
            ],
          }),
        ],
      },
    ],
    ['claimClaimableBalance', { ops: [Operation.claimClaimableBalance({ balanceId: balanceIdXdr })] }],
    ['clawbackClaimableBalance', { source: issuer, ops: [Operation.clawbackClaimableBalance({ balanceId: balanceIdXdr })] }],
    ['clawback', { source: issuer, ops: [Operation.clawback({ asset: usd, amount: '3', from: dst.publicKey() })] }],
    // every memo type
    ['memoNone', { memo: Memo.none(), ops: [pay()] }],
    ['memoText', { memo: Memo.text('golden memo'), ops: [pay()] }],
    ['memoId', { memo: Memo.id('18446744073709551615'), ops: [pay()] }],
    ['memoHash', { memo: Memo.hash(seedHex('memo-hash')), ops: [pay()] }],
    ['memoReturn', { memo: Memo.return(seedHex('memo-return')), ops: [pay()] }],
    // preconditions
    ['timeBounds', { timebounds: bounds, ops: [pay()] }],
    ['ledgerBounds', { ledgerbounds: { minLedger: 5, maxLedger: 100 }, ops: [pay()] }],
    ['timeAndLedgerBounds', { timebounds: bounds, ledgerbounds: { minLedger: 0, maxLedger: 7 }, ops: [pay()] }],
    // muxed accounts, operation sources and several signatures
    [
      'muxedAccounts',
      { muxedId: '42', ops: [Operation.payment({ destination: muxedDest, asset: xlm, amount: '1' })] },
    ],
    [
      'operationSource',
      {
        signers: [src, issuer],
        ops: [Operation.payment({ source: issuer.publicKey(), destination: dst.publicKey(), asset: usd, amount: '2' })],
      },
    ],
    [
      'multiSignature',
      { signers: [src, cosigner], hashX: [preimage], fee: 250, ops: [pay(), Operation.bumpSequence({ bumpTo: '0' })] },
    ],
  ];

  const envelopes: JsonObject = {};
  for (const [name, c] of cases) {
    const source = c.source ?? src;
    const tx = buildTx(MAIN, { ...c, source, seq: TX_SEQ });
    // every ed25519 signature checks out against the transaction hash
    for (const s of tx.signatures) {
      const signer = [src, issuer, cosigner].find((k) => toHex(k.signatureHint()) === toHex(s.hint.toBytes()));
      if (signer) expect(signer.verify(tx.hash(), s.signature.toBytes())).toBe(true);
    }
    envelopes[name] = txRecord(tx);
  }
  return {
    network: MAIN,
    seqNum: TX_SEQ.toString(),
    keys: {
      source: src.publicKey(),
      dest: dst.publicKey(),
      issuer: issuer.publicKey(),
      cosigner: cosigner.publicKey(),
      muxedDest,
    },
    claimableBalanceId: balanceId,
    envelopes,
  };
}

// ---------------------------------------------------------------- 4. ledger close

function closeRecord(label: string, r: LedgerCloseResult): JsonObject {
  return {
    label,
    seq: r.header.ledgerSeq,
    closeTime: r.header.scpValue.closeTime,
    txSetHash: r.txSet.hash,
    txSetXdr: r.txSet.xdr,
    // canonical order: SHA-256 of each envelope, ascending
    txSetOrder: r.txSet.txs.map((t) => sha256Hex(fromBase64(t))),
    // transaction hashes in apply order
    applyOrder: r.results.map((x) => x.hash),
    results: r.results.map((x) => ({
      hash: x.hash,
      code: x.resultCode,
      ops: opResultCodes(x.resultXdr),
      feeCharged: x.feeCharged.toString(),
      xdr: x.resultXdr,
    })),
    txSetResultHash: r.header.txSetResultHash,
    headerXdr: r.headerXdr,
    headerHash: r.hash,
    stateHash: r.header.bucketListHash,
  };
}

interface Closer {
  lm: LedgerManager;
  node: Keypair;
}

/** Make the canonical tx set for LCL+1, check it like a validator would, sign the value. */
function prepareClose(c: Closer, envelopes: string[]): { txSet: TxSetInfo; value: StellarValueInfo } {
  const lcl = c.lm.lastClosed();
  const txSet = c.lm.makeTxSet(lcl.hash, envelopes);
  expect(txSet.txs.length).toBe(envelopes.length);
  const closeTime = closeTimeOf(lcl.header.ledgerSeq + 1);
  expect(c.lm.checkTxSetValid(txSet, closeTime)).toEqual({ valid: true });
  return { txSet, value: makeSignedStellarValue(c.lm.networkId, c.node, txSet.hash, closeTime) };
}

function ledgerCloseVectors(): JsonObject {
  const lm = createGenesisLedger(MAIN);
  const c: Closer = { lm, node: key('ledger-node') };
  const root = rootKeypair(MAIN);
  const channels = friendbotKeypairs(MAIN);
  // FRIENDBOT_AMOUNT: the channel policy allows only CreateAccount or a native
  // Payment of this amount, one operation per transaction.
  const FRIENDBOT = '10000';
  const k = {
    issuer: key('ledger-issuer'),
    maker: key('ledger-maker'),
    alice: key('ledger-alice'),
    bob: key('ledger-bob'),
    carol: key('ledger-carol'),
    dave: key('ledger-dave'),
    cosigner: key('ledger-cosigner'),
  };
  const usd = new Asset('USD', k.issuer.publicKey());
  const eur = new Asset('EUR', k.issuer.publicKey());
  const xlm = Asset.native();
  const id = (kp: Keypair) => kp.publicKey();
  const seqOf = (kp: Keypair) => lm.getAccount(id(kp))!.seqNum;
  const tx = (kp: Keypair, ops: xdr.Operation[], opts: Partial<TxSpec> & { next?: bigint } = {}) =>
    envelopeOf(MAIN, { ...opts, source: kp, seq: seqOf(kp) + 1n + (opts.next ?? 0n), ops });
  const create = (kp: Keypair, xlmAmount: string) =>
    Operation.createAccount({ destination: id(kp), startingBalance: xlmAmount });
  const pay = (to: Keypair, asset: Asset, amount: string) => Operation.payment({ destination: id(to), asset, amount });
  const trust = (asset: Asset, limit?: string) => Operation.changeTrust({ asset, limit });
  const sell = (selling: Asset, buying: Asset, amount: string, n: number, d: number) =>
    Operation.manageSellOffer({ selling, buying, amount, price: { n, d } });

  const ledgers: JsonObject[] = [];
  const close = (label: string, envelopes: string[]): LedgerCloseResult => {
    const { txSet, value } = prepareClose(c, envelopes);
    const r = lm.closeLedger(txSet, value);
    ledgers.push(closeRecord(label, r));
    return r;
  };
  const failures = (r: LedgerCloseResult) =>
    r.results.filter((x) => !x.successful).map((x) => `${x.hash} ${x.resultCode}`);

  // Ledger 2, closed on genesis: the root is locked, so the friendbot
  // channels create the accounts; one channel pays the root.
  const l2 = close('create accounts', [
    tx(channels[0], [create(k.issuer, FRIENDBOT)], { memo: Memo.text('golden') }),
    tx(channels[1], [create(k.maker, FRIENDBOT)]),
    tx(channels[2], [create(k.alice, FRIENDBOT)]),
    tx(channels[3], [create(k.bob, FRIENDBOT)]),
    tx(channels[4], [create(k.carol, FRIENDBOT)]),
    tx(channels[5], [pay(root, xlm, FRIENDBOT)]),
  ]);
  expect(failures(l2)).toEqual([]);

  // Ledger 3: trustlines and issuer options (a signer).
  const l3 = close('trustlines and issuer options', [
    tx(k.issuer, [
      Operation.setOptions({
        homeDomain: 'golden.example',
        masterWeight: 2,
        lowThreshold: 1,
        medThreshold: 1,
        highThreshold: 2,
        signer: { ed25519PublicKey: id(k.cosigner), weight: 1 },
      }),
    ]),
    tx(k.maker, [trust(usd), trust(eur)]),
    tx(k.alice, [trust(usd), trust(eur)]),
    tx(k.bob, [trust(usd, '5000')]),
    tx(k.carol, [trust(eur)]),
  ]);
  expect(failures(l3)).toEqual([]);

  // Ledger 4: issuance, data entry and a sequence bump.
  const l4 = close('issue assets', [
    tx(k.issuer, [
      pay(k.maker, usd, '3000'),
      pay(k.maker, eur, '3000'),
      pay(k.alice, usd, '1000'),
      pay(k.carol, eur, '500'),
    ]),
    tx(k.bob, [
      Operation.manageData({ name: 'golden', value: 'ledger' }),
      Operation.bumpSequence({ bumpTo: (seqOf(k.bob) + 101n).toString() }),
    ]),
  ]);
  expect(failures(l4)).toEqual([]);

  // Ledger 5: the order book (two offers at one price) and a claimable balance.
  const l5 = close('order book and claimable balance', [
    tx(k.maker, [sell(usd, xlm, '1000', 2, 1), sell(eur, usd, '1000', 11, 10), sell(eur, usd, '200', 11, 10)]),
    tx(k.carol, [Operation.createPassiveSellOffer({ selling: eur, buying: xlm, amount: '100', price: { n: 3, d: 1 } })]),
    tx(
      k.carol,
      [
        Operation.createClaimableBalance({
          asset: eur,
          amount: '50',
          claimants: [
            new Claimant(id(k.alice), Claimant.predicateUnconditional()),
            new Claimant(
              id(k.bob),
              Claimant.predicateAnd(
                Claimant.predicateBeforeAbsoluteTime('1790010000'),
                Claimant.predicateNot(Claimant.predicateBeforeRelativeTime('10')),
              ),
            ),
          ],
        }),
      ],
      { next: 1n },
    ),
  ]);
  expect(failures(l5)).toEqual([]);
  const [cb] = lm.getClaimableBalances({ claimant: id(k.alice) });
  expect(cb.balanceId).toBe(claimableBalanceId(id(k.carol), seqOf(k.carol), 0));

  // Ledger 6: the fixed tx set. Payments, account creation, a trustline,
  // offers that cross, a path payment, claimable balances, a failed payment,
  // time and ledger bounds, and two accounts with two transactions each.
  const ct6 = closeTimeOf(6);
  const main = [
    tx(k.alice, [sell(usd, eur, '110', 9, 10)]),
    tx(k.alice, [Operation.claimClaimableBalance({ balanceId: `00000000${cb.balanceId}` })], { next: 1n }),
    tx(k.bob, [
      Operation.pathPaymentStrictReceive({
        sendAsset: xlm,
        sendMax: '500',
        destination: id(k.alice),
        destAsset: eur,
        destAmount: '50',
        path: [usd],
      }),
    ]),
    tx(k.bob, [pay(k.carol, xlm, '1000000')], { next: 1n }),
    tx(k.carol, [
      trust(usd, '777'),
      Operation.createClaimableBalance({
        asset: xlm,
        amount: '100',
        claimants: [new Claimant(id(k.dave), Claimant.predicateUnconditional())],
      }),
    ]),
    tx(
      k.issuer,
      [create(k.dave, '100'), pay(k.maker, xlm, '1000'), Operation.manageData({ name: 'golden', value: 'issuer' })],
      { memo: Memo.id('20261016') },
    ),
    tx(k.maker, [Operation.manageBuyOffer({ selling: xlm, buying: eur, buyAmount: '20', price: { n: 2, d: 1 } })], {
      timebounds: { minTime: ct6 - 60, maxTime: ct6 + 60 },
      ledgerbounds: { minLedger: 6, maxLedger: 7 },
    }),
  ];
  const failedPayment = decodeTransaction(main[3], MAIN_ID).hashHex;

  // Iteration order must not matter: the same close on copies of the state
  // loaded with entries in sorted and in reversed key order.
  const snap = lm.snapshot();
  const copies = [
    loadLedgerFromSnapshot(snap, MAIN),
    loadLedgerFromSnapshot({ ...snap, entries: [...snap.entries].reverse() }, MAIN),
  ];
  const { txSet, value } = prepareClose(c, main);
  const l6 = lm.closeLedger(txSet, value);
  ledgers.push(closeRecord('fixed tx set', l6));
  for (const copy of copies) {
    const r = copy.closeLedger(txSet, value);
    expect(r.hash).toBe(l6.hash);
    expect(r.resultSetXdr).toBe(l6.resultSetXdr);
    expect(copy.stateHash()).toBe(lm.stateHash());
  }
  expect(failures(l6)).toEqual([`${failedPayment} txFAILED`]);
  // the offers crossed: alice's offer is filled, she holds 100 + 50 + 50 EUR
  expect(lm.getOffersByAccount(id(k.alice))).toEqual([]);
  const aliceEur = lm.getTrustLines(id(k.alice)).find((t) => t.asset.code === 'EUR');
  expect(aliceEur?.balance).toBe(200n * 10_000_000n);

  return {
    network: MAIN,
    nodeKey: c.node.publicKey(),
    accounts: Object.fromEntries(Object.entries(k).map(([name, kp]) => [name, id(kp)])),
    ledgers,
  };
}

// ---------------------------------------------------------------- 5. StellarValue

function stellarValueVectors(): JsonObject {
  const kp = key('value-node');
  const txSetHash = toHex(seed('value-txset'));
  const closeTime = 1_790_000_123;
  const payload = stellarValueSignaturePayload(MAIN_ID, txSetHash, closeTime);
  const sig = signStellarValue(MAIN_ID, kp, txSetHash, closeTime);
  const value = makeSignedStellarValue(MAIN_ID, kp, txSetHash, closeTime);
  const valueXdr = encodeStellarValue(value);
  expect(value.signature).toEqual(sig);
  expect(decodeStellarValue(valueXdr)).toEqual(value);
  expect(verifyStellarValueSignature(MAIN_ID, value)).toBe(true);
  return {
    networkId: toHex(MAIN_ID),
    nodeId: kp.publicKey(),
    txSetHash,
    closeTime,
    signaturePayload: toHex(payload),
    signature: sig.signature,
    valueXdr,
    basicValueXdr: encodeStellarValue({ txSetHash, closeTime, upgrades: [], signature: null }),
  };
}

// ---------------------------------------------------------------- 6. SCP

const SCP_NAMES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];

function scpKeys(): { kps: Keypair[]; ids: NodeId[]; name: (id: NodeId) => string } {
  const kps = SCP_NAMES.map((n) => key(`scp-${n}`));
  const ids = kps.map((kp) => kp.publicKey());
  return { kps, ids, name: (nodeId) => SCP_NAMES[ids.indexOf(nodeId)] };
}

/** A signed StellarValue of an SCP node (an SCP value is its XDR in hex). */
function scpValue(kp: Keypair, label: string, closeTime: number): Value {
  return encodeStellarValue(makeSignedStellarValue(MAIN_ID, kp, toHex(seed(label)), closeTime));
}

/** The value of ledger 1, used as the previous value of slot 2. */
const GENESIS_VALUE: Value = encodeStellarValue(genesisHeader(MAIN).scpValue);

/** Minimal SCP driver: real hashing and signatures, every value valid, timers fired by hand. */
class GoldenScpDriver implements SCPDriver {
  readonly qsets = new Map<Hash, QuorumSet>();
  readonly emitted: Envelope[] = [];
  private readonly timers = new Map<string, () => void>();

  constructor(private readonly kp: Keypair) {}

  signEnvelope(env: Envelope): void {
    signScpEnvelope(env, this.kp, MAIN_ID);
  }
  getQSet(hash: Hash): QuorumSet | null {
    return this.qsets.get(hash) ?? null;
  }
  emitEnvelope(env: Envelope): void {
    this.emitted.push(env);
  }
  validateValue(): ValidationLevel {
    return ValidationLevel.FullyValidated;
  }
  extractValidValue(_slotIndex: number, value: Value): Value | null {
    return value;
  }
  combineCandidates(_slotIndex: number, candidates: Value[]): Value | null {
    return candidates[0] ?? null;
  }
  computeHashNode(slotIndex: number, prev: Value, isPriority: boolean, roundNumber: number, nodeId: NodeId): bigint {
    return scpHashNode(slotIndex, prev, isPriority, roundNumber, nodeId);
  }
  computeValueHash(slotIndex: number, prev: Value, roundNumber: number, value: Value): bigint {
    return scpValueHash(slotIndex, prev, roundNumber, value);
  }
  computeTimeout(roundNumber: number): number {
    return computeScpTimeout(roundNumber);
  }
  setupTimer(slotIndex: number, timerId: number, _timeoutMs: number, cb: (() => void) | null): void {
    if (cb) this.timers.set(`${slotIndex}:${timerId}`, cb);
    else this.timers.delete(`${slotIndex}:${timerId}`);
  }
  stopTimer(slotIndex: number, timerId: number): void {
    this.timers.delete(`${slotIndex}:${timerId}`);
  }
  fire(slotIndex: number, timerId: number): void {
    const cb = this.timers.get(`${slotIndex}:${timerId}`);
    if (!cb) throw new Error(`no timer ${slotIndex}:${timerId}`);
    this.timers.delete(`${slotIndex}:${timerId}`);
    cb();
  }
}

function qsetRecord(q: QuorumSet): JsonObject {
  const norm = normalizeQSet(q);
  expect(qsetFromXdr(qsetToBase64(q))).toEqual(q);
  return {
    xdr: qsetToBase64(q),
    hash: hashQuorumSet(q),
    normalizedXdr: qsetToBase64(norm),
    normalizedHash: hashQuorumSet(norm),
  };
}

/** A signed SCP envelope of one statement. */
function signedEnvelope(kp: Keypair, statement: Statement): Envelope {
  const env: Envelope = { statement, signature: '' };
  signScpEnvelope(env, kp, MAIN_ID);
  return env;
}

function scpVectors(): JsonObject {
  const { kps, ids, name } = scpKeys();
  const [n0, n1, n2, n3, n4, n5] = ids;

  const flat: QuorumSet = { threshold: 2, validators: [n2, n0, n1], innerSets: [] };
  const nested: QuorumSet = {
    threshold: 2,
    validators: [n0],
    innerSets: [
      { threshold: 2, validators: [n3, n1, n2], innerSets: [] },
      { threshold: 1, validators: [n5, n4], innerSets: [] },
    ],
  };
  const auto = autoQuorumSet([n3, n0, n2, n1]);
  const qsets = { flat: qsetRecord(flat), nested: qsetRecord(nested), auto4: qsetRecord(auto) };

  // one signed envelope per pledge type
  const v1 = scpValue(kps[1], 'scp-txset-1', 1_790_000_005);
  const v2 = scpValue(kps[2], 'scp-txset-2', 1_790_000_006);
  const qh = hashQuorumSet(normalizeQSet(flat));
  const statements: [string, number, Statement][] = [
    [
      'nominate',
      0,
      { nodeId: n0, slotIndex: 2, pledges: { type: 'nominate', quorumSetHash: qh, votes: [v1, v2].sort(), accepted: [v1] } },
    ],
    [
      'prepare',
      1,
      {
        nodeId: n1,
        slotIndex: 2,
        pledges: {
          type: 'prepare',
          quorumSetHash: qh,
          ballot: { counter: 3, value: v2 },
          prepared: { counter: 2, value: v2 },
          preparedPrime: { counter: 1, value: v1 },
          nC: 1,
          nH: 2,
        },
      },
    ],
    [
      'prepareInitial',
      1,
      {
        nodeId: n1,
        slotIndex: 2,
        pledges: {
          type: 'prepare',
          quorumSetHash: qh,
          ballot: { counter: 1, value: v1 },
          prepared: null,
          preparedPrime: null,
          nC: 0,
          nH: 0,
        },
      },
    ],
    [
      'confirm',
      2,
      {
        nodeId: n2,
        slotIndex: 2,
        pledges: { type: 'confirm', ballot: { counter: 4, value: v2 }, nPrepared: 4, nCommit: 2, nH: 4, quorumSetHash: qh },
      },
    ],
    [
      'externalize',
      3,
      {
        nodeId: n3,
        slotIndex: 4_294_967_297,
        pledges: { type: 'externalize', commit: { counter: 2, value: v2 }, nH: 4, commitQuorumSetHash: qh },
      },
    ],
  ];
  const envelopes: JsonObject = {};
  for (const [label, signer, st] of statements) {
    const env = signedEnvelope(kps[signer], st);
    const b64 = envelopeToBase64(env);
    expect(verifyEnvelope(env, MAIN_ID)).toBe(true);
    expect(envelopeFromBase64(b64)).toEqual(env);
    envelopes[label] = {
      xdr: b64,
      signaturePayload: toHex(statementSignaturePayload(MAIN_ID, st)),
      signature: env.signature,
    };
  }

  // nomination hashes (SCPDriver::computeHashNode / computeValueHash defaults)
  const hashNode: JsonObject = {};
  for (const [slot, rounds] of [
    [2, [1, 2]],
    [4_294_967_297, [7]],
  ] as [number, number[]][]) {
    const bySlot: JsonObject = {};
    for (const round of rounds) {
      const byRound: JsonObject = {};
      for (const isPriority of [false, true]) {
        const byKind: JsonObject = {};
        for (const nodeId of [n0, n1, n2, n3]) {
          byKind[name(nodeId)] = scpHashNode(slot, GENESIS_VALUE, isPriority, round, nodeId).toString();
        }
        byRound[isPriority ? 'P' : 'N'] = byKind;
      }
      bySlot[`round${round}`] = byRound;
    }
    hashNode[`slot${slot}`] = bySlot;
  }
  const valueHash: JsonObject = {};
  for (const round of [1, 2]) {
    valueHash[`round${round}`] = {
      v1: scpValueHash(2, GENESIS_VALUE, round, v1).toString(),
      v2: scpValueHash(2, GENESIS_VALUE, round, v2).toString(),
    };
  }

  return {
    networkId: toHex(MAIN_ID),
    nodes: Object.fromEntries(ids.map((nodeId) => [name(nodeId), nodeId])),
    qsets,
    values: { v1, v2, previous: GENESIS_VALUE },
    envelopes,
    hashNode,
    valueHash,
    nomination: nominationVectors(kps, ids, name),
  };
}

/** Leader priorities and the leaders the real SCP picks for slot 2 of a 5-node quorum. */
function nominationVectors(kps: Keypair[], ids: NodeId[], name: (id: NodeId) => string): JsonObject {
  const slot = 2;
  const local = ids[0];
  const driver = new GoldenScpDriver(kps[0]);
  const scp = new SCP(driver, local, true, { threshold: 3, validators: ids.slice(0, 5), innerSets: [] });
  driver.qsets.set(scp.getLocalQuorumSetHash(), scp.getLocalQuorumSet());

  // NominationProtocol::getNodePriority over the quorum set without the local node
  const others = normalizeQSet(scp.getLocalQuorumSet(), local);
  const nodes = [local, ...qsetNodes(others)];
  const priorities: JsonObject = {};
  const topOfRound = new Map<number, NodeId[]>();
  for (const round of [1, 2, 3]) {
    const byNode: JsonObject = {};
    let top = 0n;
    let leaders: NodeId[] = [];
    for (const nodeId of nodes) {
      const weight = getNodeWeight(nodeId, others, nodeId === local);
      const neighborhood = scpHashNode(slot, GENESIS_VALUE, false, round, nodeId);
      const priority = weight > 0n && neighborhood <= weight ? scpHashNode(slot, GENESIS_VALUE, true, round, nodeId) : 0n;
      byNode[name(nodeId)] = {
        weight: weight.toString(),
        neighborhood: neighborhood.toString(),
        priority: priority.toString(),
      };
      if (priority > top) {
        top = priority;
        leaders = [nodeId];
      } else if (priority === top && priority > 0n) {
        leaders.push(nodeId);
      }
    }
    topOfRound.set(round, leaders);
    priorities[`round${round}`] = byNode;
  }

  // the real nomination protocol: nominate, then two nomination timeouts
  const value = scpValue(kps[0], 'scp-nominate-txset', 1_790_000_005);
  const rounds: JsonObject[] = [];
  const record = () => {
    const info = scp.getSlotInfo(slot)!;
    rounds.push({
      round: info.nomination.roundNumber,
      leaders: scp.getNominationLeaders(slot).map(name),
      votes: info.nomination.votes.length,
    });
  };
  scp.nominate(slot, value, GENESIS_VALUE);
  record();
  // the first round always elects someone (the local node passes its own
  // neighborhood check), so it ends in round 1 with the top priority node
  expect(scp.getSlotInfo(slot)!.nomination.roundNumber).toBe(1);
  expect(scp.getNominationLeaders(slot)).toEqual(topOfRound.get(1));
  for (let i = 0; i < 2; i++) {
    driver.fire(slot, TIMER_NOMINATION);
    record();
  }
  return {
    slot,
    local: name(local),
    quorumSetHash: scp.getLocalQuorumSetHash(),
    value,
    priorities,
    rounds,
    emitted: driver.emitted.map((env) => envelopeToBase64(env)),
  };
}

// ---------------------------------------------------------------- 7. overlay

function overlayVectors(): JsonObject {
  const kp = key('overlay-node');
  const ann: NodeAnnouncement = {
    nodeId: kp.publicKey(),
    name: 'golden-node',
    networkId: toHex(MAIN_ID),
    appVersion: APP_VERSION,
    lcl: { seq: 21, hash: toHex(seed('overlay-lcl')) },
    state: 'synced',
    validator: true,
    qsetHash: toHex(seed('overlay-qset')),
    quorumMode: 'auto',
    ts: 1_790_000_000_123,
  };
  const json = overlayCanonicalJson(ann);
  const digest = announcementDigest(ann);
  const signature = signAnnouncement(kp, ann);
  expect(toHex(digest)).toBe(sha256Hex(json));
  expect(verifyAnnouncement(ann, signature)).toBe(true);

  const { kps, ids } = scpKeys();
  const qset: QuorumSet = { threshold: 2, validators: ids.slice(0, 3), innerSets: [] };
  const qsetHash = hashQuorumSet(qset);
  const scpEnv = envelopeToBase64(
    signedEnvelope(kps[1], {
      nodeId: ids[1],
      slotIndex: 2,
      pledges: {
        type: 'prepare',
        quorumSetHash: qsetHash,
        ballot: { counter: 1, value: scpValue(kps[1], 'scp-txset-1', 1_790_000_005) },
        prepared: null,
        preparedPrime: null,
        nC: 0,
        nH: 0,
      },
    }),
  );
  const txEnv = envelopeOf(MAIN, {
    source: key('tx-source'),
    seq: TX_SEQ,
    ops: [Operation.payment({ destination: key('tx-dest').publicKey(), asset: Asset.native(), amount: '1' })],
  });
  const txSet = makeTxSet(createGenesisLedger(MAIN).lastClosed().hash, [txEnv]);
  const messages: JsonObject = {
    scpMessage: makeScpMessage(scpEnv),
    transaction: makeTransactionMessage(txEnv),
    txSet: makeTxSetMessage(txSet.xdr),
    getTxSet: makeGetTxSetMessage(txSet.hash),
    scpQuorumset: makeScpQuorumSetMessage(qsetToBase64(qset)),
    getScpQuorumset: makeGetScpQuorumSetMessage(qsetHash),
    dontHaveTxSet: makeDontHaveMessage('txSet', txSet.hash),
    dontHaveQuorumset: makeDontHaveMessage('scpQuorumset', qsetHash),
  };
  // they parse back to what went in
  const parsed = Object.fromEntries(Object.entries(messages).map(([k, m]) => [k, parseStellarMessage(m as string)]));
  expect(parsed.scpMessage).toMatchObject({ kind: 'scpMessage', envelopeXdr: scpEnv });
  expect(parsed.transaction).toMatchObject({ kind: 'transaction', envelopeXdr: txEnv });
  expect(parsed.txSet).toMatchObject({ kind: 'txSet', txSetXdr: txSet.xdr });
  expect(parsed.getTxSet).toEqual({ kind: 'getTxSet', hash: txSet.hash });
  expect(parsed.getScpQuorumset).toEqual({ kind: 'getScpQuorumset', hash: qsetHash });
  expect(parsed.dontHaveTxSet).toEqual({ kind: 'dontHave', itemType: 'txSet', hash: txSet.hash });
  expect(parsed.dontHaveQuorumset).toEqual({ kind: 'dontHave', itemType: 'scpQuorumset', hash: qsetHash });

  return {
    announcement: { canonicalJson: json, sha256: toHex(digest), signature },
    messages,
  };
}

// ---------------------------------------------------------------- 8 and 9. simulation
// These hashes depend on more than ledger rules: herder timing, the network
// RNG and the tx queue decide which ledger takes which transaction and its
// close time. On a diff, look at the first differing ledger: if its closeTime
// or txCount moved, timing changed; if only its hash moved, ledger bytes changed.

const SIM_SEED = 20_261_016;
const SIM_NODES = ['a', 'b', 'c', 'd'];
const SIM_LEDGERS = 21; // genesis + 20 closed ledgers

// A type alias (not an interface), so it is assignable to Json.
type SimLedger = { hash: string; closeTime: number; txCount: number };

interface SimRun {
  nodes: Record<string, string>;
  users: string[];
  submitted: string[];
  ledgers: Record<string, SimLedger>;
  snapshot: LedgerSnapshot | null;
}

/**
 * Four validators on a virtual clock: friendbot for four users, then eight
 * payments, each submitted at a fixed node. Runs until every node has closed
 * `untilSeq` and returns the agreed chain 1..untilSeq.
 */
async function runSimulation(untilSeq: number): Promise<SimRun> {
  const sim = new Simulation({ seed: SIM_SEED, latency: [10, 60] });
  try {
    const nodes = await sim.addNodes(SIM_NODES.map((name) => ({ name })));
    expect(await sim.waitForLedger(3, 60_000)).toBe(true);
    const users = [0, 1, 2, 3].map((i) => key(`sim-user-${i}`));
    const submitted: string[] = [];
    for (let i = 0; i < users.length; i++) {
      const r = await nodes[i % nodes.length].node!.friendbot(users[i].publicKey());
      expect(r.status, r.errorDetail).toBe('PENDING');
      submitted.push(r.hash);
      await sim.run(250);
    }
    const funded = () => nodes.every((n) => users.every((u) => n.node!.ledger.getAccount(u.publicKey()) !== undefined));
    expect(await sim.runUntil(funded, 60_000)).toBe(true);
    const passphrase = nodes[0].node!.passphrase;
    const nextSeq = new Map<string, bigint>();
    for (let i = 0; i < 8; i++) {
      const from = users[i % users.length];
      const to = users[(i + 1) % users.length];
      const at = nodes[(i + 2) % nodes.length];
      const seq = nextSeq.get(from.publicKey()) ?? at.node!.ledger.getAccount(from.publicKey())!.seqNum + 1n;
      nextSeq.set(from.publicKey(), seq + 1n);
      const env = envelopeOf(passphrase, {
        source: from,
        seq,
        ops: [Operation.payment({ destination: to.publicKey(), asset: Asset.native(), amount: `${i + 1}.25` })],
      });
      const r = await at.node!.submitTransaction(env);
      expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
      submitted.push(r.hash);
      await sim.run(400);
    }
    expect(await sim.waitForLedger(untilSeq, untilSeq * 10_000)).toBe(true);
    for (const n of nodes) await n.node!.chain.flush();

    expect(sim.historyConflicts()).toEqual([]);
    expect(sim.conflicts()).toEqual([]);
    for (const h of submitted) expect((await nodes[0].storage.getTx(h))?.successful, h).toBe(true);
    const chains = await Promise.all(nodes.map((n) => n.storage.getLedgers(1, untilSeq)));
    expect(chains[0].map((l) => l.seq)).toEqual(range(1, untilSeq));
    for (const chain of chains.slice(1)) expect(chain.map((l) => l.hash)).toEqual(chains[0].map((l) => l.hash));

    let snapshot: LedgerSnapshot | null = null;
    if (untilSeq >= CHECKPOINT_FREQUENCY) {
      const data = await Promise.all(nodes.map((n) => n.storage.getSnapshot(CHECKPOINT_FREQUENCY)));
      const snaps = data.map((d) => {
        expect(d).toBeTypeOf('string');
        return JSON.parse(d!) as LedgerSnapshot;
      });
      // every node took the same checkpoint (compared in canonical form)
      for (const s of snaps.slice(1)) expect(ledgerCanonicalJson(s)).toBe(ledgerCanonicalJson(snaps[0]));
      snapshot = snaps[0];
    }

    return {
      nodes: Object.fromEntries(nodes.map((n) => [n.name, n.nodeId])),
      users: users.map((u) => u.publicKey()),
      submitted,
      ledgers: Object.fromEntries(
        chains[0].map((l) => [String(l.seq), { hash: l.hash, closeTime: l.closeTime, txCount: l.txCount }]),
      ),
      snapshot,
    };
  } finally {
    await sim.shutdown();
  }
}

/** The 20-ledger run of this process (to compare the longer run against it). */
let shortRun: SimRun | null = null;

async function simulationVectors(): Promise<JsonObject> {
  const run = await runSimulation(SIM_LEDGERS);
  shortRun = run;
  return {
    seed: SIM_SEED,
    nodes: run.nodes,
    users: run.users,
    submitted: run.submitted,
    ledgers: { ...run.ledgers },
    lcl: { seq: SIM_LEDGERS, hash: run.ledgers[String(SIM_LEDGERS)].hash },
  };
}

/**
 * The same scenario run to the first checkpoint, with Date.now and
 * Math.random replaced: a run that read wall-clock time or Math.random would
 * no longer match the 20-ledger run.
 */
async function checkpointVectors(): Promise<JsonObject> {
  const random = seededRng(7);
  vi.spyOn(Date, 'now').mockImplementation(() => Date.UTC(2040, 0, 1));
  vi.spyOn(Math, 'random').mockImplementation(() => random());
  let run: SimRun;
  try {
    run = await runSimulation(CHECKPOINT_FREQUENCY);
  } finally {
    vi.restoreAllMocks();
  }
  // the first 21 ledgers equal the 20-ledger run (this process, else the file)
  const storedSim = stored?.simulation;
  const reference = shortRun?.ledgers ?? (isObject(storedSim) ? (storedSim.ledgers as JsonObject) : null);
  expect(reference, 'run the simulation vectors first').not.toBeNull();
  for (const seq of range(1, SIM_LEDGERS)) {
    expect(run.ledgers[String(seq)], `ledger ${seq}`).toEqual(reference![String(seq)]);
  }

  const snap = run.snapshot!;
  const header = decodeLedgerHeader(snap.headerXdr);
  expect(snap.seq).toBe(CHECKPOINT_FREQUENCY);
  expect(snap.hash).toBe(run.ledgers[String(CHECKPOINT_FREQUENCY)].hash);
  expect(hashLedgerHeader(header)).toBe(snap.hash);
  const loaded = loadLedgerFromSnapshot(snap, networkPassphrase(SIM_NETWORK));
  expect(loaded.lastClosed().hash).toBe(snap.hash);
  return {
    seq: snap.seq,
    headerHash: snap.hash,
    stateHash: header.bucketListHash,
    entryCount: snap.entries.length,
    // canonical JSON: the key order of the stored JSON is not consensus data
    snapshotHash: sha256Hex(ledgerCanonicalJson(snap)),
  };
}

// ---------------------------------------------------------------- stored bytes
// The tests below start from the bytes stored in vectors.json (frozen inputs),
// not from freshly built ones. They tell "the builder now emits other bytes"
// apart from "decoding, hashing or ledger rules changed", and they check that
// data persisted by older versions (IndexedDB, peers) still reads the same.

interface StoredGenesis {
  passphrase: string;
  networkId: string;
  headerXdr: string;
  headerHash: string;
  stateHash: string;
}

interface StoredKeys {
  raw: string;
  G: string;
  S: string;
  T: string;
  X: string;
}

interface StoredTx {
  xdr: string;
  hash: string;
  envelopeHash: string;
  ops: string[];
  signatures: { hint: string; signature: string }[];
}

interface StoredScpEnvelope {
  xdr: string;
  signaturePayload: string;
  signature: string;
}

interface StoredQSet {
  xdr: string;
  hash: string;
  normalizedXdr: string;
  normalizedHash: string;
}

/** A group of vectors.json (of this run while regenerating) for the stored-bytes tests. */
function frozen<T>(group: Group): T {
  const v = UPDATE ? (fresh[group] ?? stored?.[group]) : stored?.[group];
  if (!isObject(v)) throw new Error(`vectors.json has no "${group}" group. Generate it with: ${REGENERATE}`);
  return v as unknown as T;
}

/** Throw a readable diff when a record rebuilt from stored bytes differs from the stored one. */
function expectSame(group: Group, path: string, expected: unknown, actual: unknown): void {
  const diffs: string[] = [];
  diffJson(expected as Json, JSON.parse(JSON.stringify(actual)) as Json, path, diffs);
  if (diffs.length > 0) throw new Error(formatDiffs(group, diffs));
}

function decodeStoredTransactions(): void {
  const t = frozen<{ network: string; keys: Record<string, string>; envelopes: Record<string, StoredTx> }>(
    'transactions',
  );
  const networkId = networkIdOf(t.network);
  const signers = Object.values(t.keys)
    .filter((k) => k.startsWith('G'))
    .map((k) => Keypair.fromPublicKey(k));
  for (const [name, rec] of Object.entries(t.envelopes)) {
    const d = decodeTransaction(rec.xdr, networkId);
    const rebuilt: StoredTx = {
      xdr: d.envelopeXdr,
      hash: d.hashHex,
      envelopeHash: d.fullHashHex,
      ops: d.ops.map((o) => o.type),
      signatures: d.signatures.map((s) => ({ hint: toHex(s.hint), signature: toHex(s.signature) })),
    };
    expectSame('transactions', `transactions.envelopes.${name}`, rec, rebuilt);
    for (const s of d.signatures) {
      const signer = signers.find((kp) => toHex(kp.signatureHint()) === toHex(s.hint));
      if (signer) expect(signer.verify(d.hash, s.signature), name).toBe(true);
    }
  }
}

function replayStoredCloses(): void {
  const lc = frozen<{ network: string; ledgers: JsonObject[] }>('ledgerClose');
  const lm = createGenesisLedger(lc.network);
  lc.ledgers.forEach((rec, i) => {
    const txSet = lm.decodeTxSet(rec.txSetXdr as string);
    const value = decodeLedgerHeader(rec.headerXdr as string).scpValue;
    expect(verifyStellarValueSignature(lm.networkId, value)).toBe(true);
    const r = lm.closeLedger(txSet, value);
    expectSame('ledgerClose', `ledgerClose.ledgers[${i}]`, rec, closeRecord(rec.label as string, r));
  });
}

function decodeStoredScp(): void {
  const s = frozen<{
    networkId: string;
    qsets: Record<string, StoredQSet>;
    values: Record<string, string>;
    envelopes: Record<string, StoredScpEnvelope>;
    nomination: { emitted: string[] };
  }>('scp');
  const networkId = fromHex(s.networkId);
  for (const [name, rec] of Object.entries(s.qsets)) {
    const q = qsetFromXdr(rec.xdr);
    expect(qsetToBase64(q), name).toBe(rec.xdr);
    expect(hashQuorumSet(q), name).toBe(rec.hash);
    expect(qsetToBase64(normalizeQSet(q)), name).toBe(rec.normalizedXdr);
    expect(hashQuorumSet(qsetFromXdr(rec.normalizedXdr)), name).toBe(rec.normalizedHash);
  }
  for (const [name, v] of Object.entries(s.values)) {
    const info = decodeStellarValue(v);
    expect(encodeStellarValue(info), name).toBe(v);
    if (info.signature) expect(verifyStellarValueSignature(networkId, info), name).toBe(true);
  }
  const envelopes: [string, StoredScpEnvelope | string][] = [
    ...Object.entries(s.envelopes),
    ...s.nomination.emitted.map((x, i): [string, string] => [`emitted[${i}]`, x]),
  ];
  for (const [name, rec] of envelopes) {
    const xdrB64 = typeof rec === 'string' ? rec : rec.xdr;
    const env = envelopeFromBase64(xdrB64);
    expect(verifyEnvelope(env, networkId), name).toBe(true);
    expect(envelopeToBase64(env), name).toBe(xdrB64);
    if (typeof rec !== 'string') {
      expect(env.signature, name).toBe(rec.signature);
      expect(toHex(statementSignaturePayload(networkId, env.statement)), name).toBe(rec.signaturePayload);
    }
  }
}

/** Build the message again from its parsed parts. */
function rebuildMessage(m: ParsedStellarMessage): string {
  switch (m.kind) {
    case 'scpMessage':
      return makeScpMessage(m.envelopeXdr);
    case 'transaction':
      return makeTransactionMessage(m.envelopeXdr);
    case 'txSet':
      return makeTxSetMessage(m.txSetXdr);
    case 'getTxSet':
      return makeGetTxSetMessage(m.hash);
    case 'scpQuorumset':
      return makeScpQuorumSetMessage(m.qsetXdr);
    case 'getScpQuorumset':
      return makeGetScpQuorumSetMessage(m.hash);
    case 'dontHave':
      return makeDontHaveMessage(m.itemType, m.hash);
  }
}

function decodeStoredOverlay(): void {
  const o = frozen<{
    announcement: { canonicalJson: string; sha256: string; signature: string };
    messages: Record<string, string>;
  }>('overlay');
  const ann = JSON.parse(o.announcement.canonicalJson) as NodeAnnouncement;
  expect(overlayCanonicalJson(ann)).toBe(o.announcement.canonicalJson);
  expect(toHex(announcementDigest(ann))).toBe(o.announcement.sha256);
  expect(verifyAnnouncement(ann, o.announcement.signature)).toBe(true);
  for (const [name, m] of Object.entries(o.messages)) {
    const parsed = parseStellarMessage(m);
    expect(rebuildMessage(parsed), name).toBe(m);
    if (parsed.kind === 'scpMessage') {
      expect(verifyEnvelope(envelopeFromBase64(parsed.envelopeXdr), MAIN_ID)).toBe(true);
    }
  }
}

// ---------------------------------------------------------------- tests

describe('golden vectors', () => {
  it('1. genesis of the default network and of network "test"', () => {
    check('genesis', genesisVectors());
  });

  it('2. StrKey encodings (G, S, T, X, M)', () => {
    check('strkey', strkeyVectors());
  });

  it('3. transaction envelopes: every supported operation, memo type and precondition', () => {
    check('transactions', transactionVectors());
  });

  it('4. ledger closes on genesis, with setup ledgers and a fixed tx set', () => {
    check('ledgerClose', ledgerCloseVectors());
  });

  it('5. a signed StellarValue', () => {
    check('stellarValue', stellarValueVectors());
  });

  it('6. SCP quorum sets, envelopes, nomination hashes and leaders', () => {
    check('scp', scpVectors());
  });

  it('7. overlay announcement and StellarMessages', () => {
    check('overlay', overlayVectors());
  });

  it('8. a 4-node simulation: 20 ledgers with friendbot and payments', async () => {
    check('simulation', await simulationVectors());
  });

  it('9. the checkpoint snapshot of the same simulation at ledger 64', async () => {
    check('checkpoint', await checkpointVectors());
  });
});

describe('golden vectors: stored bytes decode, verify and replay unchanged', () => {
  it('genesis headers', () => {
    for (const [name, g] of Object.entries(frozen<Record<string, StoredGenesis>>('genesis'))) {
      const header = decodeLedgerHeader(g.headerXdr);
      expect(encodeLedgerHeader(header), name).toBe(g.headerXdr);
      expect(hashLedgerHeader(header), name).toBe(g.headerHash);
      expect(header.bucketListHash, name).toBe(g.stateHash);
      expect(toHex(networkIdOf(g.passphrase)), name).toBe(g.networkId);
    }
  });

  it('StrKeys', () => {
    const s = frozen<Record<string, StoredKeys> & { muxedOfSeeded: Record<string, string> }>('strkey');
    for (const name of ['zero', 'ff', 'seeded']) {
      const k = s[name];
      expect(toHex(StrKey.decodeEd25519PublicKey(k.G)), name).toBe(k.raw);
      expect(toHex(StrKey.decodeEd25519SecretSeed(k.S)), name).toBe(k.raw);
      expect(toHex(StrKey.decodePreAuthTx(k.T)), name).toBe(k.raw);
      expect(toHex(StrKey.decodeSha256Hash(k.X)), name).toBe(k.raw);
    }
    for (const [id, m] of Object.entries(s.muxedOfSeeded)) {
      const raw = toHex(StrKey.decodeMed25519PublicKey(m));
      expect(raw, m).toBe(s.seeded.raw + toHex(writeUint64BE(BigInt(id))));
    }
  });

  it('transaction envelopes give the stored hashes, operations and signatures', () => {
    decodeStoredTransactions();
  });

  it('the stored tx sets and values replay to the stored ledger closes', () => {
    replayStoredCloses();
  });

  it('StellarValue', () => {
    const v = frozen<{
      networkId: string;
      nodeId: string;
      txSetHash: string;
      closeTime: number;
      signaturePayload: string;
      signature: string;
      valueXdr: string;
      basicValueXdr: string;
    }>('stellarValue');
    const networkId = fromHex(v.networkId);
    const info = decodeStellarValue(v.valueXdr);
    expect(info).toEqual({
      txSetHash: v.txSetHash,
      closeTime: v.closeTime,
      upgrades: [],
      signature: { nodeId: v.nodeId, signature: v.signature },
    });
    expect(verifyStellarValueSignature(networkId, info)).toBe(true);
    expect(encodeStellarValue(info)).toBe(v.valueXdr);
    expect(toHex(stellarValueSignaturePayload(networkId, info.txSetHash, info.closeTime))).toBe(v.signaturePayload);
    const basic = decodeStellarValue(v.basicValueXdr);
    expect(basic.signature).toBeNull();
    expect(encodeStellarValue(basic)).toBe(v.basicValueXdr);
  });

  it('SCP quorum sets, values and envelopes', () => {
    decodeStoredScp();
  });

  it('overlay announcement and StellarMessages', () => {
    decodeStoredOverlay();
  });
});
