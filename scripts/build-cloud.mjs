import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const code=await new Promise((done,reject)=>{const child=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--outdir','work/build'],{env:{...process.env,XDG_CONFIG_HOME:resolve('work/config'),WRANGLER_LOG_PATH:resolve('work/wrangler-build.log'),WRANGLER_SEND_METRICS:'false'},stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',done);});
process.exitCode=Number(code)||0;
