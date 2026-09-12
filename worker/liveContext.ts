import { cardPool } from '../src/cards/cardPool';
import { DEFAULT_CHARACTER_IDENTITY } from '../src/character/identity';
import type { LiveCardContext } from '../src/live/liveProtocol';
import { LimitError } from './ledger';

export function readLiveCards(value: unknown): LiveCardContext {
  if (!value || typeof value !== 'object') throw new LimitError('invalid_live_cards', 0, 400);
  const c = value as LiveCardContext;
  if (!Number.isSafeInteger(c.swapRevision) || c.swapRevision < 0 ||
    !Array.isArray(c.brainCardIds) || c.brainCardIds.length > 8 ||
    new Set(c.brainCardIds).size !== c.brainCardIds.length ||
    c.brainCardIds.some(id => typeof id !== 'string' || !cardPool.some(card => card.id === id)) ||
    (c.forcedCardId !== null && !c.brainCardIds.includes(c.forcedCardId))) {
    throw new LimitError('invalid_live_cards', 0, 400);
  }
  return { swapRevision: c.swapRevision, brainCardIds: [...c.brainCardIds], forcedCardId: c.forcedCardId };
}

// Adapt the spoken style in server/localApiSupport.ts VOICE_REPLY_INSTRUCTION.
// Its legacy JSON actions do not belong to the Live audio protocol.
export const LIVE_INSTRUCTIONS = `あなたは${DEFAULT_CHARACTER_IDENTITY.canonicalName}（${DEFAULT_CHARACTER_IDENTITY.displayName}）。日本語で短く自然に会話するキャラクターです。
普段は8〜24文字程度の短いひとまとまりで返し、長くても短い節を2つまでにしてください。内容のある発話には具体的な話題や気持ちを1つ拾って反応してください。直接の質問には短く答えてください。
言いよどみや小さな言い直しは自然なら構いません。講義や定型の挨拶をせず、単なる同意だけを繰り返さないでください。
相手の話を聞き、相づちや言い直しを自然な間で行ってください。毎回質問で終わらないでください。
アプリが送るカードは、会話中に変わる世界の状態です。最新の完全な配置だけを有効とし、外れたカードの効果を持ち越さないでください。
カードの変更だけで発話を遮らず、相手の話を聞き切ってから自然な間や返答に反映してください。強調されたカードも強制割り込みではありません。
カード一覧や内部処理の説明を読み上げるのではなく、カードの効果を会話に自然に表してください。
この実験では外部ツールと別のLLMは使えません。通常の会話とカードへの反応は自分で行い、外部で何かを実行したと主張しないでください。
話者の個人識別や、人の外見・感情の断定はしないでください。`;

/** UTF-8 byte count is a conservative upper bound for byte-BPE tokens.
 * Each append stays below 500 tokens without an extra model request. */
export function liveCardAppends(cards: LiveCardContext): string[] {
  const text = `カード配置 revision=${cards.swapRevision}。有効: ${cards.brainCardIds.join(', ') || 'なし'}。強調: ${cards.forcedCardId ?? 'なし'}。\n` +
    cards.brainCardIds.map(id => { const c = cardPool.find(c => c.id === id)!; return `${c.id}（${c.label}）: ${c.prompt}`; }).join('\n');
  const chunks: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (new TextEncoder().encode(chunk + char).length > 380) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part, index) => `配置${cards.swapRevision} part ${index + 1}/${chunks.length}。全partが届いた配置を使う。\n${part}`);
}
