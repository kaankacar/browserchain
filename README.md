# BrowserChain

A Stellar-like blockchain that runs entirely in the browser. Every open tab is
a validator: it keeps the ledger, votes in the Stellar Consensus Protocol (SCP)
and serves history to its peers. There is no server.

BrowserChain is a TypeScript reimplementation of SCP and the classic Stellar
ledger. The consensus and ledger logic is ported from stellar-core, and all
data uses real Stellar XDR (`@stellar/stellar-sdk`). It is not stellar-core
and cannot talk to Stellar nodes. All XLM on it is play money.

## Run it

```sh
npm install
npm run dev
```

Open http://localhost:5173 in two or three tabs. The tabs find each other,
agree on a quorum and close a ledger about every 5 seconds. On the Wallet page,
fund an account with friendbot and send a payment; the other tabs see it in the
next ledger.

To join from other machines, build the app (`npm run build`), serve `dist/`
from any static host, and open it on each machine.

- Tabs in one browser talk over BroadcastChannel.
- Browsers on different machines connect over WebRTC. They find each other
  through public Nostr relays (Trystero), so no signalling server is needed.
- Each tab claims an identity slot with Web Locks. Close a tab and open it
  again: it comes back as the same validator with its stored chain
  (IndexedDB) and catches up.
- A tab that finds no peer waits up to 12 s (4 s with
  `?transport=broadcast`), then starts a chain alone.
- Two groups of tabs that built their chains apart do not merge on their
  own. A tab shows an alert when the other group is at least as large as its
  own; press Resync in the alert to join it.

| URL parameter | Effect |
|---|---|
| `?network=<name>` | Join another network, with its own passphrase and genesis. |
| `?fresh=1` | Use a new identity and in-memory storage for this tab. |
| `?transport=broadcast\|webrtc\|both` | Choose the transports. The default is `both`. |
| `?name=<name>` | Set the validator name that peers see. |
| `?mock=1` | Show the UI on simulated data, without a node. |
| `?mock=1&demo=strangers\|blocked` | Show a fork with validators this tab does not know, or a tab that cannot catch up safely and does not vote. |

## What it implements

- **SCP**: nomination and ballot protocol, ported from stellar-core `src/scp`
  together with its test scenarios.
- **Ledger**: accounts, sequence numbers, fees and reserves, multisig
  (ed25519, pre-auth tx, hash-x), trustlines and authorization flags,
  payments, the order-book DEX with path payments, claimable balances,
  clawback and data entries.
- **Herder**: transaction queue, tx sets, nomination trigger, ledger close,
  and quorum management (auto or manual).
- **History**: catch-up by replay or checkpoint snapshot, and fork detection
  and resolution.
- **Runtime**: one Web Worker per tab runs the node; the page only renders.
- **UI**: live consensus overview, validator page, explorer, wallet and an XDR
  lab.

## Tests

```sh
npm test                                 # vitest: unit, simulation and golden tests
npx playwright install chromium          # once
caffeinate -is npm run e2e               # Playwright in a real browser
E2E_WEBRTC=1 npx playwright test e2e/webrtc.spec.ts   # real WebRTC over public relays
```

- `caffeinate -is` keeps a Mac awake. A sleeping Mac pauses every tab and the
  timing-based specs fail.
- `E2E_PORT=<port>` gives a run its own port, build folder and results.
- `E2E_SLOW=1` adds the large-state spec (about 6 minutes).
- `src/golden` holds byte-exact vectors for consensus data. Read
  `src/golden/CHANGES.md` before you regenerate them.

## Docs

- `docs/ARCHITECTURE.md`: the design, the data formats and every rule.
- Section 15 of that file lists what is simplified compared to Stellar, and
  the known limits.

## Credits

The SCP and ledger logic is ported from stellar-core (Apache-2.0). See
`NOTICE`.
