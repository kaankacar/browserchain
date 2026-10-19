import { Link2, Plus, Unlink } from 'lucide-react';
import { useId, useState } from 'react';
import type { AccountView, AssetView } from '../../node/api';
import { AssetLabel } from '../components/links';
import { Badge, Button, Card, cx, ErrorNote, Field, Input, Select, TableWrap, TD, TH } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { assetKey, formatAmount, parseAssetKey } from '../lib/format';
import { changeTrustOp, checkAccountId, checkAssetCode } from '../lib/txbuild';
import type { WalletKey } from '../lib/wallet';
import { useApi, useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { TxStatusLine, useAction } from './shared';

export function TrustPanel({ wallet, account }: { wallet: WalletKey; account: AccountView }) {
  const api = useApi();
  const { submit } = useWallet();
  const closeCounter = useNodeState((s) => s.closeCounter);
  const assets = useAsync(() => api.getAssets(), [api, closeCounter]);
  const id = useId();
  const [choice, setChoice] = useState('');
  const [code, setCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [limit, setLimit] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const add = useAction();
  const remove = useAction();
  const [removing, setRemoving] = useState<string | null>(null);

  const lines = account.balances.filter((b) => b.asset.type !== 'native');
  const trusted = new Set(lines.map((b) => assetKey(b.asset)));
  const options = (assets.data ?? []).filter((a) => !trusted.has(assetKey(a.asset)) && a.asset.issuer !== wallet.publicKey);
  const custom = choice === 'custom' || options.length === 0;

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    void add.run(async () => {
      setHash(null);
      let asset: AssetView;
      if (custom) {
        const c = checkAssetCode(code);
        const i = checkAccountId(issuer, 'Issuer');
        if (i === wallet.publicKey) throw new Error('An account cannot trust its own asset; it issues it.');
        asset = { type: c.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code: c, issuer: i };
      } else {
        if (!choice) throw new Error('Choose an asset.');
        asset = parseAssetKey(choice);
      }
      const res = await submit({ key: wallet, ops: [changeTrustOp({ asset, limit: limit || undefined })], label: `Trust ${asset.code}` });
      if (!res.ok) throw new Error(res.message);
      setHash(res.hash);
      setChoice('');
      setCode('');
      setIssuer('');
      setLimit('');
    });
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <Card title="Trustlines" subtitle="Assets this account can hold" icon={Link2} iconClass="text-consensus" bodyClass="p-0">
        {lines.length === 0 ? (
          <p className="p-4 text-sm text-fg-3">No trustlines yet. Add one below to receive an asset other than XLM.</p>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Asset</th>
                  <th className={cx(TH, 'text-right')}>Balance</th>
                  <th className={cx(TH, 'text-right')}>Limit</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((b) => {
                  const k = assetKey(b.asset);
                  const empty = Number(b.balance) === 0 && Number(b.buyingLiabilities) === 0 && Number(b.sellingLiabilities) === 0;
                  return (
                    <tr key={k} className="border-t border-line">
                      <td className={TD}>
                        <AssetLabel asset={b.asset} />
                      </td>
                      <td className={cx(TD, 'text-right tabular-nums')}>{formatAmount(b.balance)}</td>
                      <td className={cx(TD, 'text-right tabular-nums text-fg-3')}>{b.limit && Number(b.limit) < 9e11 ? formatAmount(b.limit) : 'max'}</td>
                      <td className={TD}>{b.authorized ? <Badge tone="ok">authorized</Badge> : <Badge tone="warn">needs issuer approval</Badge>}</td>
                      <td className={cx(TD, 'text-right')}>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Unlink}
                          disabled={!empty}
                          title={empty ? 'Remove this trustline' : 'Send the balance away (or back to the issuer) first'}
                          loading={remove.busy && removing === k}
                          onClick={() => {
                            setRemoving(k);
                            void remove.run(async () => {
                              setHash(null);
                              const res = await submit({ key: wallet, ops: [changeTrustOp({ asset: b.asset, limit: '0' })], label: `Remove ${b.asset.code} trustline` });
                              if (!res.ok) throw new Error(res.message);
                              setHash(res.hash);
                            });
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        {remove.error ? <ErrorNote className="m-4">{remove.error}</ErrorNote> : null}
      </Card>

      <Card title="Add a trustline" subtitle="Each trustline reserves 0.5 XLM" icon={Plus}>
        <form onSubmit={onAdd} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {options.length ? (
            <Field label="Asset" htmlFor={`${id}-pick`} className="sm:col-span-2">
              <Select id={`${id}-pick`} value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose an asset…</option>
                {options.map((a) => (
                  <option key={assetKey(a.asset)} value={assetKey(a.asset)}>
                    {a.asset.code} · issuer {a.asset.issuer?.slice(0, 4)}…{a.asset.issuer?.slice(-4)} · {a.holders} holders
                  </option>
                ))}
                <option value="custom">Another asset (enter code and issuer)…</option>
              </Select>
            </Field>
          ) : null}
          {custom ? (
            <>
              <Field label="Asset code" htmlFor={`${id}-code`}>
                <Input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="USDB" maxLength={12} />
              </Field>
              <Field label="Issuer" htmlFor={`${id}-issuer`}>
                <Input id={`${id}-issuer`} mono value={issuer} onChange={(e) => setIssuer(e.target.value.trim())} placeholder="G…" />
              </Field>
            </>
          ) : null}
          <Field label="Limit" htmlFor={`${id}-limit`} optional hint="Leave empty for the maximum.">
            <Input id={`${id}-limit`} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="max" />
          </Field>
          <div className="flex items-end justify-end">
            <Button type="submit" variant="primary" icon={Link2} loading={add.busy}>
              Add trustline
            </Button>
          </div>
          {add.error ? <ErrorNote className="sm:col-span-2">{add.error}</ErrorNote> : null}
          {hash ? <TxStatusLine hash={hash} className="sm:col-span-2" /> : null}
        </form>
      </Card>
    </div>
  );
}
