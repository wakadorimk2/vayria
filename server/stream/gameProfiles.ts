export interface GameProfile {
  id: string;
  displayName: string;
  eventKinds: readonly string[];
  buildObservationInstruction(): string;
}

export const SEVEN_DAYS_TO_DIE_PROFILE: GameProfile = {
  id: '7dtd',
  displayName: '7 Days to Die',
  eventKinds: [
    'enemy_visible',
    'combat',
    'player_damaged',
    'player_died',
    'gathering',
    'building',
    'container',
    'menu',
    'environment_change',
    'time_change',
    'vehicle',
    'quest',
    'player_state',
    'other',
  ],
  buildObservationInstruction() {
    return [
      `You observe gameplay of ${this.displayName}.`,
      'You receive two screenshots: BEFORE (earlier) and AFTER (later), captured several seconds apart.',
      'Report only meaningful gameplay or scene changes between the two frames.',
      'Ignore:',
      '- ordinary camera movement, looking around, and viewpoint drift',
      '- HUD ticking (crosshair, compass motion, small number changes)',
      '- continuing activity that was already in progress in BEFORE',
      'Set changed=false when nothing meaningful happened.',
      'List at most 4 events, most significant first.',
      'Keep every summary short, factual, and neutral. Do not role-play, do not address anyone, do not speculate beyond what is visible.',
      'Use the activity field for a short verb phrase describing what the player is currently doing (for example "mining", "fighting zombies", "looting a container", "idle in menu").',
    ].join('\n');
  },
};

export function resolveGameProfile(id: string | undefined): GameProfile | null {
  if (!id || id === SEVEN_DAYS_TO_DIE_PROFILE.id) {
    return SEVEN_DAYS_TO_DIE_PROFILE;
  }
  return null;
}

export function streamObservationSchema(
  profile: GameProfile,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['changed', 'changeSummary', 'events', 'scene', 'player'],
    properties: {
      changed: {
        type: 'boolean',
        description:
          'Whether a meaningful gameplay or scene change happened between BEFORE and AFTER.',
      },
      changeSummary: {
        type: 'string',
        description:
          'One short neutral sentence describing the most important change, or empty when changed is false.',
      },
      events: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'summary', 'significance'],
          properties: {
            kind: {
              type: 'string',
              enum: [...profile.eventKinds],
            },
            summary: {
              type: 'string',
              description: 'Short neutral description of the event.',
            },
            significance: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
            },
          },
        },
      },
      scene: {
        type: 'object',
        additionalProperties: false,
        required: ['setting', 'timeOfDay', 'bloodMoon'],
        properties: {
          setting: {
            type: 'string',
            enum: ['outdoor', 'indoor', 'underground', 'menu', 'loading', 'unknown'],
          },
          timeOfDay: {
            type: 'string',
            enum: ['day', 'dusk', 'night', 'dawn', 'unknown'],
          },
          bloodMoon: {
            type: 'boolean',
            description: 'Whether the sky or lighting indicates a blood moon night.',
          },
        },
      },
      player: {
        type: 'object',
        additionalProperties: false,
        required: ['activity', 'healthState'],
        properties: {
          activity: {
            type: 'string',
            description: 'Short verb phrase for the current player activity.',
          },
          healthState: {
            type: 'string',
            enum: ['ok', 'hurt', 'critical', 'dead', 'unknown'],
          },
        },
      },
    },
  };
}
