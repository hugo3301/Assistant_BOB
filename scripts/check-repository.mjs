import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean),problems=[];
const patterns=[/cfut_[A-Za-z0-9_-]{40,}/g,/gsk_[A-Za-z0-9_-]{32,}/g,/gh[pousr]_[A-Za-z0-9]{36,}/g,/github_pat_[A-Za-z0-9_]{60,}/g,/\b\d{8,12}:[A-Za-z0-9_-]{35}\b/g,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g];
for(const file of files){
 if(/(^|\/)(node_modules|work|\.wrangler|embeddeddolt|\.netlify)\//.test(file)||/(?:\.sqlite(?:-wal|-shm)?|\.db|\.log|\.pem|\.cipher)$/.test(file)||/(^|\/)(?:\.env(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?)$/.test(file)&&!file.endsWith('.env.example')){problems.push(file+': runtime/secret file must not be tracked');continue;}
 const source=readFileSync(file,'utf8');if(patterns.some(pattern=>{pattern.lastIndex=0;return pattern.test(source);}))problems.push(file+': possible credential detected (value hidden)');
 if(file.startsWith('.github/workflows/')){if(/pull_request_target|secrets:\s*inherit|permissions:\s*write-all/.test(source))problems.push(file+': privileged workflow requires review');for(const match of source.matchAll(/\buses:\s*([^\s#]+)/g))if(!/@[a-f0-9]{40}$/.test(match[1]))problems.push(file+': action must be pinned to a full commit SHA');}
}
for(const file of ['README.md','LICENSE','SECURITY.md','CONTRIBUTING.md','.env.example','.github/workflows/ci.yml','.github/workflows/deploy.yml'])if(!files.includes(file))problems.push(file+': required file missing');
const sample=readFileSync('.env.example','utf8');for(const line of sample.split(/\r?\n/))if(/^(?:[A-Z_]*(?:TOKEN|SECRET|KEY|_ID))=.+/.test(line))problems.push('.env.example: credential placeholders must be empty');
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log(JSON.stringify({trackedFilesChecked:files.length,repositoryHygiene:'passed',credentialValuesPrinted:false}));
