# BrowserChain architecture

BrowserChain is a Stellar-like blockchain that runs entirely in browsers.
Every open tab is a validator node. Nodes reach consensus with a TypeScript
port of the Stellar Consensus Protocol (SCP), apply real Stellar XDR
transactions to a classic-Stellar ledger, and talk to each other over
BroadcastChannel (tabs of one browser) and WebRTC (across the internet).
There is no backend: the site is static files.

This document is the contract between modules. Shared types live in code:

| File | What it defines |
| --- | --- |
| `src/lib/*` | bytes/hex/base64, sha256, Clock (Real + Virtual), Emitter, Logger, seeded RNG, amounts, constants, sign/verify helpers |
| `src/scp/types.ts`, `src/scp/driver.ts` | SCP data model and the driver interface |
| `src/ledger/types.ts`, `src/ledger/asset.ts` | ledger entries, header, tx set, results, snapshot, `ILedgerManager` |
| `src/overlay/types.ts` | transports, wire messages, `IOverlay` |
| `src/storage/types.ts` | `Storage` |
| `src/node/api.ts` | the UI-facing `NodeApi`, views and events |

Do not change these shared files without a strong reason. If a module needs
more, add it inside the module. If a shared type is wrong, report it.

---

## 1. Principles

1. **Stellar fidelity where it matters.** Real XDR (`@stellar/stellar-sdk/base`,
   js-xdr 5) for transactions, SCP envelopes, quorum sets, StellarValue, LedgerHeader,
   TransactionSet and TransactionResult. StrKey addresses (G..., T..., X...).
   XLM with 7 decimals, stroops, base fee 100, base reserve 0.5 XLM, sequence
   numbers, thresholds and signers, trustlines, the DEX.
2. **Determinism.** Ledger close is a pure function of (state, tx set,
   StellarValue). No local time, randomness or iteration-order dependence in
   it. Replaying a ledger on another node must give the identical header hash.
3. **Injected time.** All code uses `Clock` from `src/lib/clock.ts`. Never call
   `Date.now()`, `setTimeout` or `setInterval` directly outside `RealClock`.
   The simulation uses `VirtualClock` to run many nodes fast and reproducibly.
4. **No trust in peers.** Verify every signature (SCP envelopes, StellarValue
   signatures, transactions, hello/status announcements). Verify every hash
   (tx sets, quorum sets, headers, snapshots). Bound every buffer and request.
5. **Small modules with tests.** Each module ships unit tests
   (`*.test.ts` next to the code, run by Vitest in Node).

## 2. Repository layout and ownership

```
src/lib/        shared utilities (owned by the architect; do not edit)
src/scp/        SCP core: quorum functions, nomination, ballot protocol, slot, SCP, XDR codec
src/ledger/     ledger state, entries, validation, operations, header, genesis, tx sets, results
src/ledger/dex/ offers, order book crossing, path payments (DEX)
src/overlay/    transports (BroadcastChannel, WebRTC/Trystero bridge, memory), overlay manager
src/storage/    Storage implementations (memory, IndexedDB)
src/herder/     SCP driver, tx queue, tx set building, pending envelopes, quorum policy, ledger close pipeline
src/history/    serving history to peers, catch-up, fork detection and resolution
src/node/       Node composition, NodeApi implementation, worker, client RPC, identity slots, boot
src/sim/        deterministic multi-node simulation harness and scenario tests
src/ui/         React UI (+ a mock NodeApi for UI development)
src/main.tsx    browser entry
e2e/            Playwright tests (several tabs = several validators)
.reference/     stellar-core sources + SCP IETF draft (read-only reference, gitignored)
```

## 3. Conventions

- TypeScript 7, strict, ES2022, ESM. Vite 8, React 19, Tailwind 4, Vitest 5, Playwright 1.64.
- Dependencies are already installed. Do **not** run `npm install` or edit
  `package.json`, `tsconfig.json`, `vite.config.ts` (other agents work in
  parallel). Ask for a dependency in your report instead.
- Hex is lowercase. Amounts are `bigint` stroops inside the ledger and
  7-decimal strings at the API (`formatAmount`, `parseAmount`).
- Hashes: `sha256`/`sha256Hex` from `src/lib/hash.ts`.
- Signatures: ed25519 via the `Keypair` of `@stellar/stellar-sdk/base`
  (`signHex`, `verifyHex`). It uses @noble/ed25519 with strict RFC 8032
  checks: canonical encodings, S < L, no small-order public keys.
- Bytes are `Uint8Array` everywhere (helpers in `src/lib/bytes.ts`). There is
  no global `Buffer` and no Buffer polyfill. XDR values are plain objects objects
  with fields (`header.ledgerSeq`), unions switch on `.type`, int64 is `bigint`.
- Code comments: short, plain English, only where the code is not obvious.
  When porting stellar-core logic, keep a one-line reference to the source
  function name (for example `// BallotProtocol::attemptAcceptPrepared`).
- Ported code: stellar-core is Apache-2.0. Files that port its logic start
  with `// Ported from stellar-core (Apache-2.0): src/scp/BallotProtocol.cpp`.
- Typecheck: `npx tsc --noEmit` (filter output to your paths while other
  modules are in progress). Tests: `npx vitest run src/<module>`.
- Golden vectors (`src/golden/vectors.json`) freeze consensus bytes.
  Regenerate them (`GOLDEN_UPDATE=1`) only for an intended protocol change,
  and record each regeneration in `src/golden/CHANGES.md`.

## 4. Network constants and genesis

Constants are in `src/lib/constants.ts`.

- Passphrase: `networkPassphrase(name)`; default
  `"BrowserChain Network ; October 2026"`. Network ID = SHA-256(passphrase).
- The URL parameter `?network=<name>` selects a separate network.

**Genesis (ledger 1) is deterministic**, so any node can create it alone and
all nodes agree on it:

| Field | Value |
| --- | --- |
| ledgerVersion | `PROTOCOL_VERSION` (23) |
| previousLedgerHash | 32 zero bytes |
| scpValue | txSetHash zero, closeTime 0, no upgrades, `STELLAR_VALUE_BASIC` |
| txSetResultHash | zero |
| bucketListHash | state hash of the genesis entries (section 5.6) |
| ledgerSeq | 1 |
| totalCoins | `TOTAL_COINS` (10^18 stroops = 100 billion XLM) |
| feePool, inflationSeq, idPool | 0 |
| baseFee / baseReserve / maxTxSetSize | 100 / 5,000,000 / 1000 |
| skipList | 4 zero hashes |

Genesis entries:

- Root account `Keypair.master(passphrase)`: balance
  `TOTAL_COINS - FRIENDBOT_CHANNELS * FRIENDBOT_CHANNEL_BALANCE`, seqNum 0,
  thresholds master 0 / low 0 / med 0 / high 0, no signers, flags 0. The root
  key is public, so the root is locked: no transaction or operation from it
  can be authorized (`txBAD_AUTH`, `opBAD_AUTH`). It can still receive payments.
- Friendbot channel accounts `i = 0..15`:
  `Keypair.fromRawEd25519Seed(sha256(`${passphrase}|friendbot|${i}`))`, balance
  `FRIENDBOT_CHANNEL_BALANCE`, seqNum 0, thresholds master 1 / low 0 / med 0 / high 0.
- `lastModifiedLedgerSeq = 1` for all.

The friendbot keys are public knowledge (derived from the passphrase). The
channel policy (7.3) limits what they can sign, and the friendbot lane (7.5)
limits how many such transactions fit in a ledger. This is a play-money
network, like Stellar testnet. `createGenesisLedger(passphrase, { unlockRoot: true })`
keeps the root master weight 1. Only unit tests use it, and its genesis hash
differs. Nodes always use the default genesis.

## 5. Data formats

### 5.1 Ledger keys
Strings, see `LedgerKey` in `src/ledger/types.ts`:
`A:<account>`, `T:<account>:<code>:<issuer>`, `O:<offerId>`, `D:<account>:<name>`,
`C:<balanceIdHex>`.

### 5.2 SCP values
An SCP `Value` is the lowercase hex of `xdr.StellarValue.toXDR()`.

- Nominated values are `STELLAR_VALUE_SIGNED`: `LedgerCloseValueSignature`
  `{ nodeID, signature }`. The signature is ed25519 over the raw bytes
  `networkId(32) || int32BE(4 /* ENVELOPE_TYPE_SCPVALUE */) || txSetHash(32) || uint64BE(closeTime)`.
- `upgrades` must be empty (upgrades are not supported).
- Codec: `src/ledger/value.ts` — `encodeStellarValue(v): string /* hex */`,
  `decodeStellarValue(hex): StellarValueInfo` (throws if malformed),
  `stellarValueSignaturePayload(networkId, txSetHash, closeTime): Uint8Array`,
  `signStellarValue(...)`, `verifyStellarValueSignature(...)`.

### 5.3 SCP envelopes and quorum sets
- Wire form: `xdr.ScpEnvelope` (base64). In-memory form: `Envelope` from
  `src/scp/types.ts`. Codec in `src/scp/xdr.ts`:
  `envelopeToXdr`, `envelopeFromXdr`, `statementToXdr`, `qsetToXdr`,
  `qsetFromXdr`, `hashQuorumSet(qset): Hash` (= SHA-256 of `xdr.ScpQuorumSet`
  XDR, validators in the given order), `statementSignaturePayload(networkId, statement)`
  = `networkId || int32BE(1 /* ENVELOPE_TYPE_SCP */) || statement XDR`.
- Envelope signature = ed25519 over that payload, hex in `Envelope.signature`.

### 5.4 Transaction sets
Classic `xdr.TransactionSet { previousLedgerHash, txs }`.
- Canonical order: ascending by SHA-256 of each envelope's XDR bytes.
- Hash: `SHA-256(previousLedgerHash || env_1 XDR || ... || env_n XDR)` in canonical order.
- `ILedgerManager.makeTxSet` / `decodeTxSet` produce `TxSetInfo` with `hash` and `xdr`.

### 5.5 Ledger header
`xdr.LedgerHeader` with the `LedgerHeader` fields. Ledger hash = SHA-256 of
the header XDR. Codec in `src/ledger/header.ts`: `encodeLedgerHeader(h): string /* base64 */`,
`decodeLedgerHeader(b64)`, `hashLedgerHeader(h): Hash`. The skip list stays
4 zero hashes (not maintained).

### 5.6 State hash (`bucketListHash`)
Stellar uses the BucketList hash. We use a flat state hash:

```
entryHash(e) = sha256( utf8(key(e)) || 0x00 || utf8(canonicalJson(serializeEntry(e))) )
stateHash    = sha256( concat over entries sorted by key (string order) of utf8(key) || 0x00 || entryHash )
```

`canonicalJson` = JSON with object keys sorted recursively, no whitespace.
`serializeEntry` turns bigint fields into decimal strings. An implementation
may cache entry hashes; the result must be identical.

### 5.7 Snapshots
`LedgerSnapshot` (JSON): header XDR + all serialized entries. Taken after
closing every ledger with `seq % CHECKPOINT_FREQUENCY === 0` and stored in
Storage. A node loading a snapshot must check
`stateHash(entries) === header.bucketListHash` and `hashLedgerHeader(header) === snapshot.hash`.

### 5.8 Results
- Per tx: real `xdr.TransactionResult` (base64), plus `TxApplyResult` with
  readable `resultCode` ("txSUCCESS", "txFAILED", "txBAD_SEQ", ...) and
  per-operation `OperationSummary` (`resultCode` like "PAYMENT_UNDERFUNDED").
- Per ledger: `xdr.TransactionResultSet` of `TransactionResultPair`s in apply
  order. `header.txSetResultHash = SHA-256(TransactionResultSet XDR)`.

## 6. SCP (`src/scp`)

A faithful TypeScript port of stellar-core's classic SCP (`.reference/stellar-core/src/scp`)
cross-checked with the IETF draft (`.reference/scp-ietf-draft-05.txt`).

Port: `QuorumSetUtils` (sanity check, normalize), `LocalNode` (isQuorumSlice,
isVBlocking, isQuorum, findClosestVBlocking, getNodeWeight, ...),
`NominationProtocol`, `BallotProtocol`, `Slot`, `SCP`, and the default hash
helpers of `SCPDriver.cpp` (`computeHashNode`, `computeValueHash` defaults in
`src/scp/hash.ts`, SHA-256 over XDR-encoded parts, first 8 bytes big-endian).

Leave out newer stellar-core features: parallel tx set download,
empty-tx-set values, upgrade stripping, nomination timeout limits, the
application-specific weight function, JSON info dumps, metrics.

Public API (`src/scp/scp.ts`):

```ts
class SCP {
  constructor(driver: SCPDriver, nodeId: NodeId, isValidator: boolean, qset: QuorumSet)
  receiveEnvelope(env: Envelope): EnvelopeState
  nominate(slotIndex: number, value: Value, previousValue: Value): boolean
  stopNomination(slotIndex: number): void
  updateLocalQuorumSet(qset: QuorumSet): void     // re-evaluates open slots; recomputes the current round's leaders from the new set (drops earlier rounds' leaders); may emit envelopes
  getLocalQuorumSet(): QuorumSet
  getLocalQuorumSetHash(): Hash
  getLocalNodeId(): NodeId
  isValidator(): boolean
  setValidator(on: boolean): void                // watcher mode: process but never emit
  purgeSlots(maxSlotIndex: number): void         // forget slots < maxSlotIndex
  getLatestMessagesSend(slotIndex: number): Envelope[]
  getCurrentState(slotIndex: number): Envelope[] // latest envelope of every node for the slot
  getExternalizingState(slotIndex: number): Envelope[]
  getSlotInfo(slotIndex: number): SlotInfo | null
  getKnownSlots(): number[]
  isSlotFullyValidated(slotIndex: number): boolean
  gotVBlocking(slotIndex: number): boolean
  // Extensions the herder needs (no stellar-core counterpart for the first two):
  abandonBallot(slotIndex: number): boolean       // bump to a new ballot counter
  refreshNomination(slotIndex: number, value: Value): void // vote for a fresh value
  getEntireCurrentState(): Envelope[]
  setStateFromEnvelope(slotIndex: number, env: Envelope): void
  getExternalizedValue(slotIndex: number): Value | null
  getNominationLeaders(slotIndex: number): NodeId[]
}
```

`getCurrentState` returns both the nomination and the ballot envelope of each
node. SCP invariant checks always throw (`SCP invariant violated: ...`); the
herder catches exceptions from `receiveEnvelope` and from timer callbacks.
Peer statements of any shape must not trigger them. A prepared ballot with
counter 0 is valid (draft-05 3.6): confirming it only sets the value of the
next ballot and never becomes h or b. Envelopes must not be modified after
they are passed to SCP, because SCP caches per-statement value sets.

A node's latest nomination can carry an older local quorum set:
`setStateFromEnvelope` restored it, then `updateLocalQuorumSet` ran before
the slot's first `nominate()`. `abandonBallot` and `refreshNomination` do
nothing then. So when `nominate()` votes nothing new and the latest
nomination carries another quorum set, it votes the node's own value: the
statement is strictly newer and announces the current set. The same rule
applies to later nomination rounds without a candidate.

Driver notes: `combineCandidates` must return a value that `validateValue`
reports as `FullyValidated`. `validateValue` is called very often; memoize it
per (slot, value). Cache signature checks per envelope (ed25519 verify in JS
costs about 0.8 ms).

The SCP module never touches the network, storage or clock directly: timers
go through `driver.setupTimer`. Envelopes arrive already signature-checked
and with their quorum sets and values available (the herder guarantees this);
SCP still calls `driver.getQSet` and treats `null` as invalid.

Tests must include ports of representative cases from
`src/scp/test/SCPTests.cpp` and `QuorumSetTests.cpp` (core5 ballot
protocol scenarios, nomination with leaders, v-blocking/quorum checks), plus
a small in-process network of SCP instances (4-7 nodes, random message
delays from a seeded RNG over `VirtualClock`) that checks safety (no two nodes
externalize different values for a slot) and liveness.

## 7. Ledger (`src/ledger`)

Implements `ILedgerManager` with `createGenesisLedger(passphrase)` and
`loadLedgerFromSnapshot(snapshot)` (`src/ledger/index.ts` exports them).

### 7.1 State
An in-memory `Map<LedgerKey, LedgerEntry>` with a nested transactional layer
(like stellar-core `LedgerTxn`): open child, load, create, update, erase,
commit into parent, rollback. Operations work inside a tx-level child, which
works inside a ledger-level child. Every entry written gets
`lastModifiedLedgerSeq = ledgerSeq`.

### 7.2 Transactions accepted
- `ENVELOPE_TYPE_TX` (v1) envelopes. V0 and fee-bump envelopes: reject with
  `txNOT_SUPPORTED`.
- Preconditions: none, time bounds, ledger bounds, and V2 `minSeqNum` with
  the stellar-core relaxed check (`minSeqNum <= account seq < tx seq`).
  The SDK builder writes `minSeqNum` only when `minAccountSequence` is set
  (stellar-base 15 wrote `minSeqNum = 0` into every V2 precondition). Other V2
  preconditions (minSeqAge, minSeqLedgerGap, extraSigners): `txNOT_SUPPORTED`.
- Muxed accounts (M...) as source or destination: use the underlying G account.
- Memo: any type.

### 7.3 Validity (`checkValid`, and again at apply time)
Port the order of checks from `TransactionFrame::commonValid` /
`checkValid`. In short:
1. Structure: 1..100 operations, fee >= `baseFee * opCount`, each op well formed (`*MALFORMED` codes).

   **1a. Friendbot channel policy** (BrowserChain rule, `src/ledger/channelPolicy.ts`).
   A transaction whose source, or any of whose operation sources, is a
   channel account has exactly one operation, sourced from a channel (from
   the transaction's source when that is a channel). It is a CreateAccount
   with startingBalance `FRIENDBOT_AMOUNT` (10,000 XLM) or a native Payment of
   `FRIENDBOT_AMOUNT`. The destination can be any account that fits the
   destination rule below, and another account may pay the fee. The fee bid
   is exactly `baseFee` (one operation), so
   nobody can outbid a friendbot transaction or replace a queued one by fee.
   A channel's own transaction may not set `minSeqNum`.
   Else `txNOT_SUPPORTED` with a detail. At apply time such a transaction has
   no effect and uses no sequence number; only the fee is charged.

   Destinations (version 4; checkValid and tx sets, not at apply time): a
   channel CreateAccount must create an account that does not exist, and a
   channel Payment must pay an account that exists (a muxed destination is
   its G account). Else `txFAILED` with the result the operation would get
   when applied (`CREATE_ACCOUNT_ALREADY_EXIST`, `PAYMENT_NO_DESTINATION`);
   the detail names the policy. The state is the LCL plus, in a tx set, the
   accounts that channel CreateAccounts earlier in the same source account's
   chain create. So a friendbot top-up may follow its create, and a second
   create of the same account is refused. A single mempool check cannot see
   queued transactions: for a transaction that follows queued ones, a missing
   Payment destination is left to `trimInvalid` and `checkTxSetValid`. Apply
   time keeps the normal results: two creates of one new account from
   different sources can share a ledger, and the second fails.
2. Time bounds (`txTOO_EARLY` / `txTOO_LATE`) against the close time; ledger bounds.
3. Source account exists (`txNO_ACCOUNT`).
4. `seqNum == account.seqNum + 1` (`txBAD_SEQ`). Mempool callers may pass `seqNumOverride`.
5. Signatures: tx source at LOW threshold for fee/seq, each op source at the
   op's threshold (LOW/MED/HIGH per stellar-core `getThresholdLevel`).
   Signer types: master key (weight = thresholds.master), ed25519 signers,
   pre-auth tx (T..., matches the tx hash, removed after the tx is applied),
   hash-x (X..., signature bytes are the preimage). Unused signatures:
   `txBAD_AUTH_EXTRA`. Port `SignatureChecker` semantics.
6. Fee: available native balance (balance - minBalance - selling liabilities - pendingFees) >= fee bid, else `txINSUFFICIENT_BALANCE`.

### 7.4 Close (`closeLedger(txSet, value)`)
1. Require `txSet.previousLedgerHash == LCL hash` and `value.txSetHash == txSet.hash`.
2. Apply order (legacy stellar-core): group txs by source account, sort each
   group by seqNum. Batch k = the k-th tx of every account. Inside a batch,
   sort by `txHash XOR txSetHash` (bytes, ascending). Concatenate batches.
   `txHash` here is the envelope hash (SHA-256 of the envelope XDR,
   stellar-core `getFullHash`), not the transaction contents hash.
3. Fee phase: for every tx in apply order, charge
   `min(balance, baseFee * opCount)` from the source, add to `feePool`.
4. Apply phase: for every tx: re-check validity against the current state
   (except the fee), bump the source seqNum when it matches, apply all
   operations in a child txn, commit if all succeed, else roll back and
   report `txFAILED` with each op result. Port the exact "apply all ops, then
   decide" behavior and result codes from stellar-core.
5. New header: `ledgerSeq+1`, `previousLedgerHash`, `scpValue = value`,
   `txSetResultHash`, `bucketListHash = stateHash()`, updated `feePool`,
   `idPool` (offer ids), others carried over.
6. Snapshot hook: the caller (herder) takes snapshots; `closeLedger` only returns results.

### 7.5 Operations
Implement with stellar-core semantics and result codes (read the matching
`*OpFrame.cpp` in `.reference/stellar-core/src/transactions`):

- Ledger core agent: CreateAccount (new seqNum = `ledgerSeq << 32`), Payment,
  SetOptions, ChangeTrust (credit assets only; pool shares: `CHANGE_TRUST_MALFORMED`),
  AllowTrust, SetTrustLineFlags, AccountMerge, ManageData, BumpSequence,
  CreateClaimableBalance (balance id = SHA-256 of `HashIDPreimage` OP_ID for
  (source, seqNum, opIndex), as in stellar-core), ClaimClaimableBalance
  (predicate evaluation at close time), Clawback, ClawbackClaimableBalance.
  Liabilities fields exist on accounts and trustlines and every balance check
  respects them (`getAvailableBalance`, `getMaxAmountReceive`).
- DEX agent (`src/ledger/dex`): ManageSellOffer, ManageBuyOffer,
  CreatePassiveSellOffer, PathPaymentStrictReceive, PathPaymentStrictSend,
  offer crossing (`OfferExchange.cpp`: `exchangeV10`, price-time priority,
  liabilities acquire/release, self-crossing `*_CROSS_SELF`), plus
  `getOrderBook`.
- Not supported (`opNOT_SUPPORTED`): Inflation, sponsorship ops
  (Begin/End/RevokeSponsorship), liquidity pools, Soroban
  (InvokeHostFunction, ExtendFootprintTTL, RestoreFootprint).

DEX facts integrators rely on: the DEX follows protocol 23, before the
protocol 29 `exchangeV10` rounding change. Claim atoms are
`CLAIM_ATOM_TYPE_ORDER_BOOK`. One operation may cross at most 1000 offers
(`opEXCEEDED_WORK_LIMIT`), and path payment hops share that budget.
`checkDexOperationValidForOverlay` is an optional mempool check, not part of
ledger validity. `src/ledger/dex/quote.ts` gives read-only quotes
(`priceLevels`, `quoteStrictSend`, `quoteStrictReceive`, `findPaths`) that
run the real crossing code on a throwaway copy of the last closed ledger.
`findPaths` searches breadth first and follows at most `maxSteps` edges
(default `FIND_PATHS_MAX_STEPS` = 2,000). Below the budget the results equal
an unbounded search; a cut keeps every shorter path.

A tx set holds at most `MAX_DEX_OPS_IN_TX_SET` (200) operations of
transactions that have a DEX operation (an offer that is not a delete, or a
path payment with a path or two different assets). All operations of such a
transaction count, as in stellar-core's `MAX_DEX_TX_OPERATIONS_IN_TX_SET`.
`checkTxSetValid` rejects a larger set. `trimInvalid` fills this lane by fee
rate, and the transactions that do not fit stay queued.

The friendbot lane works the same way: a tx set holds at most
`MAX_FRIENDBOT_TXS_IN_TX_SET` (16) transactions that use a friendbot channel
(as the transaction source or an operation source). `checkTxSetValid`
rejects a larger set. All of them bid the same fee (7.3), so `trimInvalid`
takes the lowest envelope hashes among the account heads. The lane caps the
drain through the public channel keys at 160,000 XLM per ledger.

When a node builds its own tx set (10.3), its own queued friendbot
transactions come first in the lane. Each one takes the lane slots of its
account's transactions that must go before it, and the cheapest goes first.
The rest of the lane follows the rule above. Peers check such a set like any
other. So an attacker who fills the lane cannot keep a node's friendbot
requests out of the ledgers whose tx set that node built.

The ledger core dispatches the five DEX operation types to
`applyDexOperation(...)` in `src/ledger/dex/index.ts`. The ledger core agent
creates that file as a stub returning `opNOT_SUPPORTED`, with the signature it
needs; the DEX agent replaces the body.

### 7.6 Views for the UI
`src/ledger/describe.ts`: `summarizeOperations(envelope, results)` producing
`OperationSummary[]` (amounts as 7-decimal strings, assets as `XLM` or
`CODE:ISSUER`), memo extraction, and the list of touched accounts.
Operation details also carry `sendAmountSent` (a successful
pathPaymentStrictReceive: the amount of the send asset taken from the source)
and `createdOfferId` (a manage offer operation that created an offer).

## 8. Overlay (`src/overlay`)

### 8.1 Transports (`Transport` in `src/overlay/types.ts`)
- **BroadcastChannelTransport** (works in workers): channel name
  `browserchain:<networkIdHex[0..16]>`. Every endpoint has a random id.
  Frames `{ from, to?, kind: 'join'|'here'|'beat'|'leave'|'msg', msg? }`.
  Presence: `join` on start (others answer `here`), `beat` every 2 s, peer
  down after `PEER_TIMEOUT_MS` without frames, `leave` on stop. `send` sets
  `to`; receivers drop frames not for them.
- **MemoryNetwork / MemoryTransport** (tests and simulation): delivery
  through the injected `Clock` with per-link latency
  (`latencyMs(from, to, rng)`), drop rate, partitions
  (`partition(groups)`, `heal()`), and `disconnect(id)`. Messages are
  deep-copied (structuredClone) on send.
- **WebRTC via Trystero** (`trystero` 0.26, Nostr strategy). WebRTC is not
  available in workers, so it is split:
  `TrysteroHost` (main thread, `src/overlay/trysteroHost.ts`) joins the room
  `browserchain-<networkIdHex[0..16]>` with appId `browserchain`, and relays
  through a `MessagePort` to `BridgeTransport` (worker side,
  `src/overlay/bridgeTransport.ts`). Port protocol: main->worker
  `{type:'up'|'down', peer}` and `{type:'msg', peer, msg}`; worker->main
  `{type:'send', peer, msg}`, `{type:'broadcast', msg}`. Trystero API:
  `joinRoom(config, roomId)`, `room.onPeerJoin = id => ...`,
  `room.onPeerLeave`, `const a = room.makeAction('m'); a.send(data, {target}); a.onMessage = (data, {peerId}) => ...`, `room.leave()`.
  Signalling uses an explicit list of public Nostr relays (`NOSTR_RELAYS` in
  `src/overlay/trysteroHost.ts`; six relays that passed anonymous connect,
  subscribe, publish and echo probes on 2026-10-16). Trystero connects to
  every listed relay, so the list length is the redundancy. All nodes must
  use the same list.
  The main->worker `up` message is `{type:'up', peer, channel?}`. `channel` is
  the DTLS channel id of the peer connection: SHA-256 over the sorted pair of
  our certificate fingerprint (from our SDP) and the SHA-256 of the
  certificate the remote proved in the DTLS handshake
  (`RTCDtlsTransport.getRemoteCertificates`). An `up` with another channel
  for a known peer is a new connection: the worker treats it as down, then up.

### 8.2 Overlay manager (`Overlay implements IOverlay`)
- On transport peer up: send `hello` (signed `NodeAnnouncement`). On a valid
  hello (signature OK, same networkId, appVersion equal to `APP_VERSION`, not ourselves),
  the transport peer is bound to that `nodeId`. One node may be reachable over
  several transports; keep all links, send over one (prefer broadcast, then
  webrtc), dedupe on receive.
- Link binding as built. Every hello carries `nonce`, the sender's random
  16-byte nonce for this link. On WebRTC links (kinds `webrtc` and `bridge`)
  a hello binds the link only when its `peerNonce` equals the receiver's
  current nonce for the link, its signed `channel` equals the link's DTLS
  channel id, and the signature verifies over
  `sha256(canonicalJson({t:'hello', ann, nonce, peerNonce, channel}))`. Any
  other hello is answered with our own hello, which covers the sender's nonce
  (at most 4 at once, then 1 per second per link). A hello made for another
  channel, for example relayed by a third party, is rejected. A status never
  binds a WebRTC link. A link that loses its node gets a new nonce.
  BroadcastChannel and memory links bind on a plain signed hello.
  `APP_VERSION` is 4. Version 2 changed the hello format (link nonce, DTLS
  channel) and the ledger rules (root lock, channel policy, DEX cap).
  Version 3 added the friendbot lane and the channel fee rule (7.3, 7.5).
  Version 4 added the channel destination rule (7.3).
  Builds of different versions do not bind each other.
- A bye on a WebRTC link ends only that link while the node has other links.
  On the node's last link, or on a BroadcastChannel or memory link, it drops
  the node at once.
- `status` (same signed announcement) every `STATUS_INTERVAL_MS` and when it
  changes. Peers silent for `PEER_TIMEOUT_MS` are dropped. `bye` on stop.
- Announcement signature: ed25519 over `sha256(canonicalJson(ann))`.
  Announcements with unknown fields are rejected; `nodeId` must be a G...
  StrKey.
- Flooding: `floodStellar` sends `{t:'stellar', xdr, flood:true}` to every
  peer. On receive, compute `sha256(xdr)`; if seen before, drop; else record
  (bounded LRU, ~20k entries), call `onStellarMessage`, and re-flood to all
  peers except the sender.
- Requests: `{t:'req', id, body}` -> `{t:'res', id, body}`; timeouts reject;
  at most 4 concurrent inbound requests per peer. An inbound handler that has
  not settled after 30 s is answered with 'handler timeout' and frees its
  slot. A response larger than one message travels as
  `{t:'part', id, index, total, data}` frames: the data of all parts, in
  index order, is the JSON of the body (2 MB pieces, 2 to 256 parts, at most
  64 MB). The requester reassembles and validates it. A parted response must
  complete within 2 request timeouts plus 1 timeout per `PART_CHARS`
  received. Large responses have budgets: per peer, one full response
  refilled in 16 s; shared, two refilled in 4 s. Over budget, the answer is
  'busy'.
- Latency: track RTT from request/response pairs.
- Bounds: drop messages larger than 4 MB. Per-link token buckets are on by
  default: 300 messages/s (burst 1500) and 8 MB/s (burst 32 MB) of estimated
  JSON; answers to our own requests do not count. At most 64 bound nodes
  (`MAX_PEERS`) and 128 links (`MAX_LINKS`) per overlay. At the link cap, an
  unbound link older than `PEER_TIMEOUT_MS` gives its slot to a newcomer, its
  transport peer is ignored for 60 s unless it reconnects, and link-ups
  refused at the cap are retried by the sweep.
- `floodStellar` always sends; receivers dedupe. `onPeerStatus` fires on every
  newer status. `onStellarMessage` may return `false` to stop the re-flood.
- The bridge protocol has two more worker->main messages: `ready` and `stopped`.
- On the main thread, import `TrysteroHost` from `src/overlay/trysteroHost`
  directly; `src/overlay/index.ts` does not export it, so worker code never
  pulls in trystero. `BridgeTransport` reports kind `webrtc` unless created
  with `{ kind: 'bridge' }`.

`src/overlay/stellarMessage.ts`: helpers to build/parse `xdr.StellarMessage`
for `SCP_MESSAGE` (envelope), `TRANSACTION`, `TX_SET`, `GET_TX_SET`,
`SCP_QUORUMSET`, `GET_SCP_QUORUMSET`, `DONT_HAVE`.

## 9. Storage (`src/storage`)
`MemoryStorage` and `IdbStorage` (library `idb`), both implementing
`Storage`. IndexedDB database name is given by the caller (one per network
and identity slot). Object stores: `meta`, `ledgers` (key seq),
`txs` (key hash, indexes `ledgerSeq`, multi-entry `accounts`), `snapshots`
(key seq). Index layout: `ledgerSeq` on `[ledgerSeq, applyIndex]`, and
multi-entry `accounts` on derived `[account, ledgerSeq, applyIndex]` keys.
`putLedger` is one transaction. `IdbStorage` keeps the newest 8 snapshots
(`KEEP_SNAPSHOTS`); `putSnapshot` deletes older ones in the same
transaction. `MemoryStorage` keeps all snapshots unless it is built with
`keepSnapshots`. A fork point older than the oldest kept snapshot reloads
from genesis and replays. In the browser, `FallbackStorage` wraps IndexedDB:
when it is full, cannot open, loses its connection or reports UnknownError
(Chromium backing-store failures), it logs one error and keeps new data in
memory (keeping 8 snapshots). Test `IdbStorage` with
`fake-indexeddb` (`import 'fake-indexeddb/auto'`).

## 10. Herder (`src/herder`)

The glue between SCP, the ledger, the overlay and storage. Follows
stellar-core `HerderImpl`/`HerderSCPDriver`/`PendingEnvelopes`/`TransactionQueue`.

### 10.1 SCP driver (`HerderSCPDriver implements SCPDriver`)
- `signEnvelope`: node key over `statementSignaturePayload`.
- `getQSet`: from the quorum-set cache.
- `emitEnvelope`: flood `SCP_MESSAGE`, record it for monitoring.
- `validateValue(slot, value, nomination)`:
  decode StellarValue (fail -> Invalid); upgrades must be empty and a
  signature present; `closeTime > LCL.closeTime` (for LCL+1 and later
  slots); for LCL+1 when nominating also
  `closeTime <= now/1000 + MAX_TIME_SLIP_SECONDS`; then the signature must
  be valid (nodeID signed it; checked after the cheap checks);
  if `slot !== LCL+1` -> MaybeValid;
  tx set must be in the cache, `previousLedgerHash == LCL hash` and
  `checkTxSetValid` -> FullyValidated, else Invalid.
- `extractValidValue`: the value itself if FullyValidated, else null.
- `combineCandidates`: decode candidates; pick the one whose tx set has the
  most operations, then the highest total fee bid, then the smallest
  `sha256(txSetHash || sha256(all candidate values concatenated))`. Return
  that candidate unchanged (it keeps its nominator signature; CAP-34 style).
- `computeTimeout(round)`: `1000 * round` ms, capped at 30 s.
- Timers via `Clock`. Notifications feed monitoring (UI SCP views).

### 10.2 Tx queue (mempool)
- Admit with `checkValid` using `seqNumOverride = account.seqNum + queued(count)`
  and `pendingFees`. Up to 16 queued txs per source account, 2,000 total.
- Friendbot channels: on the channels this node makes its own friendbot
  requests on (the ones it owns, 11; every channel when it owns none),
  transactions from peers may hold at most `MAX_PEER_TXS_PER_CHANNEL` (4)
  of the 16 slots. More get `TRY_AGAIN_LATER` and are not banned. The other
  slots are for this node's own requests. On the other channels, peers'
  transactions (the requests of the channel's owner) may use all 16 slots,
  so that they reach every tx set.
- A tx with the same source and seqNum as a queued one is rejected
  (`TRY_AGAIN_LATER`) unless its fee is >= 10x (replace-by-fee).
- Flood accepted txs (`TRANSACTION`). Dedupe by hash. Remember recently
  rejected hashes briefly.
- After each ledger close: remove applied txs, re-validate the rest, drop
  invalid ones (emit `txStatus: dropped`), age out txs older than 50 ledgers.

### 10.3 Ledger trigger (nomination)
After the LCL changes (and only when `synced` and validating): schedule
`triggerNextLedger(LCL+1)` at `lastTriggerAt + LEDGER_TARGET_CLOSE_MS` (or now
if that is past). Build the tx set: `trimInvalid` on the queue, cap at
`maxTxSetSize` ops (and the DEX and friendbot lanes, 7.5) by fee rate,
with this node's own friendbot transactions first in the friendbot lane,
`makeTxSet(LCL hash, ...)`, cache it, flood
`TX_SET`. Value: `closeTime = max(floor(now/1000), LCL.closeTime + 1)`,
signed. Call `scp.nominate(LCL+1, value, encode(LCL.header.scpValue))`.

### 10.4 Incoming SCP envelopes (pending envelopes)
1. Decode, verify the signature, drop if the sender is unknown garbage.
   Drop a nomination with more than `MAX_NOMINATION_VALUES` (64) votes or
   accepted values: SCP checks every value of a leader's nomination.
2. Drop if `slot < LCL - MAX_SLOTS_TO_REMEMBER` or `slot > LCL + LEDGER_VALIDITY_BRACKET`.
3. Collect dependencies: quorum set hash(es) and tx set hashes of every value
   in the statement. Missing ones are requested (`GET_SCP_QUORUMSET`,
   `GET_TX_SET`) from the sender, then other peers; the envelope waits in a
   bounded pending buffer. When all dependencies arrive, feed
   `scp.receiveEnvelope`. Process envelopes of a slot in arrival order.
4. Envelopes for slots > LCL+1 are buffered (bounded) and never fed to SCP
   until the LCL catches up. We are "behind" when buffered future envelopes
   come from 2+ nodes or a v-blocking set, or when a peer announces a higher
   LCL. One ledger behind is resolved with `scpState`; more than one starts
   catch-up (section 12).
   Nominations for LCL+1 whose tx sets build on another ledger are dropped.
5. Answer `GET_TX_SET`/`GET_SCP_QUORUMSET` from caches (`DONT_HAVE` otherwise),
   and the `scpState` request with `scp.getCurrentState` for recent slots.
6. When a new peer connects, send it our latest envelopes for LCL+1.
7. While a slot is open, re-flood our latest envelopes every 2 s (helps late joiners).

### 10.5 Externalize -> close
`valueExternalized(slot, value)`:
- `slot == LCL+1`: get the tx set (it is in the cache: SCP only saw values
  whose tx sets we had), `ledger.closeLedger`, persist (`putLedger` + txs,
  snapshot every 64), update the queue, purge SCP slots below
  `LCL - MAX_SLOTS_TO_REMEMBER`, emit events, record `externalizedBy` = number
  of distinct validators whose CONFIRM or EXTERNALIZE for this slot we saw,
  update the quorum (auto mode), schedule the next trigger.
- `slot > LCL+1`: cannot happen, because such envelopes are never fed to SCP
  (10.4).
- `slot <= LCL`: compare with our stored scpValue; a mismatch is a fork (section 12.3).
- A catch-up can pause the herder after SCP externalized LCL+1 but before
  the close. When the herder is synced again, it closes that ledger (the
  trigger skips an externalized slot).

### 10.6 Quorum policy (`QuorumManager`)
Validator directory: per node id — name, lastHeard (verified SCP envelope or
status), lastSlot, synced flag and LCL from its status, its qset hash and
qset (fetched on demand), connected flag. `bye` marks it gone immediately.

Member book: the validators the node saw as active members on its own
chain, each with `since`, the lowest ledger of our chain at which it saw it.
A validator enters the book while it is active (auto mode below) with a
recent signed status whose LCL is our LCL or the one before, or with a
CONFIRM or EXTERNALIZE of the value we closed for a ledger (`since` = that
ledger). A status one ledger ahead, or on another branch, does not count. The book is persisted (meta `members`) and
holds at most 256 validators; the one active least recently goes first. A
resync clears it. Fork verdicts (12.3) and snapshot trust (12.2) count only
validators in this book.

Modes:
- **auto** (default): `active = self + validators heard within VALIDATOR_ACTIVE_MS that announce state 'synced', 'booting' or 'stalled', LCL within 1 of ours, and that take part in consensus`.
  A signed status alone does not make a validator active (obs-1: two
  validators that only sent statuses stalled a 5-node quorum with threshold
  4). A validator takes part when it sent a signed SCP envelope for a slot
  in [LCL-1, LCL+2] within VALIDATOR_ACTIVE_MS. It also takes part when it
  voted in our open slot (LCL+1, or LCL+2 when it is one ahead). In a stuck
  slot nobody sends anything new, and validators that voted in it must not
  drop each other. A validator first heard of within
  `PARTICIPATION_GRACE_MS` (5 s) counts without envelopes. Tabs that start
  at the same time see each other while they boot, before anybody votes,
  and must not each close ledgers alone. After the grace period a peer that
  does not vote (for example one still 'booting') does not count. A
  reconnect does not start a new grace period. The directory forgets a
  disconnected validator that it has not heard for 30 min.
  Peers known to be on another branch (forked, or announcing another hash
  for our LCL or LCL-1) are excluded. Validators heard only through
  relayed SCP messages count when their latest slot is within [LCL, LCL+2].
  `qset = { threshold: max(1, ceil(2n/3)), validators: sorted(active), innerSets: [] }`.
  Additions take effect at the next slot boundary (before triggering).
  Removals (departures) take effect immediately when a slot has made no
  progress for `4 s`, or right away after a `bye`:
  `scp.updateLocalQuorumSet(q)` (re-evaluates open slots), then
  `abandonBallot(LCL+1)`, else `restartNomination` (purge the open slot,
  restore our nomination, re-feed peers' statements), else
  `refreshNomination(LCL+1, freshValue)`, where `freshValue` is our signed
  StellarValue for the same tx set with `closeTime + 1`. Re-emitting the old
  statement does nothing, because peers learn a new quorum set only from a
  strictly newer statement.
  Watchers re-sync their set to the active validators on every quorum tick
  and never shrink it to only themselves.
  Known limitation: a node that changes its quorum set while balloting
  announces the new set only in its ballot statements; its nomination keeps
  the old set. When the old set has no slack among the live nodes and one of
  them is faulty, nodes still nominating can stall. Seen only with a
  Byzantine node in the SCP simulations.
  Known limitation: a validator that votes once in a slot and then only
  sends statuses stays active while that slot is stuck.
- **manual**: the user sets a qset (nested sets allowed). Never changes
  automatically.

Report `faultTolerance` and a quorum-intersection check (`intersection` in
`QuorumConfigView`): brute-force over the known validators' qsets when there
are at most 16 nodes, else 'unknown'. Port the idea of stellar-core's
`QuorumIntersectionChecker` (any two quorums intersect).

## 11. Node composition (`src/node`)

`Node` (in `src/node/node.ts`) wires: keys, `Storage`, `ILedgerManager`,
`Overlay`, `Herder`, `History`, `QuorumManager`, logger, events. Same code
runs in the browser worker and in the simulation (memory transport, memory
storage, virtual clock).

Lifecycle:
1. Open storage. Load or create the identity (secret in meta `identity`,
   name in meta `name`).
2. Ledger: latest local snapshot + replay of stored ledgers after it (or
   genesis if nothing is stored).
3. Start overlay. State `booting`.
4. Wait up to 4 s for peers. A node whose transports include WebRTC (the
   bridge) waits up to 12 s while it has seen no peer at all. Nostr
   signalling can take several seconds, and with 4 s two browsers often
   started separate chains. After the first peer shows up, the node waits
   1 s more, at most until the 4 s or 12 s mark. If a peer is ahead or on
   another branch: `catching-up`. If no peer appears: become `synced` alone
   (solo validator).
5. When synced: start SCP for LCL+1 (trigger), state `synced`.
6. `stalled`: synced but no ledger closed for 3 x target (shown in the UI).
7. The first trigger after becoming synced waits 1 s.

Meta keys: `identity`, `name`, `validating`, `quorum`, `scpState` and
`members` (the member book of 10.6: a list of `{ nodeId, since, last }`).
`scpState` holds our latest envelopes for the open slot. It is restored at
start, as stellar-core `persistSCPState` does, so a quick tab reload does not
vote differently in a slot it already voted in. Genesis is stored as
StoredLedger 1 with an empty placeholder tx set that is never replayed.

`NodeApi` is implemented in-process by `NodeService` (`src/node/service.ts`)
and exposed to the UI through a Web Worker (`src/node/worker.ts`) and an RPC
client (`src/node/client.ts`). The main thread (`src/node/boot.ts`):
- claims an identity slot `i = 0..63` with the Web Locks API
  (`navigator.locks.request('browserchain:<network>:slot:<i>', { ifAvailable: true }, ...)`,
  hold until the tab closes), so each tab of one browser is a distinct
  validator with a persistent key; `?fresh=1` uses an ephemeral identity
  and memory storage;
- starts the worker, passes `{ network, slot, fresh, name, transports }`;
- runs `TrysteroHost` and bridges it into the worker (unless `?transport=broadcast`);
- sends `bye` on `pagehide`;
- requests persistent storage and logs the result (already-persisted,
  granted, denied, unsupported or failed) with the storage estimate.

Friendbot (`friendbot(accountId)` in the node): each node funds from
channels it owns. Node i of the n sorted active validators owns channels c
with `c mod n == i`. A node that owns none (a watcher, or index 16 and
above) falls back to `hash(nodeId + counter) mod 16`. It uses the owned
channel with the fewest queued txs and takes seqNum from the ledger plus the
queue. It builds CreateAccount(10,000 XLM) if the account does not exist,
else a Payment, signs with the channel key and submits like any tx. When a
CreateAccount for the account is already queued, the Payment goes on that
channel right after it (7.3 keeps this top-up valid). A friendbot tx dropped
for txBAD_SEQ (or txINVALID from trimInvalid) is retried once under a new
hash; the original hash still reports 'dropped'. On the channels a node
owns, peers may queue only 4 of the 16 transactions (10.2). The node's own
friendbot transactions come first in the friendbot lane of the tx sets it
builds (7.5).

## 12. History, catch-up and forks (`src/history`)

### 12.1 Serving
Answer `headers`, `ledgers` (max 64 per request), `snapshot` (latest stored
snapshot <= requested seq; genesis can always be produced), `scpState`,
`branchWeight` from Storage and memory.

### 12.2 Catch-up
Triggered when a peer announces an LCL higher than ours + 1, when SCP shows
we are behind, or at boot.
1. Target: the highest LCL announced by synced validator peers, preferring
   the (seq, hash) announced by the most peers.
2. Check our LCL against the source: request header `ourLCL` from the source.
   Same hash -> replay from `ourLCL + 1`. Different -> fork (12.3).
3. Replay in batches of 64: `ledgers(from, to)`; for each ledger decode the tx
   set, `closeLedger(txSet, header.scpValue)`, and require the resulting
   header hash to equal the hash of the downloaded header. On mismatch, drop
   the source and retry with another peer.
4. A node far behind (or with no local chain) may start from the source's
   snapshot: verify the snapshot (5.7) and that its header links to the
   target through `headers` (previousLedgerHash chain), then replay.
5. Persist every replayed ledger (`externalizedBy = 0`). When at the target,
   ask peers for `scpState`, become `synced` and join consensus.

As built: the whole header chain from our LCL (or the snapshot) to the target
hash is verified before anything is applied. 'booting' peers are catch-up
sources only when no synced peer exists. A node that had a chain beyond
genesis (a rollback to genesis does not reset this; a resync does) catches
up by replay. It loads a snapshot only when no source has the ledgers to
replay and the target is vouched for. In manual mode a v-blocking set must
announce it. In auto mode at least 2 connected validators that the node saw
as active members at or before its LCL (10.6) must announce it, and they
must be more than the validators against it. Against: the node itself,
known validators that agree with its chain (LCL within one ledger), and
known validators that announce another ledger at the target seq. Identities
first seen later count for nothing. A node that never had a chain uses a
snapshot whenever a checkpoint above its LCL exists. One catch-up attempt
from one source has a budget of 30 s plus 5 s per 64 ledgers. In manual
mode a target counts only when a v-blocking set of the configured quorum set
announces it; a peer ahead on a chain that no such set announces gets a fork
check instead.

Hostile-peer guards: a node that closed a ledger within `stallMs`, with at
least one synced peer agreeing with its chain (LCL within one ledger), does
not catch up to a target unless more peers announce that target than agree
with it (itself included); it runs a fork check against the first announcing
peer instead. A source that times out or lacks data is sidelined for 15 s
only when another source exists; a single source is retried up to
`maxCatchupAttempts` times. A failed catch-up target is backed off for 15 s.

One behind: a catching-up node that finds the peers one ledger ahead lets
SCP finish the slot. Before that, one `headers` request checks that their
ledger builds on its LCL. A peer one ahead on another branch gets a fork
check at once. Without this check, a peer that lost the fork and rolled back
onto this node's chain left this node without a fork report.

Blocked catch-up: sometimes a node cannot reach a target announced by peers
it follows. The sources lack the ledgers and no snapshot is vouched for, no
source is usable, or every attempt failed. If such a node would vote alone,
it does not vote, because voting would build a branch of its own. It stays
catching-up, its status shows the target with source null, and it logs the
reason at most once a minute. Alone means: in manual mode, the quorum set
has a slice of only this node; in auto mode, no other validator is active
and no connected validator, in any state, announces an LCL on its chain
within one ledger. It tries again when a source is usable. It rejoins
consensus when no followed peer is more than one ledger ahead, or when a
validator on its chain appears. A resync starts it over from a snapshot. A
node that is not alone keeps voting with the validators on its chain. A
lone validator at work (synced, alone, and it closed a ledger by consensus
within `stallMs`) also keeps voting after a failed catch-up while it is
still on the same ledger, so one peer that announces a far-ahead ledger and
serves nothing cannot stop it. A node that comes back (reload, restart)
waits. While the node blocks itself, `NodeStatus.catchup.blocked` holds a
short reason for the UI, for example 'the peers ahead lack the ledgers after
8, and too few validators this node knew before vouch for their snapshot (0
for, 1 against)'. NodeService passes it with the status. A resync also
forgets the sources it sidelined and the targets it backed off on the wiped
chain. Those peers are the ones a fresh node catches up from.

A catch-up source whose ledgers do not replay to its own headers (diverged)
is treated like a fork winner that does not replay (12.3). It is marked as
on another branch, so it leaves the auto quorum and is not followed. It is
checked again only after it moves.

### 12.3 Forks
A fork exists when a peer's header at some seq differs from ours. Find the
fork point (last common seq) with `headers` requests (walk back in batches
of 64 from the lower LCL).
- **auto** mode: count the validators that vouch for each branch. A vouch
  is a signed status whose LCL is on that branch, from a connected validator
  that the node saw as an active member at or before ledger K (10.6). K is
  the fork point, or the `since` of the node's first member when that is
  later (a node that joined during a partition learned the older history
  from its members). Identities first seen after K count for nothing. Our
  count includes us. The branch with strictly more vouchers wins. On equal
  counts, compare branch weights after the fork point: the sum of
  `externalizedBy` per ledger over at most `MAX_BRANCH_WEIGHT_LEDGERS` (1024)
  ledgers, reported with `branchWeight` by up to 4 vouchers per side. The
  higher weight wins, then the lower hash of the first ledger after the fork
  point, then the higher LCL seq, then the lower LCL hash. Self-reported
  weights never outvote a difference in the counts. A node with an empty
  member book (it never saw another validator as an active member, for
  example two solo tabs that meet) has no quorum history to protect: the
  weights decide, as on equal counts. The loser truncates storage after the
  newest snapshot at or before the fork point, reloads the ledger from it,
  catches up from the winner, and re-queues its own discarded txs that are
  still valid; the others get txStatus 'dropped'. Emit a `fork`
  event either way. A fork check that repeats the last outcome for that peer
  emits no new event.
- **manual** mode: emit a `fork` event with `alert-only`. The user may press
  "Resync" (wipe chain, keep identity, catch up from peers).

As built (auto mode): branch weight is local data, so nodes on one branch
could disagree. To make every node of a branch reach the same verdict:
`externalizedBy` of recent ledgers is raised after later closes; each side's
weight is the max reported by up to 4 of its members; weights within
`max(2, 15%)` are a tie; a tie is broken by the lower hash of the first
ledger after the fork point. Rollback truncates after the fork point and
replays the common ledgers locally. A peer-reported branch weight is clamped
to (weighed ledgers after the fork point x known validators). A status is
placed on a branch by our chain or by the peer's LCL. A status ahead of us,
or at another ledger of their branch, is placed by the announcing node's
header after the fork point (one `headers` request). A winning branch that
does not replay to its own headers is not followed: the node reloads its
stored chain and checks that peer again only after it moves.

Strangers (V-2, V-4). A node with a member book never follows a branch that
only strangers vouch for. Locally, honest strangers look like Sybil
identities, so automatic merging stays off. Two groups that formed apart (no
node of one ever saw a node of the other as a member) keep their chains when
they meet. The node makes the fork visible instead. Sometimes a fork check
keeps ours although the connected validators on their branch that the node
did not know at ledger K are at least as many as our vouchers (us included).
Then the `fork` event has resolution 'kept-ours' and `unknownValidators` =
their count. A chain that the node cannot check counts too: no common ledger
is found, or the peers ahead lack the ledgers to replay and nobody it knew
vouches for their snapshot (12.2), and the node goes on with its own chain.
Alone it blocks instead (12.2). In this case at least 2 strangers are
needed, `atSeq` is the first ledger that they cannot show us, and
`theirHash` is empty (`ourHash` too while the node has not closed that
ledger). While such a fork lasts, the node checks those peers again every
10 s, also when their LCL stays. It reports the fork again at most every
10 s (`STRANGER_REPORT_MS`), so the UI can keep an alert fresh. `getForks`
keeps only the newest report of the fork. A resync (chain wiped, identity
kept, member book cleared) then joins the other group: the node catches up
from those peers as a fresh node.

## 13. Simulation (`src/sim`)
`Simulation` creates N `Node`s on one `VirtualClock`, a `MemoryNetwork` and
`MemoryStorage`s, all from a seed. Controls: add/remove/restart nodes,
latency profiles, drop rate, partitions, submit txs, Byzantine node (sends
conflicting signed nominations / statements). Assertions: safety (all nodes
have identical header hashes for every seq they share), liveness (LCL
advances), catch-up, fork resolution. Scenario tests run in `vitest`.
A node can get a transport kind (`SimNodeSpec.transportKind`). The default
'memory' acts like BroadcastChannel; 'bridge' models a WebRTC tab. A
partition that heals later models slow signalling at boot.

## 14. UI (`src/ui`)
React app with a `NodeApi` (real client or `?mock=1` mock). Screens:
Overview (live ledger close, SCP phase stepper with per-validator states,
quorum graph, recent ledgers and txs, stats), Validator (identity, quorum
config auto/manual with intersection status, SCP slot inspector and message
log, validating toggle, resync), Explorer (ledgers, ledger detail, tx
detail with decoded XDR, accounts, assets, search), Wallet (local keypairs,
friendbot, balances, send, trustlines, issue an asset, DEX trade with order
book, claimable balances), Lab (decode/sign/submit XDR), About (how SCP
works here and what is simplified). Hash routing (`#/ledger/12`). Works at
375 px width. Dark theme with a light option.

- Wallet keys and the wallet activity list live in localStorage, shared by
  every tab of the browser. The activity list (`{ items, clearedAt }`) merges
  by tx hash, so no tab drops entries another tab added, and Clear clears
  every tab. Tabs follow each other's changes through 'storage' events
  (`src/ui/lib/activity.ts`).
- The Overview warns when consensus is stalled and names the quorum members
  that are offline. It also warns when the tab is the only validator. The
  consensus card never shows nomination round 0: before this node
  nominates, it says so.
- A manual-mode fork ('alert-only') shows an alert on the Overview and the
  Validator page while this node is in sync and the forked peer is connected
  and not active in the node's directory. A 'rolled-back' fork event shows a
  notice for 60 s and clears the UI's tx statuses from the dropped ledgers,
  so the wallet never shows a rolled-back tx as applied.
- A fork report with `unknownValidators` (12.3) has its own alert on the
  Overview and the Validator page: validators this node did not know before
  run another chain, and this tab keeps its own. It shows while the node is
  in sync, the newest report is at most 40 s old (`STRANGER_FORK_FRESH_MS`),
  and the node still has its side of the fork (an empty `ourHash` counts as
  still having it). A report from before a resync that this UI started does
  not show. The alert offers Resync and says to do it in every tab of the
  browser that shows the alert.
- A node whose status has `catchup.blocked` (12.2) shows as 'Blocked', never
  'synced': in the header pill, the ledger hero, the quorum graph, the "This
  node" card and the validator lists. A notice on the Overview and the
  Validator page says that the node does not vote, gives the reason and
  offers Resync.
- Resync asks for confirmation in a dialog in the page.
  `?mock=1&demo=strangers` and `?mock=1&demo=blocked` make the demo play
  these two states; a resync ends either.
- About states what BrowserChain is: a TypeScript reimplementation of SCP and
  the classic ledger on real Stellar XDR. It is not stellar-core and cannot
  talk to Stellar nodes. It lists the section 15 simplifications and says
  what is simulated: the `?mock=1` demo, auto quorum and rollbacks, and play
  money. It says that the root account is locked and that a friendbot
  channel only sends 10,000 XLM per transaction (section 4, 7.3). It lists
  the known limits of section 15.
- Wide tables scroll inside their card. A table wider than its card (for
  example at 375 px) shows a "Scroll sideways" hint, and the side that hides
  columns fades out (`TableWrap`).
- The tx page shows `sendAmountSent` as "Amount sent" and `createdOfferId` as
  "New offer ID". The short operation descriptions of the feeds add them
  ("sent 27.5 XLM", "new offer #12").

## 15. Simplifications vs Stellar
- No Soroban, no liquidity pools, no sponsorship ops, no inflation, no surge pricing.
- Flat state hash instead of the BucketList; skip list not maintained.
- History comes from peers (no history archives); checkpoints every 64 ledgers.
- No per-message HMAC (stellar-core uses ECDH session keys and a MAC on
  every message). A WebRTC link is authenticated once by a signed hello that
  covers the link nonce and the DTLS channel; DTLS protects the rest of the
  channel. BroadcastChannel links are same-origin. Announcements and every
  consensus message are signed end to end.
- Auto quorum mode adapts to who is online; it favors liveness over safety
  under network partitions (forks are detected and resolved). Manual mode
  keeps SCP's classic guarantees for the configured quorum.

Known limits (open):
- Open membership. In auto mode any key can join as a validator. A status
  alone does not make a validator an active member: it must take part in
  consensus (10.6). A validator that votes once in a slot and then only
  sends statuses stays active while that slot is stuck. Fork verdicts count
  only validators the node knew before the fork (12.3). So validators that
  join after a fork cannot decide it, but colluding validators that
  outnumber the honest ones before a fork can. Two groups that formed apart
  do not merge on their own: they keep their own chains when they meet. A
  node reports the other group when that group is at least as large as its
  own side (12.3). A node whose known validators are gone does not trust a
  snapshot from strangers (12.2): alone it waits and says why in its
  status; with others like it, it votes on its own branch and reports the
  strangers. A resync moves a node to the other chain.
- Public friendbot keys. Anyone can sign for the channels. The channel
  policy (7.3) and the friendbot lane (7.5) cap the drain at 160,000 XLM per
  ledger, so the faucet can still be drained slowly: its 16 billion XLM last
  about 100,000 ledgers (about 6 days). A channel transaction that can only
  fail (a create of an existing account, a payment to a missing one) is
  invalid (7.3). Anyone can still fill the lane every ledger without
  draining the channels: a channel payment to the same channel or to
  another channel, or a chain whose earlier transaction makes the later
  channel transactions fail when applied (a BumpSequence, or the attacker's
  own create of the destination). A node's own friendbot requests still get
  in: on its channels, peers may hold only 4 of the 16 queue slots (10.2),
  and the node puts its own requests first in the lane of the tx sets it
  builds (7.5). They wait until a tx set built by that node wins.
- Nomination stall (SCP-7). When validators leave and one of the remaining
  validators is Byzantine, nomination can stall in some runs (10.6).
