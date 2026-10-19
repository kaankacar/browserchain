import { GitFork } from 'lucide-react';
import { forkNotice } from '../lib/forks';
import { formatNumber, plural } from '../lib/format';
import { href } from '../lib/route';
import { useNodeState, useNow } from '../state/NodeProvider';
import { NodeName } from './links';
import { Notice } from './ui';

/**
 * A fork the user must act on (manual quorum mode only reports it), or a
 * rollback that just replaced recent ledgers (auto mode).
 */
export function ForkBanner({ linkToValidator = true }: { linkToValidator?: boolean }) {
  const forks = useNodeState((s) => s.forks);
  const ledgers = useNodeState((s) => s.ledgers);
  const validators = useNodeState((s) => s.validators);
  const synced = useNodeState((s) => s.status?.state === 'synced' || s.status?.state === 'stalled');
  const auto = useNodeState((s) => s.status?.quorum.mode === 'auto');
  const now = useNow();
  const notice = forkNotice(forks, ledgers, now, { validators, synced });
  if (!notice) return null;
  const f = notice.fork;
  const peer = <NodeName id={f.peer} size={16} you={false} className="font-medium text-fg" />;
  if (notice.kind === 'rolled-back') {
    return (
      <Notice tone="info" icon={GitFork} title="Fork resolved: this node changed branch">
        From ledger #{formatNumber(f.atSeq)}, {peer} had other ledgers than this node. Auto mode follows the branch that more known validators are on (on a
        tie, the heavier one), so this node dropped{' '}
        {plural(f.rolledBackLedgers, 'ledger')} and now follows the other branch.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={GitFork} title="Fork: this node and a peer disagree">
      From ledger #{formatNumber(f.atSeq)}, {peer} has other ledgers than this node.{' '}
      {/* the quorum mode can change after the report */}
      {auto
        ? 'This node still keeps its own chain. Resync this node to take the other branch'
        : 'In manual quorum mode the node keeps its own chain and only reports the fork. Resync this node to take the other branch, or switch the quorum to auto mode to let it pick a branch'}
      {linkToValidator ? (
        <>
          {' '}
          on the{' '}
          <a href={href.validator()} className="font-medium text-ledger underline">
            Validator
          </a>{' '}
          page
        </>
      ) : null}
      .
    </Notice>
  );
}
