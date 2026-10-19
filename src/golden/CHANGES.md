# Golden vector changes

Each regeneration of `vectors.json` adds an entry here: the date, the groups
that changed and the reason. Add new entries at the end.

## 2026-10-17

182 values changed in 5 groups. Groups 2 (strkey), 3 (transactions),
5 (stellarValue) and 6 (scp) did not change.

- 1 genesis (10 values): the genesis root account is locked (master weight 0).
  The root entry, the state hash and the header hash changed on both networks.
- 4 ledgerClose (137 values): the new genesis hash changes every tx set hash,
  apply order and header. The root cannot sign and the channel policy limits
  channel transactions, so the generator changed. In ledger 2, channels 0-4
  create the five accounts with 10,000 XLM each and channel 5 pays the root
  10,000 XLM. In ledger 6, the issuer sends the transaction the root sent.
  The other transactions and result codes did not change. Only their apply
  order and the offer ids changed.
- 7 overlay (6 values): APP_VERSION is 2, so the announcement JSON, hash and
  signature changed. The TX_SET, GET_TX_SET and DONT_HAVE messages carry the
  new genesis hash or the hash of a tx set built on it.
- 8 simulation (26 values): every ledger hash changed (new genesis). The 4
  friendbot tx hashes changed: each node now uses a friendbot channel that it
  owns. Close times and tx counts did not change.
- 9 checkpoint (3 values): the header, state and snapshot hashes at ledger 64
  follow from the changes above. The entry count did not change.

Check: a copy of the code without the root lock, APP_VERSION 2, the channel
ownership, the channel policy and the generator change passed all 16 golden
tests against the old vectors. The DEX cap and the SCP, herder and overlay
changes of this stage do not change a vector.

## 2026-10-18

3 values changed in 1 group. Groups 1-6, 8 and 9 did not change.

- 7 overlay (3 values): APP_VERSION is 3. The announcement JSON differs only
  in `appVersion` (2 became 3), so its hash and signature changed too.
  Version 3 adds two ledger rules: a tx set holds at most
  `MAX_FRIENDBOT_TXS_IN_TX_SET` (16) transactions that use a friendbot
  channel, and a channel transaction bids exactly the base fee. A version 2
  node accepts tx sets and ledgers that a version 3 node rejects, so the two
  must not bind.

Check: the SHA-256 of the old announcement JSON with `"appVersion":3` equals
the new hash. The friendbot rules, the member book, the fork verdict by
vouchers and the catch-up changes of this stage do not change a vector:
groups 4, 8 and 9 pass unchanged.

## 2026-10-19: APP_VERSION 4

3 values changed in 1 group. Groups 1-6, 8 and 9 did not change.

- 7 overlay (3 values): APP_VERSION is 4. The announcement JSON differs only
  in `appVersion` (3 became 4), so its hash and signature changed too.
  Version 4 adds a ledger rule: a channel CreateAccount must create a new
  account, and a channel Payment must pay an existing one. A version 3 node
  accepts txs that a version 4 node rejects, so the two must not bind.

Check: the SHA-256 of the old announcement JSON with `"appVersion":4` equals
the new hash. The stranger-fork reports, the 12 s WebRTC boot wait, the SCP
participation rule and the friendbot queue changes of this stage do not
change a vector.
