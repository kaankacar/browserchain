import { Gift, HandCoins, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import type { AccountView } from '../../node/api';
import { AccountLink, AssetLabel } from '../components/links';
import { Button, Card, ErrorNote, Field, Input, Select } from '../components/ui';
import { describePredicate, predicateHoldsNow } from '../lib/describe';
import { assetKey, formatAmount, parseAssetKey } from '../lib/format';
import { claimClaimableBalanceOp, createClaimableBalanceOp, type ClaimPredicateInput } from '../lib/txbuild';
import type { WalletKey } from '../lib/wallet';
import { useNow } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { hasTrust, TxStatusLine, useAction } from './shared';

type When = 'any' | 'within' | 'after';

export function ClaimPanel({ wallet, account }: { wallet: WalletKey; account: AccountView }) {
  const { submit, keys } = useWallet();
  const now = useNow();
  const id = useId();
  const [assetK, setAssetK] = useState('XLM');
  const [amount, setAmount] = useState('');
  const [claimant, setClaimant] = useState('');
  const [when, setWhen] = useState<When>('any');
  const [hours, setHours] = useState('24');
  const [reclaim, setReclaim] = useState(true);
  const [hash, setHash] = useState<string | null>(null);
  const create = useAction();
  const claim = useAction();
  const [claiming, setClaiming] = useState<string | null>(null);

  const mine = wallet.publicKey;
  const forMe = account.claimableBalances.filter((c) => c.claimants.some((x) => x.destination === mine));
  const byMe = account.claimableBalances.filter((c) => c.sponsor === mine && !c.claimants.some((x) => x.destination === mine));

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      setHash(null);
      const asset = parseAssetKey(assetK);
      const n = Number(hours);
      let predicate: ClaimPredicateInput = { type: 'unconditional' };
      if (when !== 'any') {
        if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a positive number of hours.');
        predicate = { type: when === 'within' ? 'beforeRelative' : 'afterRelative', seconds: Math.round(n * 3600) };
      }
      const claimants = [{ destination: claimant.trim(), predicate }];
      if (reclaim && claimant.trim() !== mine) claimants.push({ destination: mine, predicate: { type: 'unconditional' } });
      const op = createClaimableBalanceOp({ asset, amount, claimants });
      const res = await submit({ key: wallet, ops: [op], label: `Claimable ${formatAmount(amount)} ${asset.code}` });
      if (!res.ok) throw new Error(res.message);
      setHash(res.hash);
      setAmount('');
    });
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <Card title="Waiting for you" subtitle="Claimable balances this account may claim" icon={Gift} iconClass="text-ledger" bodyClass="p-0">
        {forMe.length === 0 ? (
          <p className="p-4 text-sm text-fg-3">Nothing to claim right now. Ask a friend to send you a claimable balance, or create one below.</p>
        ) : (
          <ul className="divide-y divide-line">
            {forMe.map((c) => {
              const me = c.claimants.find((x) => x.destination === mine)!;
              const open = predicateHoldsNow(me.predicate, Math.floor(now / 1000));
              const trusted = hasTrust(account, c.asset);
              return (
                <li key={c.balanceId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-semibold tabular-nums">{formatAmount(c.amount)}</span> <AssetLabel asset={c.asset} issuer={false} />
                      <span className="text-fg-3">from</span> <AccountLink id={c.sponsor} size={14} />
                    </p>
                    <p className="mt-0.5 text-xs text-fg-3">
                      Claimable {describePredicate(me.predicate)}
                      {open === false ? ' · not claimable now' : ''}
                      {!trusted ? ` · needs a ${c.asset.code} trustline` : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={HandCoins}
                    disabled={open === false || !trusted}
                    loading={claim.busy && claiming === c.balanceId}
                    onClick={() => {
                      setClaiming(c.balanceId);
                      void claim.run(async () => {
                        setHash(null);
                        const res = await submit({ key: wallet, ops: [claimClaimableBalanceOp(c.balanceId)], label: `Claim ${formatAmount(c.amount)} ${c.asset.code}` });
                        if (!res.ok) throw new Error(res.message);
                        setHash(res.hash);
                      });
                    }}
                  >
                    Claim
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {claim.error ? <ErrorNote className="m-4">{claim.error}</ErrorNote> : null}
      </Card>

      <Card title="Create a claimable balance" subtitle="Send now, the recipient claims later" icon={Plus}>
        <form onSubmit={onCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Recipient" htmlFor={`${id}-to`} className="sm:col-span-2" hint="Any G… account, even one without a trustline yet.">
            <Input id={`${id}-to`} mono list={`${id}-keys`} value={claimant} onChange={(e) => setClaimant(e.target.value.trim())} placeholder="G…" required />
            <datalist id={`${id}-keys`}>
              {keys
                .filter((k) => k.publicKey !== mine)
                .map((k) => (
                  <option key={k.publicKey} value={k.publicKey}>
                    {k.name}
                  </option>
                ))}
            </datalist>
          </Field>
          <Field label="Asset" htmlFor={`${id}-asset`}>
            <Select id={`${id}-asset`} value={assetK} onChange={(e) => setAssetK(e.target.value)}>
              {account.balances.map((b) => (
                <option key={assetKey(b.asset)} value={assetKey(b.asset)}>
                  {b.asset.code} ({formatAmount(b.balance, { maxDecimals: 2 })})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor={`${id}-amt`}>
            <Input id={`${id}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} placeholder="0.00" required className="tabular-nums" />
          </Field>
          <Field label="When can they claim?" htmlFor={`${id}-when`}>
            <Select id={`${id}-when`} value={when} onChange={(e) => setWhen(e.target.value as When)}>
              <option value="any">Any time</option>
              <option value="within">Only within the next…</option>
              <option value="after">Only after…</option>
            </Select>
          </Field>
          <Field label="Hours" htmlFor={`${id}-hours`}>
            <Input id={`${id}-hours`} inputMode="decimal" disabled={when === 'any'} value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-fg-2 sm:col-span-2">
            <input type="checkbox" checked={reclaim} onChange={(e) => setReclaim(e.target.checked)} className="size-4 accent-[var(--bc-ledger-fill)]" />
            I can take it back any time (adds me as a second claimant)
          </label>
          {create.error ? <ErrorNote className="sm:col-span-2">{create.error}</ErrorNote> : null}
          {hash ? <TxStatusLine hash={hash} className="sm:col-span-2" /> : null}
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <p className="text-xs text-fg-3">Reserves 0.5 XLM per claimant until claimed.</p>
            <Button type="submit" variant="primary" icon={Gift} loading={create.busy}>
              Create
            </Button>
          </div>
        </form>
      </Card>

      {byMe.length ? (
        <Card title="Sent by you" subtitle="Balances others can claim" icon={Gift} bodyClass="p-0">
          <ul className="divide-y divide-line">
            {byMe.map((c) => (
              <li key={c.balanceId} className="px-4 py-2.5 text-sm">
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold tabular-nums">{formatAmount(c.amount)}</span> <AssetLabel asset={c.asset} issuer={false} />
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-fg-3">
                  {c.claimants.map((x) => (
                    <li key={x.destination} className="flex flex-wrap items-center gap-1.5">
                      <AccountLink id={x.destination} size={14} /> {describePredicate(x.predicate)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
