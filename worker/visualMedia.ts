/** Inspect provider PNG pixels without Node-only image libraries. Reject unsupported formats. */
export async function inspectVisualPng(bytes: Uint8Array, prop: boolean, capture = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 40 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw new Error('invalid_png');
  const width = view.getUint32(16), height = view.getUint32(20), depth = bytes[24], color = bytes[25];
  if (!width || !height || width * height > 3000000 || depth !== 8 || ![2,6].includes(color) || bytes[28] !== 0) throw new Error('unsupported_png');
  if (!prop) return { width, height };
  if (color !== 6) throw new Error('missing_alpha');
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset); if (size > bytes.length - offset - 12) throw new Error('invalid_png');
    if (view.getUint32(offset + 4) === 0x49444154) chunks.push(bytes.slice(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const packed = new Uint8Array(chunks.reduce((n,c) => n + c.length, 0)); let offset = 0;
  for (const chunk of chunks) { packed.set(chunk, offset); offset += chunk.length; }
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const expected = (width * 4 + 1) * height, raw = new Uint8Array(expected); offset = 0;
  try { for (;;) { const r = await reader.read(); if (r.done) break; if (offset + r.value.length > expected) throw new Error('invalid_png_size'); raw.set(r.value, offset); offset += r.value.length; } }
  finally { await reader.cancel().catch(() => {}); }
  if (offset !== expected) throw new Error('invalid_png_size');
  const pixels = capture ? new Uint8Array(width * height * 4) : undefined;
  let clear = 0, solid = 0, edge = 0; const row = new Uint8Array(width * 4), prev = new Uint8Array(width * 4);
  const paeth = (a: number,b: number,c: number) => { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
  for (let y=0;y<height;y++) {
    const start=y*(width*4+1), filter=raw[start]; if(filter>4)throw new Error('invalid_png_filter');
    for(let x=0;x<row.length;x++) { const a=x>=4?row[x-4]:0,b=prev[x],c=x>=4?prev[x-4]:0;
      row[x]=(raw[start+1+x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255; }
    for(let x=0;x<width;x++){const alpha=row[x*4+3];if(alpha<16)clear++;if(alpha>200)solid++;if((x<2||y<2||x>=width-2||y>=height-2)&&alpha>50)edge++;}
    pixels?.set(row, y * width * 4);
    prev.set(row);
  }
  if(clear<width*height*.15||solid<width*height*.005||edge>8)throw new Error('alpha_quality');
  return { width, height, pixels };
}

function pngChunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
  view.setUint32(0, data.length); result.set(new TextEncoder().encode(type), 4); result.set(data, 8);
  let crc = 0xffffffff;
  for (const value of result.subarray(4, -4)) { crc ^= value; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0); return result;
}
/** Build a keyed video input in Workers, without filesystem or native image libraries. */
export async function videoSourcePng(bytes: Uint8Array) {
  const {width,height,pixels} = await inspectVisualPng(bytes,true,true);
  if (!pixels) throw new Error('missing_alpha');
  let green = 0, blue = 0;
  for (let i=0;i<pixels.length;i+=4) if(pixels[i+3]>100) {
    green += Math.max(0,pixels[i+1]-Math.max(pixels[i],pixels[i+2]));
    blue += Math.max(0,pixels[i+2]-Math.max(pixels[i],pixels[i+1]));
  }
  const keyColor = green > blue ? 'blue' as const : 'green' as const;
  const key = keyColor === 'green' ? [0,255,0] : [0,0,255];
  const raw = new Uint8Array((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=(y*width+x)*4,a=pixels[i+3]/255,o=y*(width*3+1)+1+x*3;
    for(let c=0;c<3;c++)raw[o+c]=Math.round(pixels[i+c]*a+key[c]*(1-a));
  }
  const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const header = new Uint8Array(13);const v=new DataView(header.buffer);v.setUint32(0,width);v.setUint32(4,height);header[8]=8;header[9]=2;
  const chunks=[new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',packed),pngChunk('IEND',new Uint8Array())];
  const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}
  return {bytes:result,keyColor,width,height};
}
