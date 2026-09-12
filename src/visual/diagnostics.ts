export const VISUAL_STAGES = [
  'motion_requested','image_requested','request_accepted','cache_image','cache_video',
  'image_received','video_received','metadata','loaded_data','seek_started','seek_complete',
  'key_passed','play_requested','play_started','frames_advancing','first_display','first_video_display',
  'video_loading_timeout','video_load_failed','video_seek_timeout','video_play_rejected',
  'video_play_failed','video_frame_stalled','key_quality','video_reduced_motion','timeout',
  'placement_held','placement_resumed','placement_shown','placement_unavailable','aborted','failed',
] as const;
export type VisualStageCode = typeof VISUAL_STAGES[number];
export interface PlacementDiagnostic { targetId:string; reason:'ui_blocked'|'space_available'; displayedMs:number }
export interface VisualDiagnostic { placement?:PlacementDiagnostic; build:string; stage:VisualStageCode; milliseconds:number }
export function readVisualDiagnostic(value:unknown):VisualDiagnostic|null {
  if(!value||typeof value!=='object')return null;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['build','stage','milliseconds','placement'].includes(k)) ||
    typeof v.build!=='string'||!/^[-a-zA-Z0-9_.]{1,100}$/.test(v.build)||
    !VISUAL_STAGES.includes(v.stage as VisualStageCode)||typeof v.milliseconds!=='number'||
    !Number.isFinite(v.milliseconds)||v.milliseconds<0||v.milliseconds>120000)return null;
  let placement:PlacementDiagnostic|undefined;
  if(v.placement!==undefined){const p=v.placement as PlacementDiagnostic;if(!p||typeof p.targetId!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(p.targetId)||!['ui_blocked','space_available'].includes(p.reason)||!Number.isFinite(p.displayedMs)||p.displayedMs<0||p.displayedMs>45000||Object.keys(p).some(k=>!['targetId','reason','displayedMs'].includes(k)))return null;placement=p;}
  return {...(placement?{placement}:{}),build:v.build,stage:v.stage as VisualStageCode,milliseconds:Math.round(v.milliseconds)};
}
