export type Point = { x:number; y:number };
export type SpriteContour = { parts:Point[][] };
const cache = new Map<string, Promise<SpriteContour | null>>();

/** Horizontal convex bands retain concavities without unbounded decomposition. */
export function alphaContour(data:Uint8ClampedArray,width:number,height:number):SpriteContour|null {
  const mask=new Uint8Array(width*height);const components:number[][]=[];
  for(let i=0;i<mask.length;i++)mask[i]=data[i*4+3]>=32?1:0;
  for(let i=0;i<mask.length;i++)if(mask[i]===1){const points=[i];mask[i]=2;
    for(let q=0;q<points.length;q++){const p=points[q],x=p%width,y=Math.floor(p/width);
      for(const n of [x>0?p-1:-1,x<width-1?p+1:-1,y>0?p-width:-1,y<height-1?p+width:-1])if(n>=0&&mask[n]===1){mask[n]=2;points.push(n);}}
    components.push(points);
  }
  const largest=Math.max(0,...components.map(c=>c.length));if(!largest)return null;
  mask.fill(0);for(const c of components)if(c.length>=Math.max(3,largest*.002))for(const p of c)mask[p]=1;
  const rows:{y:number;left:number;right:number}[]=[];
  for(let y=0;y<height;y++){let left=width,right=-1;for(let x=0;x<width;x++)if(mask[y*width+x]){left=Math.min(left,x);right=x+1;}if(right>=0)rows.push({y,left,right});}
  if(!rows.length)return null;
  const top=rows[0].y,bottom=rows.at(-1)!.y+1,band=Math.max(1,Math.ceil((bottom-top)/16));
  const scale=Math.max(width,height),ox=(scale-width)/2,oy=(scale-height)/2;
  const parts:Point[][]=[];
  for(let y=top;y<bottom;y+=band){const points:Point[]=[];
    for(const row of rows)if(row.y>=y&&row.y<y+band)for(const x of [row.left,row.right])for(const py of [row.y,row.y+1])points.push({x:(x+ox)/scale-.5,y:(py+oy)/scale-.5});
    if(points.length)parts.push(hull(points));
  }
  return {parts};
}
function hull(points:Point[]):Point[]{
  points.sort((a,b)=>a.x-b.x||a.y-b.y);const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half=(list:Point[])=>{const result:Point[]=[];for(const p of list){while(result.length>1&&cross(result.at(-2)!,result.at(-1)!,p)<=0)result.pop();result.push(p);}return result;};
  return [...half(points).slice(0,-1),...half([...points].reverse()).slice(0,-1)];
}
export function imageContour(image:HTMLImageElement):Promise<SpriteContour|null>{
  const key=image.currentSrc||image.src;const existing=cache.get(key);if(existing)return existing;
  const result=Promise.resolve().then(()=>{try{
    const scale=Math.min(1,256/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)return null;
    ctx.drawImage(image,0,0,canvas.width,canvas.height);return alphaContour(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
  }catch{return null;}});
  cache.set(key,result);if(cache.size>128)cache.delete(cache.keys().next().value!);return result;
}
