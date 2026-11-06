import {randomUUID} from 'node:crypto';
// Fixed destinations, no credentials, no user content and no generated output.
export async function providerConnectivity(fetcher=fetch){
 const targets=[['groq','https://api.groq.com/openai/v1/models',{method:'GET'}],['gigachat','https://api.giga.chat/v1/models',{method:'GET'}],['gigachatOAuth','https://ngw.devices.sberbank.ru:9443/api/v2/oauth',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',RqUID:randomUUID()},body:'scope=GIGACHAT_API_PERS'}]];
 return Object.fromEntries(await Promise.all(targets.map(async([name,url,init])=>{try{const r=await fetcher(url,{...init,redirect:'manual',signal:AbortSignal.timeout(8000)});await r.body?.cancel();return[name,{http:r.status,transportReached:r.status<500,authenticated:false}];}catch{return[name,{http:null,transportReached:false,authenticated:false}];}})));
}
