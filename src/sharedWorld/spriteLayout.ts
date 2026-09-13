export function spriteSize(width: number, height: number, scale = 1) {
  return Math.min(168, Math.max(72, Math.min(width, height) * .18)) * scale;
}
export function restingPosition(index: number, width: number, height: number, size: number) {
  const pitch = size * .88;
  const columns = Math.max(1, Math.floor(width / pitch));
  const row = Math.floor(index / columns);
  return { x: (index % columns + .5) * width / columns, y: height - size / 2 - row * pitch };
}
export function spawnPosition(x: number, y: number, size: number, width: number, height: number, protectedRects: {x:number;y:number;width:number;height:number}[]) {
  const radius=size/2;
  x=Math.max(radius,Math.min(width-radius,x));
  for(const r of protectedRects){
    const left=r.x*width,right=(r.x+r.width)*width,bottom=(r.y+r.height)*height;
    if(y-radius>=bottom||x+radius<left||x-radius>right)continue;
    const candidates=[left-radius-4,right+radius+4].filter(v=>v>=radius&&v<=width-radius);
    if(candidates.length)x=candidates.sort((a,b)=>Math.abs(a-x)-Math.abs(b-x))[0];
    else y=Math.min(height-radius,bottom+radius+4);
  }
  return {x,y};
}
