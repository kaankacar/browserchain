import { CircleHelp, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2, Users, Wand2, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { QuorumConfigView, QuorumSetView, ValidatorView } from '../../node/api';
import { HashText } from '../components/Hash';
import { NodeName } from '../components/links';
import { StateDot, type NodeState } from '../components/StateBadge';
import { Badge, Button, Card, cx, ErrorNote, IconButton, Input, Segmented, Select, Skeleton } from '../components/ui';
import { selfState as stateOfSelf } from '../lib/catchup';
import { checkIntersection, cloneQset, describeQset, faultTolerance, MAX_QSET_NESTING, qsetEntryCount, qsetValidators, validateQset } from '../lib/quorum';
import { useApi, useNodeState } from '../state/NodeProvider';
import { useToast } from '../state/toast';

export function IntersectionBadge({ value }: { value: QuorumConfigView['intersection'] }) {
  if (value === 'ok')
    return (
      <Badge tone="ok" icon={ShieldCheck}>
        Quorums intersect
      </Badge>
    );
  if (value === 'broken')
    return (
      <Badge tone="bad" icon={ShieldAlert}>
        Disjoint quorums possible
      </Badge>
    );
  return (
    <Badge tone="neutral" icon={ShieldQuestion}>
      Intersection unknown
    </Badge>
  );
}

function QsetTree({ q, validators, selfState, depth = 0 }: { q: QuorumSetView; validators: Map<string, ValidatorView>; selfState: NodeState; depth?: number }) {
  return (
    <div className={cx('rounded-lg border border-line p-3', depth === 0 ? 'bg-sunken' : 'bg-raised')}>
      <p className="text-xs font-medium text-fg-2">
        Need <span className="text-consensus">{q.threshold}</span> of {qsetEntryCount(q)}
        {depth > 0 ? ' (inner set)' : ''}
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {q.validators.map((v) => {
          const info = validators.get(v);
          const state: NodeState = info ? (info.isSelf ? selfState : info.connected ? (info.synced ? 'synced' : 'catching-up') : 'offline') : 'offline';
          return (
            <li key={v} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-xs">
              <StateDot state={state} />
              <NodeName id={v} size={16} />
              {!info ? <span className="text-fg-3">unknown</span> : null}
            </li>
          );
        })}
      </ul>
      {q.innerSets.length ? (
        <div className="mt-2 flex flex-col gap-2">
          {q.innerSets.map((inner, i) => (
            <QsetTree key={i} q={inner} validators={validators} selfState={selfState} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SetEditor({
  value,
  onChange,
  onRemove,
  candidates,
  used,
  depth,
}: {
  value: QuorumSetView;
  onChange: (q: QuorumSetView) => void;
  onRemove?: () => void;
  candidates: ValidatorView[];
  used: Set<string>;
  depth: number;
}) {
  const entries = qsetEntryCount(value);
  const free = candidates.filter((c) => !used.has(c.nodeId));
  const id = useId();
  return (
    <div className={cx('rounded-lg border p-3', depth === 0 ? 'border-line-strong bg-sunken' : 'border-line bg-raised')}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-t`} className="text-xs font-medium text-fg-2">
          {depth === 0 ? 'Threshold' : 'Inner set threshold'}
        </label>
        <Input
          id={`${id}-t`}
          type="number"
          min={1}
          max={Math.max(1, entries)}
          value={value.threshold}
          onChange={(e) => onChange({ ...value, threshold: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          className="h-8 w-20"
        />
        <span className="text-xs text-fg-3">of {entries} entries</span>
        {onRemove ? <IconButton icon={Trash2} label="Remove this inner set" size="sm" className="ml-auto" onClick={onRemove} /> : null}
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {value.validators.map((v) => (
          <li key={v} className="inline-flex items-center gap-1 rounded-md border border-line bg-panel py-0.5 pl-2 pr-0.5 text-xs">
            <NodeName id={v} size={16} />
            <IconButton icon={X} label="Remove validator" size="sm" onClick={() => onChange({ ...value, validators: value.validators.filter((x) => x !== v) })} />
          </li>
        ))}
        {value.validators.length === 0 ? <li className="text-xs text-fg-3">No validators in this set yet.</li> : null}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-add`} className="sr-only">
          Add a validator
        </label>
        <Select
          id={`${id}-add`}
          value=""
          disabled={free.length === 0}
          onChange={(e) => {
            if (e.target.value) onChange({ ...value, validators: [...value.validators, e.target.value] });
          }}
          className="h-8 w-auto max-w-full text-xs"
        >
          <option value="">{free.length ? 'Add validator…' : 'All known validators used'}</option>
          {free.map((c) => (
            <option key={c.nodeId} value={c.nodeId}>
              {c.name}
              {c.isSelf ? ' (this node)' : ''}
              {!c.active ? ' – offline' : ''}
            </option>
          ))}
        </Select>
        {depth < MAX_QSET_NESTING - 1 ? (
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange({ ...value, innerSets: [...value.innerSets, { threshold: 1, validators: [], innerSets: [] }] })}>
            Inner set
          </Button>
        ) : null}
      </div>
      {value.innerSets.length ? (
        <div className="mt-3 flex flex-col gap-2">
          {value.innerSets.map((inner, i) => (
            <SetEditor
              key={i}
              value={inner}
              depth={depth + 1}
              candidates={candidates}
              used={used}
              onChange={(q) => onChange({ ...value, innerSets: value.innerSets.map((x, j) => (j === i ? q : x)) })}
              onRemove={() => onChange({ ...value, innerSets: value.innerSets.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-raised px-3 py-2.5">
      <p className="text-xs text-fg-3">{label}</p>
      <div className="mt-1 text-sm font-medium text-fg">{children}</div>
    </div>
  );
}

export function QuorumCard() {
  const quorum = useNodeState((s) => s.status?.quorum ?? null);
  const selfId = useNodeState((s) => s.status?.nodeId ?? null);
  const selfState = useNodeState((s) => stateOfSelf(s.status));
  const validators = useNodeState((s) => s.validators);
  const api = useApi();
  const toast = useToast();
  const [draft, setDraft] = useState<QuorumSetView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(validators.map((v) => [v.nodeId, v])), [validators]);

  const draftErrors = draft ? validateQset(draft) : [];
  const draftIntersection = useMemo(() => {
    if (!draft || !selfId) return 'unknown' as const;
    const qsets = new Map<string, QuorumSetView>();
    for (const v of validators) if (v.qset && v.active) qsets.set(v.nodeId, v.qset);
    qsets.set(selfId, draft);
    return checkIntersection(qsets);
  }, [draft, validators, selfId]);

  if (!quorum) {
    return (
      <Card title="Quorum set" icon={Users}>
        <Skeleton className="h-48 w-full" />
      </Card>
    );
  }

  const apply = async (input: { mode: 'auto' } | { mode: 'manual'; qset: QuorumSetView }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setQuorumConfig(input);
      toast({
        tone: 'ok',
        title: input.mode === 'auto' ? 'Quorum set to auto' : 'Manual quorum set applied',
        body: `Need ${describeQset(res.qset)} · tolerates ${res.faultTolerance} failure${res.faultTolerance === 1 ? '' : 's'}.`,
      });
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mode = draft ? 'manual' : quorum.mode;
  const usedInDraft = new Set(draft ? qsetValidators(draft) : []);

  return (
    <Card
      title="Quorum set"
      subtitle="Who this node trusts to agree on each ledger"
      icon={Users}
      iconClass="text-consensus"
      actions={
        <Segmented
          label="Quorum mode"
          value={mode}
          onChange={(m) => {
            if (m === 'manual') setDraft(cloneQset(quorum.qset));
            else if (quorum.mode === 'manual') void apply({ mode: 'auto' });
            else setDraft(null);
          }}
          options={[
            { value: 'auto', label: 'Auto', icon: Wand2 },
            { value: 'manual', label: 'Manual', icon: Users },
          ]}
        />
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Stat label="Threshold">
          <span className="tabular-nums">{describeQset(quorum.qset)}</span>
        </Stat>
        <Stat label="Fault tolerance">
          {quorum.faultTolerance === 0 ? <span className="text-warn">no failures</span> : `${quorum.faultTolerance} failure${quorum.faultTolerance === 1 ? '' : 's'}`}
        </Stat>
        <Stat label="Intersection check">
          <IntersectionBadge value={quorum.intersection} />
        </Stat>
      </div>
      <p className="mt-3 flex gap-2 text-xs text-fg-3">
        <CircleHelp aria-hidden className="mt-px size-3.5 shrink-0" />
        {mode === 'auto'
          ? 'Auto mode trusts every synced validator heard in the last few seconds and needs 2/3 of them. It adapts as tabs open and close, so it favors liveness.'
          : 'Manual mode never changes by itself. SCP keeps its classic safety guarantees for the set you chose.'}
      </p>

      {draft ? (
        <div className="mt-4">
          <SetEditor value={draft} onChange={setDraft} candidates={validators} used={usedInDraft} depth={0} />
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-fg-3">Preview:</span>
            <Badge tone="consensus">needs {describeQset(draft)}</Badge>
            <Badge tone={faultTolerance(draft) > 0 ? 'ok' : 'warn'}>tolerates {faultTolerance(draft)}</Badge>
            <IntersectionBadge value={draftErrors.length ? 'unknown' : draftIntersection} />
          </div>
          {draftErrors.length ? <ErrorNote className="mt-3">{draftErrors[0]}</ErrorNote> : null}
          {draft && selfId && !qsetValidators(draft).includes(selfId) ? (
            <p className="mt-2 text-xs text-fg-3">Tip: stellar-core always counts the local node in its own quorum set.</p>
          ) : null}
          {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={draftErrors.length > 0} onClick={() => void apply({ mode: 'manual', qset: draft })}>
              Apply manual quorum
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <QsetTree q={quorum.qset} validators={byId} selfState={selfState} />
          {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-fg-3">
              Quorum set hash <HashText value={quorum.qsetHash} head={8} tail={6} />
            </span>
            {quorum.mode === 'manual' ? (
              <Button size="sm" onClick={() => setDraft(cloneQset(quorum.qset))}>
                Edit
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Card>
  );
}
