// Independent local scanner. Source code and findings are never uploaded.
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync,lstatSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
const VERSION='8.30.1';
const releases={linux:{file:`gitleaks_${VERSION}_linux_x64.tar.gz`,hash:'551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'},win32:{file:`gitleaks_${VERSION}_windows_x64.zip`,hash:'d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'}};
const root=process.cwd(),work=resolve('work');mkdirSync(work,{recursive:true});
const release=releases[process.platform];if(!release||process.arch!=='x64')throw Error('Secret scanner supports Linux/Windows x64');
const tools=join(work,'security-tools',`gitleaks-${VERSION}`);mkdirSync(tools,{recursive:true});
const binary=join(tools,process.platform==='win32'?'gitleaks.exe':'gitleaks'),archive=join(tools,release.file);
if(!existsSync(archive)){
 const response=await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${release.file}`,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Official scanner download failed');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>32*1024*1024)throw Error('Scanner archive exceeded size bound');chunks.push(chunk);}const bytes=Buffer.concat(chunks);
 if(createHash('sha256').update(bytes).digest('hex')!==release.hash)throw Error('Scanner SHA256 verification failed');writeFileSync(archive,bytes);
}
if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==release.hash)throw Error('Cached scanner archive SHA256 mismatch');
if(process.platform==='linux')execFileSync('tar',['-xzf',archive,'-C',tools,'gitleaks']);
else {const q=value=>value.replaceAll("'","''");execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${q(archive)}' -DestinationPath '${q(tools)}' -Force`],{windowsHide:true,stdio:'pipe'});}
const config=resolve('.gitleaks.toml');
function scan(kind,path,label){const report=join(work,'gitleaks-'+label+'-redacted.json'),result=spawnSync(binary,[kind,path,'--config',config,'--redact=100','--no-banner','--log-level','error','--report-format','json','--report-path',report],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});if(result.error||![0,1].includes(result.status))throw Error('Secret scanner execution failed (details withheld)');const findings=JSON.parse(readFileSync(report,'utf8')),base=path.replaceAll('\\','/')+'/';console.log(JSON.stringify({scanner:`gitleaks ${VERSION}`,scope:label,findings:findings.map(f=>({rule:f.RuleID,file:f.File.replaceAll('\\','/').startsWith(base)?f.File.replaceAll('\\','/').slice(base.length):f.File,line:f.StartLine,commit:f.Commit||null})),valuesPrinted:false}));return findings.length;}
let findings=scan('git',root,'history');
const tree=mkdtempSync(join(work,'gitleaks-tracked-'));
try{
 const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
 for(const path of paths){const source=resolve(root,path),target=resolve(tree,path);if(!source.startsWith(root+sep)||!target.startsWith(tree+sep)||lstatSync(source).isSymbolicLink())throw Error('Unsafe tracked path');mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);}
 findings+=scan('dir',tree,'tracked-tree');
}finally{if(!tree.startsWith(work+sep)||!tree.split(sep).at(-1).startsWith('gitleaks-tracked-'))throw Error('Unsafe temporary cleanup path');rmSync(tree,{recursive:true,force:true});}
if(findings)process.exitCode=1;
