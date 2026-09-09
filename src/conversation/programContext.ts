export const PROGRAM_FORMATS = ['card_impression'] as const;
export type ProgramFormat = (typeof PROGRAM_FORMATS)[number];

export const PROGRAM_PARTICIPANT_ROLES = ['viewer_directed'] as const;
export type ProgramParticipantRole =
  (typeof PROGRAM_PARTICIPANT_ROLES)[number];

export const PROGRAM_OBJECTIVES = ['notice_card_change'] as const;
export type ProgramObjective = (typeof PROGRAM_OBJECTIVES)[number];

export const PROGRAM_PHASES = [
  'before_card_change',
  'after_card_change',
] as const;
export type ProgramPhase = (typeof PROGRAM_PHASES)[number];

export interface ProgramContext {
  worldContext?: string;
  format: ProgramFormat;
  participantRole: ProgramParticipantRole;
  objective: ProgramObjective;
  phase: ProgramPhase;
}

export const DEFAULT_PROGRAM_CONTEXT: ProgramContext = {
  format: 'card_impression',
  participantRole: 'viewer_directed',
  objective: 'notice_card_change',
  phase: 'before_card_change',
};

export function isProgramPhase(value: unknown): value is ProgramPhase {
  return (
    typeof value === 'string' &&
    (PROGRAM_PHASES as readonly string[]).includes(value)
  );
}

export function isProgramContext(value: unknown): value is ProgramContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(key => ['format', 'participantRole', 'objective', 'phase', 'worldContext'].includes(key)) &&
    (record.worldContext === undefined || (typeof record.worldContext === 'string' && record.worldContext.length <= 12000)) &&
    record.format === DEFAULT_PROGRAM_CONTEXT.format &&
    record.participantRole === DEFAULT_PROGRAM_CONTEXT.participantRole &&
    record.objective === DEFAULT_PROGRAM_CONTEXT.objective &&
    isProgramPhase(record.phase)
  );
}
