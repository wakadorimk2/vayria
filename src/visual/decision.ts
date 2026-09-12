import { readVisualIntent, visualIntentSchema, type VisualIntent } from './types.js';

// Only unambiguous, current imperatives constrain the model. Other language stays contextual.
export function explicitVisualSubject(input: string | null | undefined): string | null {
  const text = input?.normalize('NFKC').trim();
  if (!text || /[「」『』"“”\n]|ない|なく|なかった|禁止|もし|なら|たら|場合|昨日|さっき|以前|と言|って言/.test(text)) return null;
  const match = /^(?:お願い[、, ]*)?(?:近くに|目の前に|ここに|そこに)?(.{1,60}?)を(?:出して|作って|召喚して)(?:ください|下さい|ほしい|欲しい)?[!！。〜～ ]*$/.exec(text);
  const subject = match?.[1].trim();
  return subject && !/^(それ|これ|あれ|何か|なにか|何|なに)$/.test(subject) ? subject : null;
}

export function visualDecisionSchema(required: boolean, subject?: string | null) {
  return required ? { ...visualIntentSchema, properties: { ...visualIntentSchema.properties,
    type: { type: 'string', enum: ['prop'] }, action: { type: 'string', enum: ['add'] },
    concept: subject ? { type: 'string', enum: [subject] } : { type: 'string', minLength: 1 },
  } } : visualIntentSchema;
}

export function validVisualDecision(value: unknown, required: boolean, subject?: string | null): VisualIntent | null {
  const intent = readVisualIntent(value);
  return intent && (!required || (intent.type === 'prop' && intent.action === 'add' && (!subject || intent.concept === subject))) ? intent : null;
}
