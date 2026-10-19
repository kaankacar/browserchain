// Codec between the in-memory SCP types (./types) and the @stellar/stellar-sdk/base
// xdr.ScpEnvelope / xdr.ScpStatement / xdr.ScpQuorumSet (Stellar-SCP.x), plus
// the envelope signature payload (ARCHITECTURE 5.3).

import { StrKey, xdr, type Keypair } from '@stellar/stellar-sdk/base';
import { concatBytes, fromBase64, fromHex, toBase64, toHex, writeUint32BE } from '../lib/bytes';
import { sha256Hex } from '../lib/hash';
import { signHex, verifyHex } from '../lib/keys';
import { nodeIdRawKey } from './hash';
import type { Ballot, Envelope, Hash, NodeId, Pledges, QuorumSet, Statement } from './types';

/** EnvelopeType.ENVELOPE_TYPE_SCP */
export const ENVELOPE_TYPE_SCP = 1;

type XdrInput<T> = T | string | Uint8Array;

function hash32(hex: Hash): Uint8Array {
  const b = fromHex(hex);
  if (b.length !== 32) throw new Error(`hash must be 32 bytes, got ${b.length}`);
  return b;
}

/** Base64 string or raw XDR bytes -> bytes. */
function asBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? fromBase64(input) : input;
}

// ---------------------------------------------------------------------------
// Node ids, ballots, quorum sets

export function nodeIdToXdr(nodeId: NodeId): xdr.PublicKey {
  return xdr.PublicKey.publicKeyTypeEd25519(nodeIdRawKey(nodeId));
}

export function nodeIdFromXdr(pk: xdr.PublicKey): NodeId {
  if (pk.type !== 'publicKeyTypeEd25519') throw new Error('unsupported node id type');
  return StrKey.encodeEd25519PublicKey(pk.ed25519.toBytes());
}

export function ballotToXdr(b: Ballot): xdr.ScpBallot {
  return new xdr.ScpBallot({ counter: b.counter, value: fromHex(b.value) });
}

export function ballotFromXdr(x: xdr.ScpBallot): Ballot {
  return { counter: x.counter, value: toHex(x.value.toBytes()) };
}

function optBallotFromXdr(x: xdr.ScpBallot | null | undefined): Ballot | null {
  return x ? ballotFromXdr(x) : null;
}

export function qsetToXdr(q: QuorumSet): xdr.ScpQuorumSet {
  return new xdr.ScpQuorumSet({
    threshold: q.threshold,
    validators: q.validators.map(nodeIdToXdr),
    innerSets: q.innerSets.map(qsetToXdr),
  });
}

function qsetFromXdrObject(x: xdr.ScpQuorumSet): QuorumSet {
  return {
    threshold: x.threshold,
    validators: x.validators.map(nodeIdFromXdr),
    innerSets: x.innerSets.map(qsetFromXdrObject),
  };
}

/** Accepts an xdr.ScpQuorumSet, its base64 string or its raw XDR bytes. */
export function qsetFromXdr(input: XdrInput<xdr.ScpQuorumSet>): QuorumSet {
  const x = input instanceof xdr.ScpQuorumSet ? input : xdr.ScpQuorumSet.fromXdr(asBytes(input));
  return qsetFromXdrObject(x);
}

export function qsetToBytes(q: QuorumSet): Uint8Array {
  return qsetToXdr(q).toXdr();
}

export function qsetToBase64(q: QuorumSet): string {
  return toBase64(qsetToBytes(q));
}

/** SHA-256 of the xdr.ScpQuorumSet XDR, validators in the given order. */
export function hashQuorumSet(q: QuorumSet): Hash {
  return sha256Hex(qsetToBytes(q));
}

// ---------------------------------------------------------------------------
// Statements

function pledgesToXdr(p: Pledges): xdr.ScpStatementPledges {
  switch (p.type) {
    case 'prepare':
      return xdr.ScpStatementPledges.scpStPrepare(
        new xdr.ScpStatementPrepare({
          quorumSetHash: hash32(p.quorumSetHash),
          ballot: ballotToXdr(p.ballot),
          prepared: p.prepared ? ballotToXdr(p.prepared) : null,
          preparedPrime: p.preparedPrime ? ballotToXdr(p.preparedPrime) : null,
          nC: p.nC,
          nH: p.nH,
        }),
      );
    case 'confirm':
      return xdr.ScpStatementPledges.scpStConfirm(
        new xdr.ScpStatementConfirm({
          ballot: ballotToXdr(p.ballot),
          nPrepared: p.nPrepared,
          nCommit: p.nCommit,
          nH: p.nH,
          quorumSetHash: hash32(p.quorumSetHash),
        }),
      );
    case 'externalize':
      return xdr.ScpStatementPledges.scpStExternalize(
        new xdr.ScpStatementExternalize({
          commit: ballotToXdr(p.commit),
          nH: p.nH,
          commitQuorumSetHash: hash32(p.commitQuorumSetHash),
        }),
      );
    case 'nominate':
      return xdr.ScpStatementPledges.scpStNominate(
        new xdr.ScpNomination({
          quorumSetHash: hash32(p.quorumSetHash),
          votes: p.votes.map((v) => fromHex(v)),
          accepted: p.accepted.map((v) => fromHex(v)),
        }),
      );
    default:
      throw new Error(`unknown statement type ${(p as { type: string }).type}`);
  }
}

function pledgesFromXdr(pl: xdr.ScpStatementPledges): Pledges {
  switch (pl.type) {
    case 'scpStPrepare': {
      const p = pl.prepare;
      return {
        type: 'prepare',
        quorumSetHash: toHex(p.quorumSetHash.toBytes()),
        ballot: ballotFromXdr(p.ballot),
        prepared: optBallotFromXdr(p.prepared),
        preparedPrime: optBallotFromXdr(p.preparedPrime),
        nC: p.nC,
        nH: p.nH,
      };
    }
    case 'scpStConfirm': {
      const c = pl.confirm;
      return {
        type: 'confirm',
        ballot: ballotFromXdr(c.ballot),
        nPrepared: c.nPrepared,
        nCommit: c.nCommit,
        nH: c.nH,
        quorumSetHash: toHex(c.quorumSetHash.toBytes()),
      };
    }
    case 'scpStExternalize': {
      const e = pl.externalize;
      return {
        type: 'externalize',
        commit: ballotFromXdr(e.commit),
        nH: e.nH,
        commitQuorumSetHash: toHex(e.commitQuorumSetHash.toBytes()),
      };
    }
    case 'scpStNominate': {
      const n = pl.nominate;
      return {
        type: 'nominate',
        quorumSetHash: toHex(n.quorumSetHash.toBytes()),
        votes: n.votes.map((v) => toHex(v.toBytes())),
        accepted: n.accepted.map((v) => toHex(v.toBytes())),
      };
    }
    default:
      throw new Error('unknown statement type');
  }
}

export function statementToXdr(st: Statement): xdr.ScpStatement {
  if (!Number.isSafeInteger(st.slotIndex) || st.slotIndex < 0) throw new Error(`bad slot index ${st.slotIndex}`);
  return new xdr.ScpStatement({
    nodeId: nodeIdToXdr(st.nodeId),
    slotIndex: BigInt(st.slotIndex),
    pledges: pledgesToXdr(st.pledges),
  });
}

function statementFromXdrObject(x: xdr.ScpStatement): Statement {
  const slot = x.slotIndex;
  if (slot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('slot index too large');
  return { nodeId: nodeIdFromXdr(x.nodeId), slotIndex: Number(slot), pledges: pledgesFromXdr(x.pledges) };
}

/** Accepts an xdr.ScpStatement, its base64 string or its raw XDR bytes. */
export function statementFromXdr(input: XdrInput<xdr.ScpStatement>): Statement {
  const x = input instanceof xdr.ScpStatement ? input : xdr.ScpStatement.fromXdr(asBytes(input));
  return statementFromXdrObject(x);
}

export function statementToBytes(st: Statement): Uint8Array {
  return statementToXdr(st).toXdr();
}

// ---------------------------------------------------------------------------
// Envelopes

export function envelopeToXdr(env: Envelope): xdr.ScpEnvelope {
  return new xdr.ScpEnvelope({ statement: statementToXdr(env.statement), signature: fromHex(env.signature) });
}

export function envelopeToBytes(env: Envelope): Uint8Array {
  return envelopeToXdr(env).toXdr();
}

/** Wire form: base64 of the xdr.ScpEnvelope. */
export function envelopeToBase64(env: Envelope): string {
  return toBase64(envelopeToBytes(env));
}

/** Accepts an xdr.ScpEnvelope, its base64 string or its raw XDR bytes. Throws if malformed. */
export function envelopeFromXdr(input: XdrInput<xdr.ScpEnvelope>): Envelope {
  const x = input instanceof xdr.ScpEnvelope ? input : xdr.ScpEnvelope.fromXdr(asBytes(input));
  return { statement: statementFromXdrObject(x.statement), signature: toHex(x.signature.toBytes()) };
}

export function envelopeFromBase64(b64: string): Envelope {
  return envelopeFromXdr(b64);
}

/** SHA-256 (hex) of the envelope XDR. Identifies an envelope (dedupe, logs). */
export function envelopeHash(env: Envelope): Hash {
  return sha256Hex(envelopeToBytes(env));
}

// ---------------------------------------------------------------------------
// Signatures

function networkIdBytes(networkId: Uint8Array | Hash): Uint8Array {
  const b = typeof networkId === 'string' ? fromHex(networkId) : networkId;
  if (b.length !== 32) throw new Error('network id must be 32 bytes');
  return b;
}

/** networkId(32) || int32BE(ENVELOPE_TYPE_SCP) || statement XDR. */
export function statementSignaturePayload(networkId: Uint8Array | Hash, statement: Statement): Uint8Array {
  return concatBytes(networkIdBytes(networkId), writeUint32BE(ENVELOPE_TYPE_SCP), statementToBytes(statement));
}

/** Fill env.signature (hex) with the node key's signature over the payload. */
export function signEnvelope(env: Envelope, keypair: Keypair, networkId: Uint8Array | Hash): void {
  env.signature = signHex(keypair, statementSignaturePayload(networkId, env.statement));
}

/** Check env.signature against the statement's node id. Never throws. */
export function verifyEnvelope(env: Envelope, networkId: Uint8Array | Hash): boolean {
  try {
    return verifyHex(env.statement.nodeId, statementSignaturePayload(networkId, env.statement), env.signature);
  } catch {
    return false;
  }
}
