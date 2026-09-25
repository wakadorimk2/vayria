// Probe Gemini responseSchema acceptance with the real observation schema.
const schema = {
  type: 'object',
  required: ['changed', 'changeSummary', 'events', 'scene', 'player'],
  properties: {
    changed: { type: 'boolean', description: 'x' },
    changeSummary: { type: 'string', description: 'x' },
    events: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        required: ['kind', 'summary', 'significance'],
        properties: {
          kind: {
            type: 'string',
            enum: [
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
          },
          summary: { type: 'string', description: 'x' },
          significance: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
    scene: {
      type: 'object',
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
        bloodMoon: { type: 'boolean', description: 'x' },
      },
    },
    player: {
      type: 'object',
      required: ['activity', 'healthState'],
      properties: {
        activity: { type: 'string', description: 'x' },
        healthState: {
          type: 'string',
          enum: ['ok', 'hurt', 'critical', 'dead', 'unknown'],
        },
      },
    },
  },
};

const res = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with any JSON.' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 256,
      },
    }),
  },
);
console.log('status', res.status);
const text = await res.text();
console.log(text.slice(0, 1500));
