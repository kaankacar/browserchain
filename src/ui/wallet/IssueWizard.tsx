import { Check, Circle, CircleX, Coins, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import type { AccountView, AssetView } from '../../node/api';
import { AccountLink } from '../components/links';
import { Button, Card, cx, ErrorNote, Field, Input, Notice } from '../components/ui';
import { formatAmount, humanizeCode } from '../lib/format';
import { href } from '../lib/route';
import { changeTrustOp, checkAmount, checkAssetCode, paymentOp } from '../lib/txbuild';
import { createKey, type WalletKey } from '../lib/wallet';
import { useClock } from '../state/NodeProvider';
import { useWallet, type SubmitOutcome } from '../state/wallet';

type StepState = 'idle' | 'running' | 'done' | 'error';

interface Run {
  issuer: WalletKey | null;
  asset: AssetView | null;
  amount: string;
  steps: StepState[];
  hashes: (string | null)[];
  error: string | null;
}

const EMPTY: Run = { issuer: null, asset: null, amount: '', steps: ['idle', 'idle', 'idle', 'idle'], hashes: [null, null, null, null], error: null };

export function IssueWizard({ wallet, account }: { wallet: WalletKey; account: AccountView }) {
  const { addKey, fund, submit, waitFor } = useWallet();
  const clock = useClock();
  const id = useId();
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('1000');
  const [run, setRun] = useState<Run>(EMPTY);
  const running = run.steps.includes('running');
  const finished = run.steps.every((s) => s === 'done');

  const setStep = (i: number, s: StepState, hash?: string | null) =>
    setRun((r) => {
      const steps = [...r.steps];
      steps[i] = s;
      const hashes = [...r.hashes];
      if (hash !== undefined) hashes[i] = hash;
      return { ...r, steps, hashes };
    });

  const confirmApplied = async (res: SubmitOutcome, what: string) => {
    if (!res.ok) throw new Error(`${what}: ${res.message ?? 'rejected'}`);
    const st = await waitFor(res.hash, 60_000);
    if (st.status !== 'applied') throw new Error(`${what} ${st.status}${st.resultCode ? `: ${humanizeCode(st.resultCode)}` : ''}`);
  };

  const start = async () => {
    let c: string;
    let amt: string;
    try {
      c = checkAssetCode(code).toUpperCase();
      amt = checkAmount(amount);
    } catch (e) {
      setRun((r) => ({ ...r, error: (e as Error).message }));
      return;
    }
    // Resume from the first unfinished step when the asset is unchanged.
    const resume = run.issuer && run.asset?.code === c ? run : { ...EMPTY };
    let issuer = resume.issuer;
    if (!issuer) {
      issuer = createKey(`${c} issuer`, clock.now());
      addKey(issuer, false);
    }
    const asset: AssetView = { type: c.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code: c, issuer: issuer.publicKey };
    setRun({ ...resume, issuer, asset, amount: amt, error: null, steps: ['done', resume.steps[1], resume.steps[2], resume.steps[3]] });
    let step = 1;
    try {
      if (resume.steps[1] !== 'done') {
        step = 1;
        setStep(1, 'running');
        const res = await fund(issuer.publicKey, `Fund ${c} issuer`);
        setStep(1, 'running', res.hash);
        await confirmApplied(res, 'Funding the issuer');
        setStep(1, 'done');
      }
      if (resume.steps[2] !== 'done') {
        step = 2;
        setStep(2, 'running');
        const res = await submit({ key: wallet, ops: [changeTrustOp({ asset })], label: `Trust ${c}` });
        setStep(2, 'running', res.hash);
        await confirmApplied(res, 'The trustline');
        setStep(2, 'done');
      }
      step = 3;
      setStep(3, 'running');
      const res = await submit({ key: issuer, ops: [paymentOp({ destination: wallet.publicKey, asset, amount: amt })], label: `Mint ${formatAmount(amt)} ${c}` });
      setStep(3, 'running', res.hash);
      await confirmApplied(res, 'Minting');
      setStep(3, 'done');
    } catch (e) {
      setStep(step, 'error');
      setRun((r) => ({ ...r, error: (e as Error).message }));
    }
  };

  const labels = [
    'Create a new issuer key in this wallet',
    'Fund the issuer with friendbot',
    `Add a ${run.asset?.code ?? (code.toUpperCase() || 'CODE')} trustline from ${wallet.name}`,
    `Mint ${formatAmount(run.amount || amount || '0')} ${run.asset?.code ?? (code.toUpperCase() || 'CODE')} to ${wallet.name}`,
  ];

  return (
    <Card title="Issue an asset" subtitle="Your own token in four steps, about 15 seconds" icon={Sparkles} iconClass="text-ledger">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <p className="text-sm text-fg-2">
            An asset is named by a code and the account that issues it. This creates a fresh issuer account, lets <strong className="font-medium text-fg">{wallet.name}</strong> hold the asset, and mints
            the amount to it.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Asset code" htmlFor={`${id}-code`} hint="1–12 letters or digits">
              <Input id={`${id}-code`} value={code} disabled={running} maxLength={12} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="PIZZA" />
            </Field>
            <Field label="Amount to mint" htmlFor={`${id}-amount`}>
              <Input id={`${id}-amount`} inputMode="decimal" disabled={running} value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
            </Field>
          </div>
          {run.error ? <ErrorNote>{run.error}</ErrorNote> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" icon={Coins} loading={running} disabled={!code || finished}>
              {run.steps.includes('error') ? 'Retry' : 'Issue asset'}
            </Button>
            {run.issuer && !running ? (
              <Button
                variant="ghost"
                icon={RotateCcw}
                onClick={() => {
                  setRun(EMPTY);
                  setCode('');
                }}
              >
                Start over
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-fg-3">Holding {account.balances.length - 1} asset{account.balances.length === 2 ? '' : 's'} besides XLM now.</p>
        </form>
        <ol className="flex flex-col gap-2" aria-label="Steps">
          {labels.map((label, i) => {
            const s = run.steps[i];
            const Icon = s === 'done' ? Check : s === 'running' ? LoaderCircle : s === 'error' ? CircleX : Circle;
            return (
              <li
                key={i}
                className={cx(
                  'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm',
                  s === 'done' ? 'border-ok/30 bg-ok/6' : s === 'running' ? 'border-ledger-fill/40 bg-ledger-fill/6' : s === 'error' ? 'border-bad/30 bg-bad/6' : 'border-line',
                )}
              >
                <Icon
                  aria-hidden
                  className={cx('mt-0.5 size-4 shrink-0', s === 'done' ? 'text-ok' : s === 'running' ? 'animate-spin text-ledger' : s === 'error' ? 'text-bad' : 'text-fg-3')}
                />
                <div className="min-w-0">
                  <p className={s === 'idle' ? 'text-fg-2' : 'text-fg'}>
                    <span className="mr-1 text-fg-3">{i + 1}.</span>
                    {label}
                  </p>
                  {i === 0 && run.issuer ? (
                    <div className="mt-1 text-xs">
                      <AccountLink id={run.issuer.publicKey} size={14} />
                    </div>
                  ) : null}
                  {run.hashes[i] ? (
                    <a href={href.tx(run.hashes[i]!)} className="mt-1 inline-block text-xs text-ledger hover:underline">
                      transaction {run.hashes[i]!.slice(0, 10)}…
                    </a>
                  ) : null}
                  <span className="sr-only">{s}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {finished && run.asset ? (
        <Notice tone="ok" icon={Check} title={`${run.asset.code} is live`} className="mt-5">
          <p>
            {wallet.name} now holds {formatAmount(run.amount)} {run.asset.code}. Send it, trade it on the DEX, or look it up in the{' '}
            <a className="font-medium text-ledger underline" href={href.assets()}>
              asset list
            </a>
            . The issuer key is saved in this wallet as “{run.issuer?.name}”.
          </p>
        </Notice>
      ) : null}
    </Card>
  );
}
