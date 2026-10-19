import { Keypair } from '@stellar/stellar-sdk/base';
import { PenLine, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toHex } from '../../lib/bytes';
import { CopyButton } from '../components/Hash';
import { AccountLink } from '../components/links';
import { Badge, Button, Card, ErrorNote, Facts, Field, Input, Notice, Select, Textarea } from '../components/ui';
import { navigate } from '../hooks/useRoute';
import { formatNumber, opTypeLabel } from '../lib/format';
import { href } from '../lib/route';
import { describeEnvelope, signEnvelope } from '../lib/txbuild';
import { useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { useLab } from './LabPage';

export function SignTab() {
  const { xdr, setXdr } = useLab();
  const { keys } = useWallet();
  const passphrase = useNodeState((s) => s.status?.networkPassphrase ?? null);
  const [signer, setSigner] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const info = useMemo(() => {
    if (!xdr.trim() || !passphrase) return null;
    try {
      return { ok: true as const, v: describeEnvelope(xdr, passphrase) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [xdr, passphrase]);

  const hints = useMemo(() => new Map(keys.map((k) => [toHex(Keypair.fromPublicKey(k.publicKey).signatureHint()), k])), [keys]);
  const defaultSigner = info?.ok ? keys.find((k) => k.publicKey === info.v.source)?.publicKey ?? '' : '';
  const chosen = signer || defaultSigner;

  const sign = () => {
    setError(null);
    setMessage(null);
    try {
      if (!passphrase) throw new Error('Not connected yet.');
      const key = chosen === 'secret' ? secret : keys.find((k) => k.publicKey === chosen)?.secret;
      if (!key) throw new Error('Choose a wallet key or paste a secret key.');
      const res = signEnvelope(xdr, key, passphrase);
      setXdr(res.xdr);
      setMessage(res.added ? `Signed by ${res.signer.slice(0, 6)}…${res.signer.slice(-4)}.` : 'That key had already signed this transaction.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-2">
      <Card title="Envelope" subtitle="TransactionEnvelope, base64" icon={PenLine} actions={xdr ? <CopyButton value={xdr} label="Copy XDR" /> : null}>
        <Field label="XDR" htmlFor="sign-xdr">
          <Textarea id="sign-xdr" value={xdr} onChange={(e) => setXdr(e.target.value)} rows={10} placeholder="Build one in the Build tab, or paste it here" />
        </Field>
        {info && !info.ok ? <ErrorNote className="mt-3">{info.error}</ErrorNote> : null}
        {info?.ok ? (
          <Facts
            className="mt-4"
            items={[
              { label: 'Hash', value: <span className="font-mono text-xs [overflow-wrap:anywhere]">{info.v.hash}</span>, wide: true },
              { label: 'Source', value: <AccountLink id={info.v.source} />, wide: true },
              { label: 'Sequence', value: <span className="font-mono text-xs">{info.v.sequence}</span> },
              { label: 'Fee', value: <span className="tabular-nums">{formatNumber(Number(info.v.fee))} stroops</span> },
              { label: 'Operations', value: info.v.operations.map((o) => opTypeLabel(o.type)).join(', '), wide: true },
              {
                label: 'Signatures',
                wide: true,
                value: info.v.signatures.length ? (
                  <span className="flex flex-wrap gap-1.5">
                    {info.v.signatures.map((s) => (
                      <Badge key={s.hint} tone={hints.has(s.hint) ? 'ledger' : 'neutral'}>
                        {hints.get(s.hint)?.name ?? `hint ${s.hint}`}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-warn">none yet</span>
                ),
              },
            ]}
          />
        ) : null}
      </Card>
      <Card title="Add a signature" icon={PenLine} iconClass="text-ledger">
        <div className="flex flex-col gap-4">
          <Field label="Sign with" htmlFor="sign-with">
            <Select id="sign-with" value={chosen} onChange={(e) => setSigner(e.target.value)}>
              <option value="">Choose a key…</option>
              {keys.map((k) => (
                <option key={k.publicKey} value={k.publicKey}>
                  {k.name} · {k.publicKey.slice(0, 6)}…{k.publicKey.slice(-4)}
                </option>
              ))}
              <option value="secret">Paste a secret key…</option>
            </Select>
          </Field>
          {chosen === 'secret' ? (
            <Field label="Secret key" htmlFor="sign-secret" hint="Used once in this browser, never stored or sent.">
              <Input id="sign-secret" type="password" mono autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="S…" />
            </Field>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {message ? (
            <Notice tone="ok" icon={PenLine}>
              {message}
            </Notice>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="primary" icon={PenLine} onClick={sign} disabled={!info?.ok}>
              Sign
            </Button>
            <Button icon={Send} onClick={() => navigate(href.lab('submit'))} disabled={!info?.ok || info.v.signatures.length === 0}>
              Submit…
            </Button>
          </div>
          <p className="text-xs text-fg-3">Signatures cover the network passphrase, so this envelope is only valid on this network.</p>
        </div>
      </Card>
    </div>
  );
}
