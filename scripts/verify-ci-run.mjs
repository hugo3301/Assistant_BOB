import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {verifyRelease,RELEASE_REPOSITORY} from './release-policy.mjs';
const repository=process.env.GITHUB_REPOSITORY,sha=process.env.DEPLOY_SHA;
if(repository!==RELEASE_REPOSITORY||!/^[a-f0-9]{40}$/.test(sha??''))throw Error('Invalid deployment context');
const headers={'User-Agent':'BOB-CD','X-GitHub-Api-Version':'2022-11-28',...(process.env.GH_TOKEN?{Authorization:'Bearer '+process.env.GH_TOKEN}:{})};
async function get(path){const r=await fetch('https://api.github.com/repos/'+RELEASE_REPOSITORY+path,{headers,signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('CI verification HTTP '+r.status);return r.json();}
const [main,result]=await Promise.all([get('/commits/main'),get('/actions/workflows/ci.yml/runs?head_sha='+sha+'&event=push&status=success&per_page=20')]);
const run=verifyRelease({repository,sha,main:main.sha,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runs:result.workflow_runs});
mkdirSync('work',{recursive:true});writeFileSync('work/ci-verification.json',JSON.stringify({repository,sha,run:run.id,verifiedAt:Date.now()}));
console.log(JSON.stringify({verifiedCommit:sha,ciRun:run.html_url}));
