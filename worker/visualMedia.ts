/** Inspect provider PNG pixels without Node-only image libraries. Reject unsupported formats. */
export async function inspectVisualPng(bytes: Uint8Array, prop: boolean) {
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
  let clear = 0, solid = 0, edge = 0; const row = new Uint8Array(width * 4), prev = new Uint8Array(width * 4);
  const paeth = (a: number,b: number,c: number) => { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
  for (let y=0;y<height;y++) {
    const start=y*(width*4+1), filter=raw[start]; if(filter>4)throw new Error('invalid_png_filter');
    for(let x=0;x<row.length;x++) { const a=x>=4?row[x-4]:0,b=prev[x],c=x>=4?prev[x-4]:0;
      row[x]=(raw[start+1+x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255; }
    for(let x=0;x<width;x++){const alpha=row[x*4+3];if(alpha<16)clear++;if(alpha>200)solid++;if((x<2||y<2||x>=width-2||y>=height-2)&&alpha>50)edge++;}
    prev.set(row);
  }
  if(clear<width*height*.15||solid<width*height*.005||edge>8)throw new Error('alpha_quality');
  return { width, height };
}
