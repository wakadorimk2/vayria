import { WorkerEntrypoint } from 'cloudflare:workers';
import { handle, ledger, type Env } from './index';
import { LimitError } from './ledger';
import { sign } from './security';
import { visualTicket } from './visual';
import { cardPool } from '../src/cards/cardPool';
import type { WorldExecutionInput, WorldExecutionResult } from './worldExecution';
import type { ConversationSlot } from '../src/sharedWorld/conversation';
import type { WorldElement } from '../src/sharedWorld/state';
// Only the private storage Worker binds this entrypoint. No browser route accepts
// a visitor identity, model context, or generation command on its behalf.
export class WorldExecution extends WorkerEntrypoint<Env> {
  async visualPermission(input:{visitor:string;session:string}){
    if(this.env.GENERATION_ENABLED!=='true'||this.env.MANIFESTATION_ENABLED!=='true')return false;
    try{return (await ledger<{enabled:boolean}>(this.env,'visualPermission',{visitor:input.visitor,id:input.session})).enabled;}catch{return false;}
  }
  private async request(slot:ConversationSlot,path:string,payload:object|ArrayBuffer,context?:string){
    if(this.env.SHARED_CONVERSATION_ENABLED!=='true')throw new LimitError('conversation_disabled',0,409);
    const base=this.env.PUBLIC_BASE_PATH??'';const origin='https://'+this.env.PUBLIC_HOSTNAME;
    const credential=await sign({purpose:'visitor',id:slot.visitor,exp:Date.now()+300000},this.env.COOKIE_SECRET);
    const response=await handle(new Request(origin+base+path,{method:'POST',signal:AbortSignal.timeout(Math.max(1,Math.min(90000,slot.expires-Date.now()))),headers:{Origin:origin,Cookie:`${base?'__Host-vayria-staging':'__Host-vayria'}=${credential}`,'X-Vayria-Session':slot.session,'Content-Type':payload instanceof ArrayBuffer?'audio/wav':'application/json'},body:payload instanceof ArrayBuffer?payload:JSON.stringify(payload)}),{...this.env,REQUIRE_PREVIEW_ACCESS:'false'},this.ctx,context);
    if(!response.ok){const error=await response.json() as {code?:string};throw new Error(error.code??'execution_failed');}return response;
  }
  async conversation(input:WorldExecutionInput,audio?:ArrayBuffer):Promise<WorldExecutionResult>{
    let text=input.slot.text??'';
    if(audio){const result=await(await this.request(input.slot,'/api/transcribe',audio)).json() as {text:string};text=result.text.trim();if(!text)throw new Error('no-speech');}
    // The legacy speech contract still takes five IDs. Pad only with a current
    // card; exact occupied slots and multiplicities remain in the room context.
    const brainCardIds=(input.brainCardIds.length?input.brainCardIds:cardPool.slice(0,5).map(c=>c.id)).slice(0,5);
    while(brainCardIds.length<5)brainCardIds.push(brainCardIds[0]);
    const episodeId=`world-${input.slot.id}`;
    const payload={mode:input.slot.kind==='autonomous'?'autonomous':input.slot.kind==='voice'?'voice':'manual',...(input.slot.kind==='autonomous'?{
      topic:null,topicTurns:0,viewerIntent:null,viewerTurnsSince:0,viewerEngagement:'available',
      performerState:{phase:'idle',energy:.5,emotion:'neutral',emotionActivation:.3,attentionTarget:'viewer',attentionStrength:.5},
      autonomyCandidate:{episodeId,decisionEvidenceIds:[episodeId],reasons:[{id:episodeId,episodeId,parentReasonId:null,kind:'environment_change',content:'世界に投入されたカードと表示済みの変化を受け止める',semanticKey:'shared-world',salience:.8,status:'active',deferCause:null,wakeOn:['new_evidence'],decisionEvidenceIds:[episodeId]}]},
    }:{message:text}),history:input.history.slice(-10),brainCardIds,forcedCardId:null,recentExpressionLevels:[],streamSpeech:false};
    const result=await(await this.request(input.slot,'/api/chat',payload,input.context)).json() as {text?:string;emotion?:string;motion?:string;ttsTicket?:string;worldIntent?:unknown};
    const output:WorldExecutionResult={text:result.text??'',emotion:result.emotion??'neutral',motion:result.text?'speech-gentle':undefined,worldIntent:result.worldIntent,inputText:text,durationMs:Math.min(60000,Math.max(3000,(result.text?.length??0)*180))};
    if(result.ttsTicket&&this.env.VISUAL_ASSETS){try{
      const speech=await this.request(input.slot,'/api/tts',{ticket:result.ttsTicket});
      const bytes=await speech.arrayBuffer();
      // The existing Aivis adapter requests 192 kbps MP3. Include a one-second
      // playback margin; metadata can only lengthen this conservative slot.
      output.durationMs=Math.max(3000,Math.ceil(bytes.byteLength/24)+1000);
      const assetId=`speech-${input.epoch}-${input.slot.id}`;
      await this.env.VISUAL_ASSETS.put(`world/${input.roomId}/${assetId}`,bytes,{httpMetadata:{contentType:speech.headers.get('Content-Type')??'audio/mpeg'},customMetadata:{expires:String(Date.now()+600000)}});
      output.audioUrl=`${this.env.PUBLIC_BASE_PATH??''}/api/world-room/${input.roomId}/media/${assetId}`;
    }catch{output.error='speech_unavailable';}}
    return output;
  }
  async visual(input:{roomId:string;epoch:number;slot:ConversationSlot;element:WorldElement}):Promise<{assetUrl?:string;error?:string}>{
    try{
      const p=await ledger<{enabled:boolean;generation:number}>(this.env,'visualPermission',{visitor:input.slot.visitor,id:input.slot.session});
      if(!p.enabled)return {error:'visual_disabled'};
      const ticket=await visualTicket({visualIntent:{type:input.element.kind,action:'add',concept:input.element.concept,modifiers:[],targetId:input.element.id,motion:'',motionEvidence:'',sharing:'general',regenerate:false}},this.env,input.slot.visitor,input.slot.session,p.generation,false,input.element.id);
      if(!('visualTicket' in ticket))return {error:'visual_disabled'};
      const response=await this.request(input.slot,'/api/visual/generate',{ticket:ticket.visualTicket,portrait:false,remainingMs:input.element.kind==='background'?60000:30000});
      const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line) as {type:string;asset?:{id:string;url:string};code?:string});
      const asset=events.find(e=>e.type==='asset')?.asset;if(!asset)return {error:events.find(e=>e.type==='failed')?.code??'asset_unavailable'};
      if(asset.id.startsWith('stock-'))return {assetUrl:asset.url};
      const source=await this.env.VISUAL_ASSETS?.get(asset.id);if(!source||!this.env.VISUAL_ASSETS)return {error:'asset_unavailable'};
      await this.env.VISUAL_ASSETS.put(`world/${input.roomId}/${asset.id}`,source.body,{httpMetadata:{contentType:'image/png'}});
      return {assetUrl:`${this.env.PUBLIC_BASE_PATH??''}/api/world-room/${input.roomId}/media/${asset.id}`};
    }catch(error){return {error:error instanceof Error?error.message:'generation_failed'};}
  }
}
