import { Activity, ArrowLeftRight, Download, Droplets, Gift, KeyRound, Link2, Send, Sparkles, TriangleAlert, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, Notice, PageHeader, Skeleton, TabLinks } from '../components/ui';
import { href, type WalletTab } from '../lib/route';
import { createKey, nextDefaultName } from '../lib/wallet';
import { useClock, useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { AccountPanel } from './AccountPanel';
import { ActivityPanel } from './ActivityPanel';
import { ClaimPanel } from './ClaimPanel';
import { IssueWizard } from './IssueWizard';
import { ImportDialog, KeysCard } from './KeysCard';
import { SendForm } from './SendForm';
import { useAccount } from './shared';
import { TradePanel } from './TradePanel';
import { TrustPanel } from './TrustPanel';

function Onboarding() {
  const { keys, addKey, fund } = useWallet();
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <Card>
      <EmptyState
        icon={KeyRound}
        title="No test accounts in this browser yet"
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              icon={Droplets}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const k = createKey(nextDefaultName(keys), clock.now());
                  addKey(k);
                  await fund(k.publicKey);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create a test account
            </Button>
            <Button icon={Download} onClick={() => setImporting(true)}>
              Import a secret key
            </Button>
          </div>
        }
      >
        A new key is created here and funded by friendbot with 10,000 test XLM. It takes one ledger, about 5 seconds.
      </EmptyState>
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </Card>
  );
}

export function WalletPage({ tab }: { tab: WalletTab }) {
  const { keys, selected, storageOk, network } = useWallet();
  const ready = useNodeState((s) => s.status !== null);
  const account = useAccount(selected?.publicKey ?? null);

  return (
    <div>
      <PageHeader title="Wallet" icon={Wallet} description="Test keys that live in this browser. Send payments, issue an asset, trade on the DEX and claim balances." />
      <Notice tone="warn" icon={TriangleAlert} title="Test network only" className="mb-5">
        Secret keys are kept unencrypted in this browser’s local storage{network ? ` for the “${network}” network` : ''}. The XLM here has no value. Never paste a real secret key.
        {!storageOk ? ' Storage is blocked in this browser, so keys disappear when you reload.' : ''}
      </Notice>
      {!ready ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : keys.length === 0 || !selected ? (
        <Onboarding />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-4">
            <KeysCard />
          </div>
          <div className="flex min-w-0 flex-col gap-4 sm:gap-5 lg:col-span-8">
            <AccountPanel key={`${selected.publicKey}:panel`} wallet={selected} account={account.data ?? null} loading={account.loading} />
            <TabLinks
              label="Wallet actions"
              active={tab}
              tabs={[
                { id: 'send', href: href.wallet('send'), label: 'Send', icon: Send },
                { id: 'trust', href: href.wallet('trust'), label: 'Trustlines', icon: Link2 },
                { id: 'issue', href: href.wallet('issue'), label: 'Issue asset', icon: Sparkles },
                { id: 'trade', href: href.wallet('trade'), label: 'Trade', icon: ArrowLeftRight },
                { id: 'claim', href: href.wallet('claim'), label: 'Claimable', icon: Gift },
                { id: 'activity', href: href.wallet('activity'), label: 'Activity', icon: Activity },
              ]}
            />
            {tab === 'activity' ? (
              <ActivityPanel />
            ) : account.loading && !account.data ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : !account.data ? (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-fg-3">These tools work once the account exists on the network.</p>
            ) : tab === 'send' ? (
              <SendForm key={`${selected.publicKey}:tab`} wallet={selected} account={account.data} />
            ) : tab === 'trust' ? (
              <TrustPanel key={`${selected.publicKey}:tab`} wallet={selected} account={account.data} />
            ) : tab === 'issue' ? (
              <IssueWizard key={`${selected.publicKey}:tab`} wallet={selected} account={account.data} />
            ) : tab === 'trade' ? (
              <TradePanel key={`${selected.publicKey}:tab`} wallet={selected} account={account.data} />
            ) : (
              <ClaimPanel key={`${selected.publicKey}:tab`} wallet={selected} account={account.data} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
