// Local, synthetic UI fixture. No conversation, image or TTS provider is enabled.
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
const bundle=await build({entryPoints:['worker/shared/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
const storageBundle=await build({entryPoints:['worker/worldWorker.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
const storageWorker={name:'world-storage',modules:true,script:storageBundle.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],bindings:{SHARED_CONVERSATION_ENABLED:'true'},durableObjects:{WORLD_STORAGE:{className:'WorldRoom',useSQLite:true}}};
const root=resolve('dist-public');const origin='http://localhost:8892';
const mf=new Miniflare(convertV4MiniflareOptions({port:8892,host:'127.0.0.1',workers:[{name:'shared-preview',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],durableObjects:{USAGE:{className:'PublicUsage',useSQLite:true},WORLD_ROOMS:{className:'WorldRoom',scriptName:'world-storage',useSQLite:true}},bindings:{COOKIE_SECRET:'local-shared-preview-fixture-key',ADMIN_SECRET:'local-shared-preview-fixture-key',SHARED_WORLD_ENABLED:'true',SHARED_CONVERSATION_ENABLED:'true',GENERATION_ENABLED:'false',REQUIRE_PREVIEW_ACCESS:'false',PUBLIC_BASE_PATH:'/staging'},r2Buckets:['VISUAL_ASSETS'],serviceBindings:{ASSETS:async request=>{
  const url=new URL(request.url);if(url.pathname==='/fixtures/crab.svg')return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><text x="128" y="175" text-anchor="middle" font-size="170">🦀</text></svg>',{headers:{'Content-Type':'image/svg+xml'}});
  const file=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+sep))return new Response('',{status:404});
  try{let bytes=await readFile(file);const type=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.vrm':'model/gltf-binary'})[extname(file)]??'application/octet-stream';if(type==='text/html')bytes=Buffer.from(bytes.toString().replace('<body>','<body><div style="position:fixed;top:0;left:0;z-index:99999;background:#532;color:white;padding:4px;font:12px system-ui">SIMULATED QA · 外部APIなし</div>'));return new Response(bytes,{headers:{'Content-Type':type}});}catch{return new Response('',{status:404});}
}}},storageWorker]}));
await mf.ready;
const namespace=await mf.getDurableObjectNamespace('WORLD_ROOMS');const room=namespace.get(namespace.idFromName('preview'));
const call=async body=>{const r=await room.fetch('https://world/',{method:'POST',headers:{'X-World-Actor':'fixture','X-World-Role':'admin'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result;};
await call({op:'create',roomId:'preview'});for(const [i,cardId]of ['crab','dance','zero-gravity'].entries())await call({op:'card',eventId:'fixture-'+i,cardId,epoch:0});
const lease=await call({op:'lease',clientId:'fixture'});await call({op:'intent',clientId:'fixture',lease:lease.token,epoch:0,decisionId:'fixture-turn',intent:{actions:[{type:'prop',targetId:'',concept:'crab',sourceCardIds:['crab','dance','zero-gravity'],effects:['dance','float'],count:3}]}});
await call({op:'element',clientId:'fixture',lease:lease.token,epoch:0,elementId:'fixture-turn-0',status:'ready',assetUrl:'/staging/fixtures/crab.svg'});
const {createHmac}=await import('node:crypto');const sign=purpose=>{const p=Buffer.from(JSON.stringify({purpose,roomId:'preview',exp:Date.now()+86400000})).toString('base64url');return p+'.'+createHmac('sha256','local-shared-preview-fixture-key').update(p).digest('base64url');};
await mkdir('node_modules/.tmp/shared-world',{recursive:true});await writeFile('node_modules/.tmp/shared-world/preview-links.json',JSON.stringify({host:`${origin}/staging/?world=preview#host=${sign('world-host')}`,guest:`${origin}/staging/world/preview#invite=${sign('world-invite')}`}));
console.log('Synthetic shared-world UI: http://localhost:8892/staging/ (links in node_modules/.tmp/shared-world/preview-links.json)');
process.on('SIGINT',async()=>{await mf.dispose();process.exit();});
