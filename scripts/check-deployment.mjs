const sha=process.env.DEPLOY_SHA;if(!/^[a-f0-9]{40}$/.test(sha??''))throw Error('Expected deployment commit missing');
const origin='https://assistant-bob-alpha.assistant-bob.workers.dev';let valid=false;
for(let attempt=0;attempt<5;attempt++){
 const r=await fetch(origin+'/health',{redirect:'manual',signal:AbortSignal.timeout(15000)}),j=await r.json();
 valid=r.ok&&j.status==='ok'&&j.commit===sha&&j.features?.registration==='open'&&j.features?.userLimit===null&&j.features?.planner===true;
 if(valid)break;if(attempt<4)await new Promise(done=>setTimeout(done,2000));
}
if(!valid)throw Error('Production health does not match checked commit/features');
const privateResponse=await fetch(origin+'/planner/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}',redirect:'manual',signal:AbortSignal.timeout(15000)});if(privateResponse.status!==401)throw Error('Planner authentication guard failed');
console.log(JSON.stringify({productionHealth:'passed',commit:sha,privatePlannerGuard:401,modelCalls:0,telegramCalls:0}));
