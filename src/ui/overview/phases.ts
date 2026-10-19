import { BadgeCheck, CheckCheck, ListChecks, Vote, type LucideIcon } from 'lucide-react';
import type { ScpNodeStateView, ScpPhase } from '../../node/api';

export interface PhaseMeta {
  phase: ScpPhase;
  label: string;
  icon: LucideIcon;
  blurb: string;
  /** CSS color token of the validated violet ordinal ramp. */
  color: string;
  bg: string;
  text: string;
}

export const PHASES: PhaseMeta[] = [
  { phase: 'NOMINATE', label: 'Nominate', icon: Vote, blurb: 'pick candidate values', color: 'var(--bc-phase-1)', bg: 'bg-phase-1', text: 'text-phase-1' },
  { phase: 'PREPARE', label: 'Prepare', icon: ListChecks, blurb: 'prepare a ballot', color: 'var(--bc-phase-2)', bg: 'bg-phase-2', text: 'text-phase-2' },
  { phase: 'CONFIRM', label: 'Confirm', icon: CheckCheck, blurb: 'commit the ballot', color: 'var(--bc-phase-3)', bg: 'bg-phase-3', text: 'text-phase-3' },
  { phase: 'EXTERNALIZE', label: 'Externalize', icon: BadgeCheck, blurb: 'value is final', color: 'var(--bc-phase-4)', bg: 'bg-phase-4', text: 'text-phase-4' },
];

export function phaseIndex(p: ScpPhase): number {
  return PHASES.findIndex((x) => x.phase === p);
}

/** 0 = no statement yet, 1..4 = nominate..externalize. */
export function statementRank(s: ScpNodeStateView['statement']): number {
  switch (s) {
    case 'nominate':
      return 1;
    case 'prepare':
      return 2;
    case 'confirm':
      return 3;
    case 'externalize':
      return 4;
    default:
      return 0;
  }
}

export const STATEMENT_LABEL: Record<ScpNodeStateView['statement'], string> = {
  none: 'No statement',
  nominate: 'Nominate',
  prepare: 'Prepare',
  confirm: 'Confirm',
  externalize: 'Externalize',
};
