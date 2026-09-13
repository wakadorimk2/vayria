import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pack,previewConfig,validatePackage} from './staging-preview-package.mjs';
import {validateTarget} from './public-cd.mjs';
export function checkVisualConfig(config){
 validateTarget(config);
 if(config.name!=='vayria-public-staging'||config.vars.PUBLIC_BASE_PATH!=='/staging'||config.vars.REQUIRE_PREVIEW_ACCESS!=='true')throw new Error('Staging only');
 if(config.r2_buckets?.length!==1||config.r2_buckets[0].binding!=='VISUAL_ASSETS'||config.r2_buckets[0].bucket_name!=='vayria-staging-visual-assets')throw new Error('Unexpected storage binding');
}
function run(command,args,cwd){const r=spawnSync(command,args,{cwd,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(`${command} failed: ${r.stderr}`);return r.stdout;}
export function enableSharedWorld(config){
 checkVisualConfig(config);const result=structuredClone(config);
 result.durable_objects.bindings=result.durable_objects.bindings.filter(b=>b.name!=='WORLD_ROOMS');
 result.durable_objects.bindings.push({name:'WORLD_ROOMS',class_name:'WorldRoom',script_name:'vayria-shared-world-staging'});
 result.vars.SHARED_WORLD_ENABLED='true';return result;
}
export function checkWorldStorageConfig(config){
 if(config.name!=='vayria-shared-world-staging'||config.account_id!=='7414797104d7aca62f03fbd4faf7e5df'||config.main!=='worker/worldWorker.ts'||config.workers_dev!==false||config.preview_urls!==false||!Array.isArray(config.routes)||config.routes.length||config.assets||JSON.stringify(config.migrations)!==JSON.stringify([{tag:'world-v1',new_sqlite_classes:['WorldRoom']}]))throw new Error('World storage must remain private and staging-only');
 if(config.vars&&(Object.keys(config.vars).some(k=>!['SHARED_CONVERSATION_ENABLED','SHARED_HAND_ENABLED'].includes(k))||Object.values(config.vars).some(v=>!['true','false'].includes(v))))throw new Error('Unexpected storage settings');
 if(config.services&&JSON.stringify(config.services)!==JSON.stringify([{binding:'WORLD_EXECUTOR',service:'vayria-public-staging',entrypoint:'WorldExecution'}]))throw new Error('Unexpected execution binding');
}
export function enableSharedConversation(config){const next=enableSharedWorld(config);next.vars.SHARED_CONVERSATION_ENABLED='true';return next;}
export async function deployVisualPreview(source,pr,sha,control,sharedWorld=false,sharedConversation=false){
 source=resolve(source);control=resolve(control);
 let config=JSON.parse(await readFile(join(control,'wrangler.public.jsonc'),'utf8'));checkVisualConfig(config);
 if(sharedConversation)config=enableSharedConversation(config);else if(sharedWorld)config=enableSharedWorld(config);
 if(!Number.isInteger(pr)||!/^\d+$/.test(String(pr))||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Explicit PR and full SHA required');
 if(run('git',['rev-parse','HEAD'],source).trim()!==sha||run('git',['status','--porcelain'],source).trim())throw new Error('Source must be clean at exact PR SHA');
 const verify=()=>{
  const detail=JSON.parse(run('gh',['pr','view',String(pr),'--json','headRefOid,state,statusCheckRollup'],source));
  if(detail.state!=='OPEN'||detail.headRefOid!==sha)throw new Error('PR changed or closed');
  for(const name of ['CI','Public checks'])if(!detail.statusCheckRollup.some(c=>c.name===name&&c.conclusion==='SUCCESS'))throw new Error('Required CI has not succeeded');
 };
 verify();
 const destination=join(control,'.wrangler/visual-package-'+sha);await mkdir(destination,{recursive:true});
 await pack(source,destination,source);
 const pinned=JSON.parse(await readFile(join(control,'deploy/public-vrm.json'),'utf8'));
 await validatePackage(destination,pinned);
 const deployConfig=previewConfig(config,destination);checkVisualConfig(deployConfig);
 const path=join(control,'.wrangler/visual-deploy.json');await writeFile(path,JSON.stringify(deployConfig));
 const wrangler=join(source,'node_modules/wrangler/wrangler-dist/cli.js');
 const common=['--config',path,'--env-file',join(control,'deploy/placeholder.env')];
 await writeFile(join(control,'.wrangler/visual-before.txt'),run(process.execPath,[wrangler,'deployments','list',...common],control));
 verify();
 if(sharedWorld||sharedConversation){
  let worldConfig=join(source,'wrangler.world.jsonc');const storage=JSON.parse(await readFile(worldConfig,'utf8'));checkWorldStorageConfig(storage);
  if(sharedConversation){
   // Publish the private entrypoint before another Worker binds to it. Keep the
   // public feature off until storage and its execution binding are ready.
   const preparation=structuredClone(deployConfig);preparation.vars.SHARED_CONVERSATION_ENABLED='false';
   const prepPath=join(control,'.wrangler/conversation-prepare.json');await writeFile(prepPath,JSON.stringify(preparation));
   run(process.execPath,[wrangler,'deploy','--config',prepPath,'--env-file',join(control,'deploy/placeholder.env')],control);
   storage.vars.SHARED_CONVERSATION_ENABLED='true';storage.vars.SHARED_HAND_ENABLED='true';storage.main=resolve(source,storage.main);
   worldConfig=join(control,'.wrangler/conversation-storage.json');await writeFile(worldConfig,JSON.stringify(storage));
  }
  const worldOutput=run(process.execPath,[wrangler,'deploy','--config',worldConfig,'--env-file',join(control,'deploy/placeholder.env')],source);
  await writeFile(join(control,'.wrangler/world-storage-deployed.txt'),`PR ${pr}\nSHA ${sha}\n${worldOutput}`);
  verify();
 }
 const output=run(process.execPath,[wrangler,'deploy',...common],control);await writeFile(join(control,'.wrangler/visual-deployed.txt'),`PR ${pr}\nSHA ${sha}\n${output}`);console.log(output);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [source,pr,sha,mode]=process.argv.slice(2);if(mode&&!['--shared-world','--shared-conversation'].includes(mode))throw new Error('Unknown preview mode');await deployVisualPreview(source,Number(pr),sha,resolve(fileURLToPath(new URL('..',import.meta.url))),mode==='--shared-world',mode==='--shared-conversation');
}
