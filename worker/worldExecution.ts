import type { ConversationSlot } from '../src/sharedWorld/conversation';
import type { SharedWorldState, WorldElement } from '../src/sharedWorld/state';

export interface WorldExecutionInput {
  roomId:string; epoch:number; slot:ConversationSlot;
  history:{role:'user'|'assistant';content:string}[]; context:string; brainCardIds:string[];
}
export interface WorldExecutionResult { text:string; emotion:string; motion?:string; audioUrl?:string; durationMs:number; worldIntent?:unknown; error?:string; inputText?:string }
export interface WorldExecutor {
  conversation(input:WorldExecutionInput, audio?:ArrayBuffer):Promise<WorldExecutionResult>;
  visual(input:{roomId:string;epoch:number;slot:ConversationSlot;element:WorldElement}):Promise<{assetUrl?:string;error?:string}>;
}
export interface RoomEnv { WORLD_EXECUTOR?:WorldExecutor; SHARED_CONVERSATION_ENABLED?:string; SHARED_HAND_ENABLED?:string }
export function executionInput(state:SharedWorldState,slot:ConversationSlot,context:string):WorldExecutionInput {
  return {roomId:state.roomId,epoch:state.epoch,slot,context,history:state.conversation?.history.slice(-20)??[],
    brainCardIds:state.cardSlots?state.cardSlots.flatMap(s=>s.cardId?[s.cardId]:[]):Object.keys(state.weights).slice(-5)};
}
