import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { List, Share2, Waypoints } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PeerView, QuorumSetView, ValidatorView } from '../../node/api';
import { Identicon } from '../components/Identicon';
import { NodeName } from '../components/links';
import { STATE_META, StateBadge, StateDot, type NodeState } from '../components/StateBadge';
import { Card, cx, Segmented } from '../components/ui';
import { selfState as stateOfSelf } from '../lib/catchup';
import { formatNumber, middleEllipsis } from '../lib/format';
import { describeQset, qsetValidators } from '../lib/quorum';
import { readPref, writePref } from '../lib/wallet';
import { useNodeState } from '../state/NodeProvider';

interface GNode extends SimulationNodeDatum {
  id: string;
  name: string;
  self: boolean;
  state: NodeState;
  inMyQuorum: boolean;
  qset: QuorumSetView | null;
  lcl: number | null;
}

interface GLink extends SimulationLinkDatum<GNode> {
  key: string;
  mutual: boolean;
  mine: boolean;
}

interface GraphData {
  nodes: GNode[];
  links: { key: string; source: string; target: string; mutual: boolean; mine: boolean }[];
}

function buildGraph(validators: ValidatorView[], peers: PeerView[], selfId: string | null, selfState: NodeState, selfQset: QuorumSetView | null, lcl: number | null): GraphData {
  const peerById = new Map(peers.map((p) => [p.nodeId, p]));
  const nodes: GNode[] = validators.map((v) => {
    const p = peerById.get(v.nodeId);
    const state: NodeState = v.isSelf ? selfState : p ? p.state : v.connected ? (v.synced ? 'synced' : 'catching-up') : 'offline';
    return {
      id: v.nodeId,
      name: v.name,
      self: v.isSelf,
      state,
      inMyQuorum: v.inMyQuorum,
      qset: v.isSelf ? (selfQset ?? v.qset) : v.qset,
      lcl: v.isSelf ? lcl : (p?.lclSeq ?? null),
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const dir = new Set<string>();
  for (const n of nodes) {
    if (!n.qset) continue;
    for (const m of qsetValidators(n.qset)) if (m !== n.id && ids.has(m)) dir.add(`${n.id}>${m}`);
  }
  const links: GraphData['links'] = [];
  const seen = new Set<string>();
  for (const d of dir) {
    const [a, b] = d.split('>');
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mutual = dir.has(`${b}>${a}`);
    const mine = !!selfId && ((a === selfId && dir.has(`${selfId}>${b}`)) || (b === selfId && dir.has(`${selfId}>${a}`)));
    links.push({ key, source: a, target: b, mutual, mine });
  }
  return { nodes, links };
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 600, h: 320 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function Graph({ data, width, height }: { data: GraphData; width: number; height: number }) {
  const sim = useRef<Simulation<GNode, GLink> | null>(null);
  const nodesRef = useRef(new Map<string, GNode>());
  const [, setFrame] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const raf = useRef<number | null>(null);

  // Merge new data into persistent node objects so positions survive updates.
  const { nodes, links } = useMemo(() => {
    const prev = nodesRef.current;
    const next = new Map<string, GNode>();
    data.nodes.forEach((n, i) => {
      const old = prev.get(n.id);
      const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
      next.set(n.id, old ? Object.assign(old, n) : { ...n, x: width / 2 + Math.cos(angle) * 80, y: height / 2 + Math.sin(angle) * 80 });
    });
    nodesRef.current = next;
    const ns = [...next.values()];
    const ls: GLink[] = data.links.map((l) => ({ ...l }));
    return { nodes: ns, links: ls };
  }, [data, width, height]);

  useEffect(() => {
    const s =
      sim.current ??
      forceSimulation<GNode, GLink>()
        .force('charge', forceManyBody<GNode>().strength(-760))
        .force('collide', forceCollide<GNode>(44))
        .stop();
    sim.current = s;
    s.nodes(nodes);
    s.force('link', forceLink<GNode, GLink>(links).id((d) => d.id).distance(Math.min(170, Math.max(100, Math.min(width, height) / 2.6))).strength(0.3));
    s.force('center', forceCenter(width / 2, height / 2));
    s.force('x', forceX<GNode>(width / 2).strength(0.07));
    s.force('y', forceY<GNode>(height / 2).strength(0.12));
    s.alpha(Math.max(s.alpha(), 0.5));

    const clamp = () => {
      for (const n of nodes) {
        n.x = Math.max(34, Math.min(width - 34, n.x ?? width / 2));
        n.y = Math.max(30, Math.min(height - 40, n.y ?? height / 2));
      }
    };
    if (prefersReducedMotion()) {
      for (let i = 0; i < 300; i++) s.tick();
      clamp();
      setFrame((f) => f + 1);
      return;
    }
    const step = () => {
      s.tick();
      clamp();
      setFrame((f) => f + 1);
      if (s.alpha() > s.alphaMin()) raf.current = requestAnimationFrame(step);
      else raf.current = null;
    };
    if (raf.current === null) raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [nodes, links, width, height]);

  const pos = (n: string | number | GNode | undefined): { x: number; y: number } => {
    const node = typeof n === 'object' ? n : nodesRef.current.get(String(n));
    return { x: node?.x ?? 0, y: node?.y ?? 0 };
  };
  const hovered = hover ? nodesRef.current.get(hover) : null;

  return (
    <div className="absolute inset-0">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="group" aria-label="Validators and their quorum links">
        <defs>
          <clipPath id="bc-qg-clip">
            <rect x={-11} y={-11} width={22} height={22} rx={5} />
          </clipPath>
        </defs>
        <g>
          {links.map((l) => {
            const a = pos(l.source as GNode);
            const b = pos(l.target as GNode);
            const touchesHover = hover !== null && ((l.source as GNode).id === hover || (l.target as GNode).id === hover);
            return (
              <line
                key={l.key}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={l.mine ? 'var(--bc-consensus)' : 'var(--bc-line-strong)'}
                strokeWidth={l.mine ? 2 : 1.25}
                strokeOpacity={hover !== null && !touchesHover ? 0.15 : l.mutual ? 0.85 : 0.4}
                strokeLinecap="round"
              />
            );
          })}
        </g>
        {nodes.map((n) => {
          const { x, y } = pos(n);
          const meta = STATE_META[n.state];
          const dim = hover !== null && hover !== n.id;
          return (
            <g
              key={n.id}
              transform={`translate(${x},${y})`}
              tabIndex={0}
              role="img"
              aria-label={`${n.name}${n.self ? ' (this node)' : ''}: ${meta.label}${n.inMyQuorum ? ', in my quorum set' : ''}`}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover((h) => (h === n.id ? null : h))}
              className="cursor-default outline-none [&:focus-visible>circle.bc-focus]:opacity-100"
              style={{ opacity: dim ? 0.45 : 1, transition: 'opacity 150ms' }}
            >
              <circle r={30} fill="transparent" />
              <circle className="bc-focus" r={27} fill="none" stroke="var(--bc-focus)" strokeWidth={2} opacity={0} />
              {n.self ? <circle r={24} fill="none" stroke="var(--bc-ledger-fill)" strokeWidth={2} strokeOpacity={0.9} /> : null}
              <circle r={19} fill="var(--bc-panel)" stroke={meta.color} strokeWidth={2.5} />
              <g clipPath="url(#bc-qg-clip)">
                <g transform="translate(-11,-11)">
                  <Identicon value={n.id} size={22} />
                </g>
              </g>
              <text y={38} textAnchor="middle" className="fill-fg-2 text-[11px] font-medium" style={{ paintOrder: 'stroke', stroke: 'var(--bc-panel)', strokeWidth: 3 }}>
                {n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name}
              </text>
              {n.self ? (
                <text y={-27} textAnchor="middle" className="fill-ledger text-[9px] font-bold uppercase tracking-wider">
                  you
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded-lg border border-line-strong bg-raised p-3 text-xs shadow-panel"
          style={{
            left: Math.min(Math.max(8, (hovered.x ?? 0) - 112), width - 232),
            top: (hovered.y ?? 0) > height / 2 ? Math.max(4, (hovered.y ?? 0) - 150) : (hovered.y ?? 0) + 46,
          }}
        >
          <div className="flex items-center gap-2">
            <Identicon value={hovered.id} size={20} />
            <span className="truncate text-sm font-semibold text-fg">{hovered.name}</span>
            {hovered.self ? <span className="text-[10px] font-bold uppercase text-ledger">you</span> : null}
          </div>
          <p className="mt-1 font-mono text-[11px] text-fg-3">{middleEllipsis(hovered.id, 8, 8)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StateBadge state={hovered.state} />
            {hovered.inMyQuorum && !hovered.self ? <span className="text-consensus">in my quorum set</span> : null}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-fg-2">
            <dt className="text-fg-3">Ledger</dt>
            <dd className="tabular-nums">{hovered.lcl ? `#${formatNumber(hovered.lcl)}` : '–'}</dd>
            <dt className="text-fg-3">Quorum set</dt>
            <dd>{hovered.qset ? describeQset(hovered.qset) : 'unknown'}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Legend({ selfState }: { selfState: NodeState }) {
  // 'blocked' is only ever this node, and shares its color with 'stalled'
  const states: NodeState[] = ['synced', 'catching-up', 'stalled', ...(selfState === 'blocked' ? (['blocked'] as const) : []), 'offline'];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2.5 text-xs text-fg-3">
      {states.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-full border-2" style={{ borderColor: STATE_META[s].color }} />
          {STATE_META[s].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-3 rounded-full border-2 border-ledger-fill" />
        This node
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-consensus" />
        In my quorum set
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-line-strong" />
        Other quorum links
      </span>
    </div>
  );
}

function ListView({ data }: { data: GraphData }) {
  return (
    <ul className="divide-y divide-line">
      {data.nodes.map((n) => (
        <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <NodeName id={n.id} />
          <div className="flex shrink-0 items-center gap-3 text-xs text-fg-3">
            <span className="hidden sm:inline">{n.qset ? `trusts ${describeQset(n.qset)}` : 'quorum set unknown'}</span>
            {n.inMyQuorum && !n.self ? <span className="text-consensus">in my quorum</span> : null}
            <span className="inline-flex items-center gap-1.5">
              <StateDot state={n.state} />
              {STATE_META[n.state].label}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function QuorumGraph() {
  const validators = useNodeState((s) => s.validators);
  const peers = useNodeState((s) => s.peers);
  const selfId = useNodeState((s) => s.status?.nodeId ?? null);
  const selfState = useNodeState((s) => stateOfSelf(s.status));
  const selfQset = useNodeState((s) => s.status?.quorum.qset ?? null);
  const lcl = useNodeState((s) => s.status?.lcl.seq ?? null);
  const quorum = useNodeState((s) => s.status?.quorum ?? null);
  const [view, setView] = useState<'graph' | 'list'>(() => readPref('browserchain:qgraph:view', 'graph'));
  const [ref, size] = useSize<HTMLDivElement>();
  const width = size.w;
  const height = Math.max(260, size.h);
  const data = useMemo(() => buildGraph(validators, peers, selfId, selfState, selfQset, lcl), [validators, peers, selfId, selfState, selfQset, lcl]);

  return (
    <Card
      title="Quorum network"
      subtitle={quorum ? `My quorum set: ${describeQset(quorum.qset)} · tolerates ${quorum.faultTolerance} failure${quorum.faultTolerance === 1 ? '' : 's'}` : undefined}
      icon={Waypoints}
      iconClass="text-network"
      fill
      bodyClass="p-0"
      actions={
        <Segmented
          label="Quorum network view"
          size="sm"
          value={view}
          onChange={(v) => {
            setView(v);
            writePref('browserchain:qgraph:view', v);
          }}
          options={[
            { value: 'graph', label: 'Graph', icon: Share2 },
            { value: 'list', label: 'List', icon: List },
          ]}
        />
      }
    >
      <div ref={ref} className={cx('bc-grid-bg relative min-h-[280px] flex-1 overflow-hidden sm:min-h-[340px]', view === 'list' && 'hidden')}>
        {validators.length && size.w > 0 ? <Graph data={data} width={width} height={height} /> : null}
      </div>
      {view === 'list' ? (
        <div className="flex-1">
          <ListView data={data} />
        </div>
      ) : null}
      <Legend selfState={selfState} />
    </Card>
  );
}
