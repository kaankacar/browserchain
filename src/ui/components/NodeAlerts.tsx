import { CirclePause, GitFork } from 'lucide-react';
import { blockedReason, inSync, selfState } from '../lib/catchup';
import { formatNumber, plural } from '../lib/format';
import { strangerFork } from '../lib/forks';
import { useNodeState, useNow } from '../state/NodeProvider';
import { ForkBanner } from './ForkBanner';
import { NodeName } from './links';
import { ResyncButton } from './ResyncButton';
import { Notice } from './ui';

/** Node states the user should know about or act on (Overview and Validator page). */
export function NodeAlerts({ linkToValidator = true }: { linkToValidator?: boolean }) {
  return (
    <>
      <BlockedNotice />
      <StrangerForkAlert />
      <ForkBanner linkToValidator={linkToValidator} />
    </>
  );
}

/**
 * Peers are ahead, but this node cannot catch up from them safely, so it
 * does not vote (voting alone would build a branch of its own).
 */
export function BlockedNotice() {
  const status = useNodeState((s) => s.status);
  if (!status?.catchup || selfState(status) !== 'blocked') return null;
  const reason = (blockedReason(status) ?? '').trim().replace(/\.+$/, '');
  return (
    <Notice tone="warn" icon={CirclePause} title="This node is not voting">
      <p>
        Peers are at ledger #{formatNumber(status.catchup.target)}, ahead of this tab (#{formatNumber(status.lcl.seq)}), but this tab cannot catch up
        from them safely, for example because they are validators it did not know before. Voting alone would build a chain of its own, so the node
        waits and tries again when it can catch up.
      </p>
      {reason ? (
        <p className="mt-1">
          Reason: <span className="text-fg [overflow-wrap:anywhere]">{reason}</span>.
        </p>
      ) : null}
      <p className="mt-1">To join the peers now, resync: this tab wipes its chain and catches up from them. It keeps its identity.</p>
      <div className="mt-3">
        <ResyncButton variant="secondary" label="Resync to join them" title="Resync to join the peers ahead?">
          <p>
            This tab deletes the ledgers it stored and downloads the chain of the peers ahead. Your node identity and wallet keys stay. Ledgers and
            transactions that only this tab has are dropped. Consensus pauses until the node is in sync.
          </p>
        </ResyncButton>
      </div>
    </Notice>
  );
}

/**
 * Validators this node did not know before the fork run another chain. Auto
 * mode keeps ours (only validators known before a fork decide it), so only a
 * resync moves this tab to their chain.
 */
export function StrangerForkAlert() {
  const forks = useNodeState((s) => s.forks);
  const ledgers = useNodeState((s) => s.ledgers);
  const synced = useNodeState((s) => inSync(selfState(s.status)));
  const resyncAt = useNodeState((s) => s.resyncAt);
  const now = useNow();
  const f = strangerFork(forks, ledgers, now, { inSync: synced, resyncAt });
  if (!f) return null;
  const n = f.unknownValidators ?? 0;
  const peer = <NodeName id={f.peer} size={16} you={false} className="font-medium text-fg" />;
  return (
    <Notice tone="warn" icon={GitFork} title="Another group of validators is on a different chain">
      <p>
        Since ledger #{formatNumber(f.atSeq)}, {plural(n, 'validator')} that this tab did not know before
        {n > 1 ? <>, such as {peer},</> : <> ({peer})</>} {n === 1 ? 'is' : 'are'} on a different chain. This tab keeps its own chain, because only
        validators it knew before the chains split can make it switch.
      </p>
      <p className="mt-1">
        To join them, resync: this tab wipes its chain and catches up from the other group. It keeps its identity. Do this in every tab of this browser
        that shows this alert.
      </p>
      <div className="mt-3">
        <ResyncButton variant="secondary" label="Resync to join them" title="Resync to join the other group?">
          <p>
            This tab deletes the ledgers it stored and downloads the chain of the other group. Your node identity and wallet keys stay. Ledgers and
            transactions that only this tab’s chain has are dropped. Consensus pauses until the node is in sync.
          </p>
          <p className="mt-2">Do the same in every other tab of this browser that shows this alert. Tabs that do not resync stay on the old chain.</p>
        </ResyncButton>
      </div>
    </Notice>
  );
}
