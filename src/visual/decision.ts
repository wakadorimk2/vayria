import { readVisualIntent, visualIntentSchema, type VisualIntent } from './types.js';

// Only unambiguous, current imperatives constrain the model. Other language stays contextual.
export function explicitVisualSubject(input: string | null | undefined): string | null {
  const text = input?.normalize('NFKC').trim();
  if (!text || /[「」『』"“”\n]|ない|なく|なかった|禁止|もし|なら|たら|場合|昨日|さっき|以前|と言|って言/.test(text)) return null;
  const match = /^(?:お願い[、, ]*)?(?:近くに|目の前に|ここに|そこに)?(.{1,60}?)を(?:出して|作って|召喚して)(?:ください|下さい|ほしい|欲しい)?[!！。〜～ ]*$/.exec(text);
  const subject = match?.[1].trim();
  return subject && !/^(それ|これ|あれ|何か|なにか|何|なに)$/.test(subject) ? subject : null;
}

// Language aliases, not an allowlist. Unknown objects remain available through the same LLM.
export function canonicalVisualSubject(subject?: string | null): string | null {
  const aliases: Record<string, string> = { 'プリン':'pudding', '鶏':'chicken', 'ニワトリ':'chicken', 'にわとり':'chicken', 'ボール':'ball', '肉':'meat', '卵':'egg', '羽根':'feather', 'バット':'bat' };
  return subject ? aliases[subject] ?? null : null;
}

export function visualDecisionSchema(required: boolean, subject?: string | null) {
  const canonical = canonicalVisualSubject(subject);
  return required ? { ...visualIntentSchema, properties: { ...visualIntentSchema.properties,
    type: { type: 'string', enum: ['prop'] }, action: { type: 'string', enum: ['add'] },
    concept: canonical ? { type: 'string', enum: [canonical] } : { type: 'string', minLength: 1, pattern: '^[A-Za-z][A-Za-z0-9 ,\\x27-]*$' },
  } } : visualIntentSchema;
}

export function validVisualDecision(value: unknown, required: boolean, subject?: string | null): VisualIntent | null {
  const intent = readVisualIntent(value);
  const canonical = canonicalVisualSubject(subject);
  return intent && (!required || (intent.type === 'prop' && intent.action === 'add' && /^[A-Za-z][A-Za-z0-9 ,'-]*$/.test(intent.concept) && (!canonical || intent.concept === canonical))) ? intent : null;
}
