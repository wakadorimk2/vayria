import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
const dir='.wrangler/placement-fixture';await mkdir(dir,{recursive:true});
await build({entryPoints:['scripts/visual-placement-fixture.tsx'],outdir:dir,bundle:true,format:'esm',jsx:'automatic'});
await writeFile(dir+'/index.html','<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/visual-placement-fixture.css"><div id="root"></div><script type="module" src="/visual-placement-fixture.js"></script></html>');
createServer(async(req,res)=>{const files={'/':dir+'/index.html','/visual-placement-fixture.js':dir+'/visual-placement-fixture.js','/visual-placement-fixture.css':dir+'/visual-placement-fixture.css','/manifestation/chicken-1.png':'public/manifestation/chicken-1.png'};const file=files[req.url];if(!file){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html');res.end(await readFile(file));}).listen(5198,'127.0.0.1',()=>console.log('Fixture: http://127.0.0.1:5198'));
