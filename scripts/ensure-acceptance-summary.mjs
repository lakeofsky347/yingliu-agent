/** An installation/build failure still produces an explicit, allowlisted NOT_CHECKED summary for CI. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {platformSummary} from './acceptance-summary.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),file=join(root,'artifacts/platform-acceptance',`${process.platform}-${process.arch}.json`);
let existingValid=false;try{const existing=JSON.parse(await readFile(file,'utf8'));existingValid=existing.schemaVersion===1&&['PASS','FAIL'].includes(existing.status)&&Array.isArray(existing.phases);}
catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
if(!existingValid){
  const info=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const report=platformSummary({applicationVersion:info.version,platform:process.platform,architecture:process.arch,node:process.versions.node,commit:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout?.trim()},[{phase:'preflight',status:'FAIL',failureCode:'SETUP_OR_BUILD_FAILED',checks:[]}]);
  await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(report,null,2)+'\n');
}
