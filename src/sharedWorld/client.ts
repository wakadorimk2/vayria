import { publicUrl } from '../public/paths';
import { runtimeConfig } from '../runtimeConfig';
export interface WorldAccess {roomId:string;clientId:string;lease:string;epoch:number;until:number}
let access:WorldAccess|null=null;
export const sharedWorldRoomId=()=>runtimeConfig.mode==='public'&&import.meta.env.VITE_SHARED_WORLD_ENABLED==='true'?new URLSearchParams(location.search).get('world'):null;
export const worldAccess=()=>access;
export function setWorldAccess(value:WorldAccess|null){access=value;}
export function addWorldHeaders(headers:Headers){if(access){headers.set('X-World-Client',access.clientId);headers.set('X-World-Lease',access.lease);headers.set('X-World-Epoch',String(access.epoch));}}
export async function worldFetch(roomId:string,op:string,body?:object,signal?:AbortSignal){
  const headers=new Headers({'Content-Type':'application/json'});addWorldHeaders(headers);
  const response=await fetch(publicUrl(`/api/world-room/${roomId}/${op}`),{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal});
  const result=await response.json();if(!response.ok)throw new Error(result.code??'world_unavailable');return result;
}
