import {
  ArrowRight,
  BookOpen,
  CheckCheck,
  Cpu,
  Database,
  FlaskConical,
  Globe,
  Layers,
  MonitorSmartphone,
  Radio,
  ShieldCheck,
  Split,
  Timer,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, cx, PageHeader } from '../components/ui';
import { PHASES } from '../overview/phases';

function Box({ icon: Icon, title, children, tone }: { icon: LucideIcon; title: string; children: ReactNode; tone: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-raised p-4">
      <div className="flex items-center gap-2">
        <span className={cx('inline-flex size-8 items-center justify-center rounded-lg', tone)}>
          <Icon aria-hidden className="size-4" />
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="mt-2 text-sm text-fg-2">{children}</div>
    </div>
  );
}

function Arrow() {
  return (
    <div aria-hidden className="flex items-center justify-center text-fg-3 lg:px-1">
      <ArrowRight className="size-5 rotate-90 lg:rotate-0" />
    </div>
  );
}

function List({ items, icon: Icon, iconClass }: { items: ReactNode[]; icon: LucideIcon; iconClass: string }) {
  return (
    <ul className="space-y-2.5 text-sm text-fg-2">
      {items.map((r, i) => (
        <li key={i} className="flex gap-2.5">
          <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', iconClass)} />
          <span className="min-w-0">{r}</span>
        </li>
      ))}
    </ul>
  );
}

/** Five validators, each trusting 4 of 5: any two quorums share at least three nodes. */
function QuorumPicture() {
  const pts = Array.from({ length: 5 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    return { x: 110 + Math.cos(a) * 72, y: 98 + Math.sin(a) * 72 };
  });
  const quorumA = [0, 1, 2, 3];
  const quorumB = [1, 2, 3, 4];
  return (
    <svg viewBox="0 0 220 200" className="mx-auto h-auto w-full max-w-[260px]" role="img" aria-label="Five validators. Two example quorums of four overlap in three validators.">
      {pts.map((p, i) =>
        pts.slice(i + 1).map((q, j) => <line key={`${i}-${j}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--bc-line-strong)" strokeWidth={1} />),
      )}
      <polygon points={quorumA.map((i) => `${pts[i].x},${pts[i].y}`).join(' ')} fill="var(--bc-consensus)" fillOpacity={0.1} stroke="var(--bc-consensus)" strokeWidth={1.5} />
      <polygon points={quorumB.map((i) => `${pts[i].x},${pts[i].y}`).join(' ')} fill="var(--bc-network)" fillOpacity={0.1} stroke="var(--bc-network)" strokeWidth={1.5} />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={13} fill="var(--bc-panel)" stroke={i >= 1 && i <= 3 ? 'var(--bc-ledger-fill)' : 'var(--bc-fg-3)'} strokeWidth={2} />
          <text x={p.x} y={p.y + 4} textAnchor="middle" className="fill-fg text-[11px] font-semibold">
            {String.fromCharCode(65 + i)}
          </text>
        </g>
      ))}
    </svg>
  );
}

const STEPS: { title: string; body: string; icon: LucideIcon }[] = [
  { title: 'Trigger', body: 'About 5 s after the last ledger, each validator puts queued transactions into a transaction set.', icon: Timer },
  { title: 'Nominate', body: 'Round leaders propose values (a tx set and a close time). Validators vote until some candidates are confirmed.', icon: PHASES[0].icon },
  { title: 'Prepare', body: 'The candidates are combined into one value in a ballot. Validators accept, then confirm, that the ballot is prepared.', icon: PHASES[1].icon },
  { title: 'Confirm', body: 'Validators accept to commit the ballot. From here a validator cannot change its value for this ledger.', icon: PHASES[2].icon },
  { title: 'Externalize', body: 'The commit is confirmed: the value is final. Each validator applies the same tx set and gets the same ledger hash.', icon: PHASES[3].icon },
];

const WHAT_IT_IS: ReactNode[] = [
  <>
    <strong className="text-fg">Consensus:</strong> a TypeScript port of stellar-core’s SCP code (Apache-2.0): nomination, the ballot protocol and the quorum checks. Its
    tests port scenarios from stellar-core’s SCP tests, and the code was checked against the IETF SCP draft.
  </>,
  <>
    <strong className="text-fg">Ledger:</strong> a TypeScript reimplementation of the classic Stellar ledger at protocol 23: accounts, signers and thresholds, payments,
    trustlines, the DEX and claimable balances, with stellar-core’s validity checks and result codes.
  </>,
  <>
    <strong className="text-fg">Data:</strong> real Stellar XDR from the official JavaScript SDK. Transactions, SCP envelopes, quorum sets, ledger headers and results decode with
    any Stellar XDR tool.
  </>,
  <>
    <strong className="text-fg">Not stellar-core:</strong> no stellar-core code runs in your browser, and BrowserChain nodes cannot talk to Stellar nodes. The peer protocol,
    the history format and the state hash are BrowserChain’s own.
  </>,
];

const SAME_AS_STELLAR: ReactNode[] = [
  'Accounts are G… keys with ed25519 signatures, sequence numbers, thresholds and signers.',
  'XLM has 7 decimals, a 100-stroop base fee and a 0.5 XLM base reserve.',
  'Transactions apply in stellar-core’s legacy order: fees first, then each transaction, all operations or none.',
  'Offers cross with price-time priority and the same rounding as stellar-core at protocol 23.',
  'Each ledger closes on a value agreed through SCP: a StellarValue with the tx set hash and the close time, signed by the validator that nominated it.',
];

// docs/ARCHITECTURE.md section 15, plus the unsupported features users run into.
const SIMPLIFIED: ReactNode[] = [
  'No Soroban smart contracts, no liquidity pools, no sponsorship operations, no inflation and no surge pricing.',
  'Only v1 transaction envelopes: fee-bump and v0 envelopes, and the newer v2 preconditions (minimum sequence age or ledger gap, extra signers), give txNOT_SUPPORTED. There are no protocol upgrades.',
  'A flat state hash replaces the BucketList, and the ledger skip list is not maintained. So ledger hashes differ from what stellar-core would compute.',
  'History comes from peers instead of history archives. Checkpoints happen every 64 ledgers.',
  'There is no overlay authentication handshake (HMAC). Instead every announcement and every consensus message is signed.',
  'Auto quorum mode adapts to who is online. Under a network partition it favors liveness over safety: forks can happen, and they are detected and resolved. Manual mode keeps SCP’s classic guarantees for the quorum you configure.',
];

const SIMULATED: ReactNode[] = [
  <>
    <strong className="text-fg">The network, not the consensus.</strong> Validators are browser tabs that come and go, on BrowserChain’s own network (passphrase “BrowserChain
    Network ; October 2026”). The SCP messages, ledgers and signatures between them are real.
  </>,
  <>
    <strong className="text-fg">Auto quorum and fork resolution are BrowserChain additions.</strong> Stellar validators choose their quorum sets by hand, and a closed Stellar ledger
    is never rolled back. Here, in auto mode, a node drops its branch of a fork when more of the validators it knew before the fork are on the other branch
    (on a tie, the heavier branch wins).
  </>,
  <>
    <strong className="text-fg">The money.</strong> XLM here has no value. The root account and the friendbot accounts come from the network passphrase, so anyone can
    derive their keys. That is why the root account is locked: nothing it signs is valid. A friendbot account can only send 10,000 XLM per transaction, as one new
    account or one XLM payment.
  </>,
  <>
    <strong className="text-fg">The demo (?mock=1).</strong> The demo runs no consensus: a script in the page plays the validators and their SCP messages, makes up traffic, and
    applies your transactions to a simplified ledger. Add &amp;demo=strangers to see a group of validators this tab does not know on another chain, or
    &amp;demo=blocked to see a tab that cannot catch up safely and does not vote.
  </>,
];

// docs/ARCHITECTURE.md section 15, "Known limits".
const LIMITS: ReactNode[] = [
  <>
    <strong className="text-fg">Open membership.</strong> In auto mode anyone can join as a validator. Only the validators a node knew before a fork can decide it,
    so validators that join later cannot. Colluding validators that outnumber the honest ones before a fork can. For the same reason, two groups of tabs that
    built their chains apart do not merge on their own when they meet, and a tab that comes back after all the validators it knew have left does not join the
    chain of the new ones. A tab shows an alert when the other group is at least as large as its own, and a tab that cannot catch up safely says why it does
    not vote. Press Resync in that alert, or on the Validator page, to join the other chain.
  </>,
  <>
    <strong className="text-fg">Public friendbot keys.</strong> Anyone can sign for the friendbot accounts. At most 16 friendbot transactions fit in a ledger, so
    draining the faucet takes about 6 days, but it can be done. Anyone can also fill those 16 places in every ledger. A tab still puts its own friendbot requests
    first in the transaction sets it proposes, so during such an attack a request waits until a set from that tab is chosen.
  </>,
  <>
    <strong className="text-fg">Stalls after departures.</strong> When validators leave and one of the remaining validators misbehaves, nomination can stall in
    some runs.
  </>,
];

export function AboutPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="How BrowserChain works"
        icon={BookOpen}
        description="BrowserChain is a TypeScript reimplementation of the Stellar Consensus Protocol (SCP) and the classic Stellar ledger, built on real Stellar XDR. Every open tab is a validator. It is not stellar-core running in the browser, and it is not connected to the Stellar network."
      />

      <div className="flex flex-col gap-5">
        <Card title="What it is" icon={Layers} iconClass="text-ledger">
          <List items={WHAT_IT_IS} icon={CheckCheck} iconClass="text-ledger" />
        </Card>

        <Card title="What runs where" icon={Cpu} iconClass="text-ledger">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
            <Box icon={MonitorSmartphone} title="This tab" tone="bg-ledger-fill/12 text-ledger">
              The interface you are using. Wallet keys live here and sign transactions before they go to the node.
            </Box>
            <Arrow />
            <Box icon={Cpu} title="A Web Worker" tone="bg-consensus/12 text-consensus">
              The validator itself: SCP, the transaction queue, the ledger and the DEX. It stores ledgers in IndexedDB, so it restarts where it stopped (not with{' '}
              <span className="font-mono text-xs">?fresh=1</span>).
            </Box>
            <Arrow />
            <Box icon={Radio} title="Other validators" tone="bg-network/12 text-network">
              Tabs of this browser talk over a <span className="font-mono text-xs">BroadcastChannel</span>. Other browsers connect peer to peer over WebRTC; they find each other
              through public Nostr relays.
            </Box>
          </div>
          <p className="mt-4 text-sm text-fg-3">
            There is no BrowserChain server: the site is static files. Open a second tab and you have a second validator with its own key. Close it and, in auto quorum
            mode, the others notice within seconds and adjust their quorum.
          </p>
        </Card>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
          <Card title="Quorum slices" icon={Users} iconClass="text-consensus" className="lg:col-span-3">
            <div className="flex flex-col gap-4 text-sm text-fg-2 sm:flex-row">
              <div className="min-w-0 flex-1 space-y-3">
                <p>
                  Each validator picks the validators it trusts and how many of them must agree. That choice is its <strong className="text-fg">quorum set</strong>, for example
                  “any 4 of these 5”. Each group that satisfies it is a <strong className="text-fg">quorum slice</strong>.
                </p>
                <p>
                  A <strong className="text-fg">quorum</strong> is a group of validators that contains a slice of each of its members. A statement that a quorum agrees on can be
                  trusted by all of them.
                </p>
                <p>
                  Safety needs <strong className="text-fg">quorum intersection</strong>: any two quorums share at least one honest validator. The Validator page checks
                  intersection for the validators this node knows.
                </p>
              </div>
              <div className="w-full shrink-0 sm:w-56">
                <QuorumPicture />
                <p className="mt-1 text-center text-xs text-fg-3">
                  Quorums <span className="text-consensus">ABCD</span> and <span className="text-network">BCDE</span> overlap in B, C and D.
                </p>
              </div>
            </div>
          </Card>
          <Card title="Federated voting" icon={CheckCheck} iconClass="text-consensus" className="lg:col-span-2">
            <ol className="space-y-3 text-sm text-fg-2">
              <li>
                <strong className="text-fg">Vote</strong> for a statement you consider valid.
              </li>
              <li>
                <strong className="text-fg">Accept</strong> it when a quorum voted for it, or when a set that blocks all your slices already accepted it.
              </li>
              <li>
                <strong className="text-fg">Confirm</strong> it when a quorum accepted it. Confirmed statements are final.
              </li>
            </ol>
            <p className="mt-4 text-xs text-fg-3">SCP runs this vote → accept → confirm loop first on candidate values (nomination), then on ballots.</p>
          </Card>
        </div>

        <Card title="One ledger, about every 5 seconds" icon={Timer} iconClass="text-ledger">
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-xl border border-line bg-raised p-3">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex size-7 items-center justify-center rounded-full text-canvas"
                    style={{ backgroundColor: i === 0 ? 'var(--bc-ledger-fill)' : PHASES[i - 1].color }}
                  >
                    <s.icon aria-hidden className="size-3.5" />
                  </span>
                  <h3 className="text-sm font-semibold">{s.title}</h3>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-fg-2">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-fg-3">
            Watch this live on the Overview page: the phase stepper shows the latest statement of each validator, and the SCP log on the Validator page lists every message.
          </p>
        </Card>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card title="Same as Stellar" icon={ShieldCheck} iconClass="text-ok">
            <List items={SAME_AS_STELLAR} icon={CheckCheck} iconClass="text-ok" />
          </Card>
          <Card title="What is simplified" icon={Split} iconClass="text-warn">
            <List items={SIMPLIFIED} icon={Layers} iconClass="text-warn" />
          </Card>
        </div>

        <Card title="What is simulated" icon={FlaskConical} iconClass="text-consensus">
          <List items={SIMULATED} icon={FlaskConical} iconClass="text-consensus" />
        </Card>

        <Card title="Known limits" icon={TriangleAlert} iconClass="text-warn">
          <List items={LIMITS} icon={TriangleAlert} iconClass="text-warn" />
        </Card>

        <Card title="Play money" icon={Database}>
          <div className="flex flex-col gap-3 text-sm text-fg-2 sm:flex-row sm:items-center sm:justify-between">
            <p>
              BrowserChain is a learning and demo network. Its XLM has no value, friendbot hands it out freely, and wallet keys sit unencrypted in your browser. Never use a
              real Stellar secret key here.
            </p>
            <Globe aria-hidden className="hidden size-10 shrink-0 text-fg-3 sm:block" />
          </div>
        </Card>
      </div>
    </div>
  );
}
