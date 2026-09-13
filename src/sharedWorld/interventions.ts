import type { WorldInput } from './state';
export type Intervention = { id:string;name:string;cardId:string;count:number;at:number;until:number };
export class InterventionFeed {
  private room='';private epoch=-1;private sequence=0;
  rows:Intervention[]=[];
  update(state:{roomId:string;epoch:number;sequence:number;history:WorldInput[]},now:number,baseline=false){
    if(baseline||this.room!==state.roomId||this.epoch!==state.epoch){this.room=state.roomId;this.epoch=state.epoch;this.sequence=state.sequence;this.rows=[];return this.rows;}
    this.rows=this.rows.filter(r=>r.until>now);
    for(const input of [...state.history].sort((a,b)=>a.sequence-b.sequence))if(input.sequence>this.sequence){
      this.sequence=input.sequence;
      const row=this.rows.find(r=>r.name===input.name&&r.cardId===input.cardId&&now-r.at<1000);
      if(row){row.count++;row.until=now+4000;}
      else this.rows.push({id:`${state.roomId}:${state.epoch}:${input.eventId}`,name:input.name,cardId:input.cardId,count:1,at:now,until:now+4000});
      this.rows=this.rows.slice(-3);
    }
    this.sequence=Math.max(this.sequence,state.sequence);return [...this.rows];
  }
}
