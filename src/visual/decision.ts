import { readVisualIntent, visualIntentSchema, type VisualIntent } from './types.js';

// Only unambiguous, current imperatives constrain the model. Other language stays contextual.
export function explicitVisualSubject(input: string | null | undefined): string | null {
  const text = input?.normalize('NFKC').trim();
  if (!text || /[「」『』"“”\n]|ない|なく|なかった|禁止|もし|なら|たら|場合|昨日|さっき|以前|と言|って言/.test(text)) return null;
  const match = /^(?:お願い[、, ]*)?(?:近くに|目の前に|ここに|そこに)?(.{1,60}?)を(?:出して|作って|召喚して)(?:ください|下さい|ほしい|欲しい)?[!！。〜～ ]*$/.exec(text);
  const subject = match?.[1].trim();
  return subject && !/^(それ|これ|あれ|何か|なにか|何|なに)$/.test(subject) ? subject : null;
}

export function explicitMotionSubject(input: string | null | undefined): string | null {
  const text=input?.normalize('NFKC').trim();
  if(text && /浮か|回転|拡大|大きく|きらきら|揺ら|光ら/.test(text))return null;
  if(!text || /[「」『』"“”\n]|ない|なく|なかった|もし|なら|たら|場合|昨日|以前|と言|って言/.test(text))return null;
  const subject=/^(.{1,40}?)(?:を|に).{1,30}?(?:させて|せて)(?:ください|ほしい)?[!！。 ]*$/.exec(text)?.[1]
    ?? /^(?:歩く|踊る|ダンスする|動く|走る|跳ねる|飛ぶ)(.{1,40}?)を(?:出して|作って)(?:ください)?[!！。 ]*$/.exec(text)?.[1];
  return subject && !/^(それ|これ|あれ|何か)$/.test(subject)?subject:null;
}

// Language aliases, not an allowlist. Unknown objects remain available through the same LLM.
export function canonicalVisualSubject(subject?: string | null): string | null {
  const aliases: Record<string, string> = { 'エビ':'shrimp', 'えび':'shrimp', '海老':'shrimp', 'カニ':'crab', 'かに':'crab', 'みかん':'mandarin orange', 'ミカン':'mandarin orange', 'プリン':'pudding', '鶏':'chicken', 'ニワトリ':'chicken', 'にわとり':'chicken', 'ボール':'ball', '肉':'meat', '卵':'egg', '羽根':'feather', 'バット':'bat' };
  return subject ? aliases[subject] ?? null : null;
}

export function visualDecisionSchema(required: boolean, subject?: string | null, motionInput?: string) {
  const canonical = canonicalVisualSubject(subject);
  const motion=motionInput&&/^(歩く|走る|踊る|ダンスする)/.exec(motionInput)?.[1];
  const actionMotion=motion?({'歩く':'walk','走る':'run','踊る':'dance','ダンスする':'dance'} as Record<string,string>)[motion]:undefined;
  return required ? { ...visualIntentSchema, properties: { ...visualIntentSchema.properties,
    type: { type: 'string', enum: ['prop'] }, action: { type: 'string', enum: motionInput ? ['add','replace'] : ['add'] },
    ...(motionInput ? {motion:{type:'string',minLength:1,maxLength:120},motionEvidence:{type:'string',enum:[motionInput]}}:{}),
    ...(actionMotion?{motion:{type:'string',enum:[actionMotion]}}:{}),
    ...(canonical?{modifiers:{type:'array',items:{type:'string'},maxItems:0},sharing:{type:'string',enum:['general']}}:{}),
    concept: canonical ? { type: 'string', enum: [canonical] } : { type: 'string', minLength: 1, pattern: '^[A-Za-z][A-Za-z0-9 ,\\x27-]*$' },
  } } : visualIntentSchema;
}

export function validVisualDecision(value: unknown, required: boolean, subject?: string | null, motionInput?: string): VisualIntent | null {
  const intent = readVisualIntent(value);
  const canonical = canonicalVisualSubject(subject);
  return intent && (!required || (intent.type === 'prop' && (intent.action === 'add' || (motionInput && intent.action === 'replace')) && (!motionInput || (intent.motion.trim().length>0 && intent.motionEvidence===motionInput)) && /^[A-Za-z][A-Za-z0-9 ,'-]*$/.test(intent.concept) && (!canonical || intent.concept === canonical))) ? intent : null;
}
