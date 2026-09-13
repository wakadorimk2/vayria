import { WorldError, validId } from './state.js';

export const CONVERSATION_DEFAULTS = { capacity: 10, cooldownMs: 3000, waitMs: 120000, recordingMs: 30000, executionMs: 180000 };
export interface ConversationSlot {
  id: string; actor: string; visitor: string; session: string; priority: number;
  at: number; expires: number; kind: 'text' | 'voice' | 'autonomous'; text?: string;
  status: 'waiting' | 'granted' | 'running';
}
export interface SharedReply {
  id: string; text: string; emotion: string; motion?: string; audioUrl?: string;
  startsAt: number; endsAt: number; error?: string;
}
export interface RoomConversation {
  queue: ConversationSlot[]; active: ConversationSlot | null;
  history: { role: 'user' | 'assistant'; content: string }[];
  reply: SharedReply | null; receipts: { id: string; actor: string; at: number }[];
  lastAutonomousAt: number;
  lastAutonomousSequence?: number;
}
export const createRoomConversation = (): RoomConversation => ({ queue: [], active: null, history: [], reply: null, receipts: [], lastAutonomousAt: 0 });
export function advanceConversation(c: RoomConversation, now: number, connected?: Set<string>) {
  c.queue = c.queue.filter(s => s.expires > now && (!connected || connected.has(s.actor)));
  if (c.active && (c.active.expires <= now || (c.active.status !== 'running' && connected && !connected.has(c.active.actor)))) c.active = null;
  if (c.reply && c.reply.endsAt <= now) c.reply = null;
  if (!c.active && !c.reply && c.queue.length) {
    c.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    c.active = c.queue.shift()!;
    c.active.status = 'granted';
    c.active.expires = now + CONVERSATION_DEFAULTS.recordingMs;
  }
}
export function reserveConversation(c: RoomConversation, slot: Omit<ConversationSlot, 'status' | 'at' | 'expires' | 'priority'>, now: number) {
  if (!validId(slot.id) || !slot.actor || !slot.visitor || !slot.session || !['voice','text','autonomous'].includes(slot.kind)) throw new WorldError('invalid_slot', 400);
  if (slot.kind === 'text' && (!slot.text?.trim() || slot.text.length > 2000)) throw new WorldError('invalid_message', 400);
  if (c.receipts.some(r => r.id === slot.id && r.actor === slot.actor)) return;
  if (c.queue.some(s => s.actor === slot.actor) || c.active?.actor === slot.actor) throw new WorldError('already_waiting', 409);
  if (c.receipts.some(r => r.actor === slot.actor && now - r.at < CONVERSATION_DEFAULTS.cooldownMs)) throw new WorldError('conversation_cooldown', 429);
  if (c.queue.length >= CONVERSATION_DEFAULTS.capacity) throw new WorldError('conversation_full', 429);
  c.queue.push({ ...slot, text: slot.text?.trim(), status: 'waiting', priority: 0, at: now, expires: now + CONVERSATION_DEFAULTS.waitMs });
  c.receipts = [...c.receipts, { id: slot.id, actor: slot.actor, at: now }].slice(-256);
  advanceConversation(c, now);
}
export function cancelConversation(c: RoomConversation, actor: string, id: string) {
  // Cancellation can arrive before the reservation on another connection.
  if(validId(id)&&!c.receipts.some(r=>r.id===id&&r.actor===actor))c.receipts=[...c.receipts,{id,actor,at:0}].slice(-256);
  c.queue = c.queue.filter(s => s.actor !== actor || s.id !== id);
  // Already executing paid work is never reissued or globally interrupted.
  if (c.active?.actor === actor && c.active.id === id && c.active.status !== 'running') c.active = null;
}
export function conversationView(c: RoomConversation, actor: string) {
  const own = c.active?.actor === actor ? c.active : c.queue.find(s => s.actor === actor);
  return { reply: c.reply, waiting: c.queue.length, busy: !!c.active || !!c.reply,
    slot: own ? { id: own.id, status: own.status, expires: own.expires, position: own === c.active ? 0 : c.queue.indexOf(own) + 1 } : null };
}
