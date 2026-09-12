/** Media failures remain distinct from layout and provider failures. */
export function waitVideoEvent(video:HTMLVideoElement,event:string,signal:AbortSignal,timeout:number,code:string) {
  return new Promise<void>((resolve,reject)=>{
    const clean=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',error);signal.removeEventListener('abort',abort);};
    const done=()=>{clean();resolve();};const error=()=>{clean();reject(new Error('video_load_failed'));};const abort=()=>{clean();reject(new Error('aborted'));};
    const timer=setTimeout(()=>{clean();reject(new Error(code));},timeout);
    video.addEventListener(event,done,{once:true});video.addEventListener('error',error,{once:true});signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}
export async function playVideo(video:HTMLVideoElement,signal:AbortSignal,remainingMs=30000) {
  if(signal.aborted)throw new Error('aborted');
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort:()=>void=()=>{};
  try {
    await Promise.race([new Promise<never>((_,reject)=>{abort=()=>reject(new Error("aborted"));signal.addEventListener("abort",abort,{once:true});}),video.play(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('video_start_timeout')),Math.max(1,remainingMs));})]);
    if(signal.aborted){video.pause();throw new Error('aborted');}
  } catch(error) {
    video.pause();
    if(error instanceof Error && ['aborted','video_start_timeout'].includes(error.message))throw error;
    throw new Error(error instanceof Error&&error.name==='NotAllowedError'?'video_play_rejected':'video_play_failed');
  } finally {clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
export class VideoFrameProgress {
  private first:number|null=null;
  advancing(time:number) {
    if(!Number.isFinite(time))return false;
    if(this.first===null){this.first=time;return false;}
    if(Math.abs(time-this.first)<=.02)return false;
    this.first=time;return true;
  }
}
