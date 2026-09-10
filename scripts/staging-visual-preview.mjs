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
export async function deployVisualPreview(source,pr,sha,control){
 source=resolve(source);control=resolve(control);
 const config=JSON.parse(await readFile(join(control,'wrangler.public.jsonc'),'utf8'));checkVisualConfig(config);
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
 const output=run(process.execPath,[wrangler,'deploy',...common],control);await writeFile(join(control,'.wrangler/visual-deployed.txt'),`PR ${pr}\nSHA ${sha}\n${output}`);console.log(output);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [source,pr,sha]=process.argv.slice(2);await deployVisualPreview(source,Number(pr),sha,resolve(fileURLToPath(new URL('..',import.meta.url))));
}
