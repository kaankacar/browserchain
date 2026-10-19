import { CircleCheck, CircleX, Droplets, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { AccountView, AssetView } from '../../node/api';
import { Button, Notice } from '../components/ui';
import { useAsync, type AsyncState } from '../hooks/useAsync';
import { assetKey, humanizeCode, stroopsToAmount, tryAmountToStroops } from '../lib/format';
import { href } from '../lib/route';
import type { WalletKey } from '../lib/wallet';
import { useApi, useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';

/** The selected key's account, refreshed after every ledger close. */
export function useAccount(publicKey: string | null): AsyncState<AccountView | null> {
  const api = useApi();
  const closeCounter = useNodeState((s) => s.closeCounter);
  return useAsync(() => (publicKey ? api.getAccount(publicKey) : Promise.resolve(null)), [publicKey, api, closeCounter]);
}

/** Spendable amount of an asset (balance minus selling liabilities; XLM also minus the reserve). */
export function spendable(acc: AccountView, asset: AssetView): string {
  if (asset.type === 'native') return acc.availableBalance;
  const line = acc.balances.find((b) => assetKey(b.asset) === assetKey(asset));
  if (!line) return '0.0000000';
  const b = tryAmountToStroops(line.balance) ?? 0n;
  const s = tryAmountToStroops(line.sellingLiabilities) ?? 0n;
  return stroopsToAmount(b > s ? b - s : 0n);
}

export function hasTrust(acc: AccountView | null, asset: AssetView): boolean {
  if (asset.type === 'native') return true;
  if (!acc) return false;
  if (asset.issuer === acc.accountId) return true;
  return acc.balances.some((b) => assetKey(b.asset) === assetKey(asset));
}

/** Live status of one submitted transaction. */
export function TxStatusLine({ hash, className }: { hash: string; className?: string }) {
  const s = useNodeState((st) => st.txStatus[hash] ?? null);
  const base = `flex flex-wrap items-center gap-1.5 text-sm ${className ?? ''}`;
  if (!s || s.status === 'pending')
    return (
      <p className={base} role="status">
        <LoaderCircle aria-hidden className="size-4 animate-spin text-warn" />
        <span className="text-fg-2">Pending: waiting for the next ledger…</span>
      </p>
    );
  if (s.status === 'applied')
    return (
      <p className={base} role="status">
        <CircleCheck aria-hidden className="size-4 text-ok" />
        <span className="text-fg">Applied in ledger #{s.ledgerSeq?.toLocaleString('en-US')}.</span>
        <a href={href.tx(hash)} className="font-medium text-ledger hover:underline">
          View transaction
        </a>
      </p>
    );
  return (
    <p className={base} role="status">
      {s.status === 'dropped' ? <TriangleAlert aria-hidden className="size-4 text-warn" /> : <CircleX aria-hidden className="size-4 text-bad" />}
      <span className="text-fg">
        {s.status === 'dropped' ? 'Dropped from the queue.' : 'Failed'}
        {s.resultCode ? `: ${humanizeCode(s.resultCode)}` : ''}
      </span>
      {s.status === 'failed' && s.ledgerSeq ? (
        <a href={href.tx(hash)} className="font-medium text-ledger hover:underline">
          Details
        </a>
      ) : null}
    </p>
  );
}

/** Hash of a pending friendbot funding for this account, if any. */
export function usePendingFunding(publicKey: string): string | null {
  const { activity } = useWallet();
  const statuses = useNodeState((s) => s.txStatus);
  // an unknown status (sent in an earlier visit, not in history) is not pending: offer funding again
  const item = activity.find((a) => a.account === publicKey && /friendbot/i.test(a.label) && !a.error && statuses[a.hash]?.status === 'pending');
  return item?.hash ?? null;
}

/** Shown when the selected account does not exist yet. */
export function FundFirst({ wallet }: { wallet: WalletKey }) {
  const { fund } = useWallet();
  const [busy, setBusy] = useState(false);
  const pending = usePendingFunding(wallet.publicKey);
  if (pending) {
    return (
      <Notice tone="info" icon={Droplets} title="Funding this account">
        <p>Friendbot is sending 10,000 test XLM. The account appears when the next ledger closes.</p>
        <TxStatusLine hash={pending} className="mt-2" />
      </Notice>
    );
  }
  return (
    <Notice tone="info" icon={Droplets} title="This account is not on the network yet">
      <p>Accounts exist once they hold at least 1 XLM. Friendbot sends 10,000 test XLM for free.</p>
      <Button
        className="mt-3"
        variant="primary"
        size="sm"
        icon={Droplets}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await fund(wallet.publicKey);
          } finally {
            setBusy(false);
          }
        }}
      >
        Fund with friendbot
      </Button>
    </Notice>
  );
}

/** Run an async action with a busy flag and a readable error. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
