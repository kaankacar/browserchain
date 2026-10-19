// Byzantine behaviour for the simulation, plugged in through the herder's
// emit interceptor: the node signs conflicting statements and sends a
// different version to each half of its peers.

import type { EmitApi, EmitInterceptor } from '../herder/herder';
import { decodeValue } from '../herder/values';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import type { Envelope, NominatePledge, Value } from '../scp/types';
import { signEnvelope } from '../scp/xdr';

export interface ByzantineStats {
  /** Envelopes sent in two conflicting versions. */
  equivocations: number;
}

/** A valid value of ours: same tx set as `v`, later close time, signed by us. */
function altValue(api: EmitApi, v: Value, bump: number): Value | null {
  const info = decodeValue(v);
  if (!info) return null;
  return encodeStellarValue(makeSignedStellarValue(api.networkId, api.keypair, info.txSetHash, info.closeTime + bump));
}

function signed(api: EmitApi, env: Envelope): Envelope {
  signEnvelope(env, api.keypair, api.networkId);
  return env;
}

/**
 * Equivocating validator. Nominations: each half of the peers sees an ever
 * growing vote set with a value only it gets. Ballots (when `ballots`): the
 * second half sees PREPARE statements for another value at the same counter.
 */
export function equivocator(opts: { ballots: boolean }, stats: ByzantineStats = { equivocations: 0 }): EmitInterceptor {
  const growing = new Map<string, { votes: Set<Value>; accepted: Set<Value> }>();
  return (env, api) => {
    const st = env.statement;
    const peers = api.peers().sort();
    if (peers.length < 2) return false;
    const groups = [peers.filter((_, i) => i % 2 === 0), peers.filter((_, i) => i % 2 === 1)];
    const p = st.pledges;
    if (p.type === 'nominate') {
      const base = p.votes[0] ?? p.accepted[0];
      if (!base) return false;
      groups.forEach((group, g) => {
        const key = `${st.slotIndex}:${g}`;
        let s = growing.get(key);
        if (!s) {
          s = { votes: new Set(), accepted: new Set() };
          growing.set(key, s);
        }
        for (const v of p.votes) s.votes.add(v);
        for (const v of p.accepted) s.accepted.add(v);
        const own = altValue(api, base, g + 1);
        if (own) s.votes.add(own);
        const pledges: NominatePledge = { ...p, votes: [...s.votes].sort(), accepted: [...s.accepted].sort() };
        const variant = signed(api, { statement: { ...st, pledges }, signature: '' });
        for (const peer of group) api.send(peer, variant);
      });
      stats.equivocations++;
      return true;
    }
    if (opts.ballots && p.type === 'prepare') {
      const alt = altValue(api, p.ballot.value, 7);
      if (!alt) return false;
      const variant = signed(api, {
        statement: { ...st, pledges: { ...p, ballot: { counter: p.ballot.counter, value: alt } } },
        signature: '',
      });
      for (const peer of groups[0]) api.send(peer, env);
      for (const peer of groups[1]) api.send(peer, variant);
      stats.equivocations++;
      return true;
    }
    return false;
  };
}
