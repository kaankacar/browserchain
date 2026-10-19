import { Check, Pencil, Server, X } from 'lucide-react';
import { useState } from 'react';
import { HashText } from '../components/Hash';
import { Identicon } from '../components/Identicon';
import { LedgerLink } from '../components/links';
import { ResyncButton } from '../components/ResyncButton';
import { StateBadge } from '../components/StateBadge';
import { TimeAgo } from '../components/TimeAgo';
import { Badge, Card, Facts, IconButton, Input, Skeleton, Switch } from '../components/ui';
import { blockedReason, selfState } from '../lib/catchup';
import { formatDuration, formatNumber, plural } from '../lib/format';
import { useApi, useNodeState, useNow } from '../state/NodeProvider';
import { useToast } from '../state/toast';

function Uptime({ since }: { since: number }) {
  const now = useNow();
  return <span className="tabular-nums">{formatDuration(Math.max(0, now - since))}</span>;
}

export function IdentityCard() {
  const status = useNodeState((s) => s.status);
  const api = useApi();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  if (!status) {
    return (
      <Card title="Identity" icon={Server}>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="mt-4 h-40 w-full" />
      </Card>
    );
  }

  const saveName = async () => {
    const n = name.trim();
    if (!n || n === status.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await api.setName(n);
      toast({ tone: 'ok', title: 'Name updated', body: `Peers now see this node as “${n}”.` });
      setEditing(false);
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not rename', body: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const toggleValidating = async (on: boolean) => {
    setToggling(true);
    try {
      await api.setValidating(on);
      toast({ tone: 'info', title: on ? 'Validating' : 'Watching', body: on ? 'This node signs SCP statements again.' : 'This node follows consensus without voting.' });
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not change mode', body: (e as Error).message });
    } finally {
      setToggling(false);
    }
  };

  const catchup = status.catchup;
  const state = selfState(status);
  const reason = state === 'blocked' ? (blockedReason(status) ?? '').trim().replace(/\.+$/, '') : '';
  return (
    <Card title="This node" icon={Server} iconClass="text-ledger" actions={<StateBadge state={state} />}>
      <div className="flex items-start gap-4">
        <Identicon value={status.nodeId} size={56} label={`Identicon of ${status.name}`} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <label htmlFor="node-name" className="sr-only">
                Node name
              </label>
              <Input
                id="node-name"
                autoFocus
                maxLength={32}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
                className="h-8"
              />
              <IconButton icon={Check} label="Save name" size="sm" type="submit" disabled={saving} />
              <IconButton icon={X} label="Cancel" size="sm" onClick={() => setEditing(false)} />
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <h2 className="truncate text-lg font-semibold tracking-tight">{status.name}</h2>
              <IconButton
                icon={Pencil}
                label="Rename this node"
                size="sm"
                onClick={() => {
                  setName(status.name);
                  setEditing(true);
                }}
              />
            </div>
          )}
          <div className="mt-1 text-sm text-fg-2">
            <HashText value={status.nodeId} head={10} tail={10} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={status.isValidator ? 'consensus' : 'neutral'}>{status.isValidator ? 'Validating' : 'Watching'}</Badge>
            <Badge tone="network">{plural(status.peers, 'peer')}</Badge>
            <Badge>protocol {status.protocolVersion}</Badge>
          </div>
        </div>
      </div>

      {catchup && state === 'blocked' ? (
        <div className="mt-4 rounded-lg border border-bad/30 bg-bad/8 p-3 text-xs text-fg-2">
          <p className="font-medium text-fg">Not voting: cannot catch up safely</p>
          <p className="mt-1">
            Peers are at ledger #{formatNumber(catchup.target)}; this node is at #{formatNumber(status.lcl.seq)}.
            {reason ? <span className="[overflow-wrap:anywhere]"> Reason: {reason}.</span> : null}
          </p>
        </div>
      ) : catchup ? (
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn/8 p-3">
          <div className="flex justify-between text-xs text-fg-2">
            <span>Catching up from peers</span>
            <span className="tabular-nums">
              {formatNumber(catchup.current)} / {formatNumber(catchup.target)}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={catchup.target} aria-valuenow={catchup.current}>
            <div className="h-full rounded-full bg-warn transition-[width] duration-500" style={{ width: `${(catchup.current / Math.max(1, catchup.target)) * 100}%` }} />
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-4 border-t border-line pt-4">
        <Switch
          checked={status.isValidator}
          onChange={toggleValidating}
          disabled={toggling}
          label="Validate"
          description="Sign and send SCP statements. Turn off to watch consensus without voting."
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Resync</p>
            <p className="text-xs text-fg-3">Wipe the local chain and catch up from peers. Keeps this identity.</p>
          </div>
          <ResyncButton label="Resync…" title="Resync this node?">
            <p>
              This deletes the ledgers stored in this browser and downloads them again from peers. Your node identity and wallet keys stay. Consensus
              pauses until the node is in sync.
            </p>
          </ResyncButton>
        </div>
      </div>

      <Facts
        className="mt-5 border-t border-line pt-4"
        items={[
          { label: 'Network', value: status.networkName },
          { label: 'Uptime', value: <Uptime since={status.startedAt} /> },
          {
            label: 'Last closed ledger',
            value: (
              <span className="inline-flex items-center gap-2">
                <LedgerLink seq={status.lcl.seq} />
                <span className="text-xs text-fg-3">{status.lcl.closedAt ? <TimeAgo ms={status.lcl.closedAt} /> : null}</span>
              </span>
            ),
          },
          { label: 'Transaction queue', value: <span className="tabular-nums">{plural(status.mempoolSize, 'tx')}</span> },
          { label: 'Network passphrase', value: <span className="font-mono text-xs text-fg-2">{status.networkPassphrase}</span>, wide: true },
          { label: 'Network ID', value: <HashText value={status.networkId} head={12} tail={8} />, wide: true },
        ]}
      />
    </Card>
  );
}
