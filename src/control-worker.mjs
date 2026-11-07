import {DurableObject} from 'cloudflare:workers';
import {ControlStore} from './control.mjs';
import {cloudDatabase} from './cloud-store.mjs';
import {callUser} from './routing.mjs';
import {BobError,requireThat} from './errors.mjs';
import {ProviderLedger} from './provider-ledger.mjs';
import {providerAvailability} from './provider-settings.mjs';
import {OpsStore} from './ops.mjs';
import {randomUUID} from 'node:crypto';
export class ControlObject extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.env=env;this.control=new ControlStore(cloudDatabase(ctx.storage),{admin:String(env.TELEGRAM_OWNER_ID),mode:env.ALPHA_ACCESS_MODE==='open'?'open':'invite',inboundLimit:env.INBOUND_REQUESTS_PER_MINUTE});if(env.AI_BUDGET_SEED_DAY===new Date().toISOString().slice(0,10))this.control.seed(env.AI_BUDGET_SEED_DAY,Number(env.AI_BUDGET_SEED_NEURONS)||0);}
 async fetch(request){
  const path=new URL(request.url).pathname,data=request.method==='POST'?await request.json():{};
  try{
   this.providers??=new ProviderLedger(this.control,{gigachatCap:this.env.GIGACHAT_TOKEN_CAP});
   this.ops??=new OpsStore(this.control.db);
   if(path==='/telemetry'){requireThat(this.control.active(data.owner),'ACCESS','Нет доступа.');this.ops.record(data.owner,data.events,data.snapshot);return Response.json({ok:true});}
   if(path==='/ops'){requireThat(data.owner===String(this.env.TELEGRAM_OWNER_ID),'ADMIN_ONLY','Нет доступа.');return Response.json(this.ops.read(this.control,this.providers,this.env,data));}
   if(path==='/provider/reserve'){requireThat(providerAvailability(this.env,data.owner)[data.provider]===true,'PROVIDER_DISABLED','Провайдер не подключён.');return Response.json({id:this.providers.reserve(data.owner,data.provider,data.amount)});}
   if(path==='/provider/probe-reserve'){requireThat(data.owner===String(this.env.TELEGRAM_OWNER_ID)&&providerAvailability(this.env,data.owner).gigachat,'PROVIDER_DISABLED','Проверка недоступна.');return Response.json(this.providers.reserveProbe(data.owner,data.amount));}
   if(path==='/provider/probe-settle'){this.providers.settleProbe(data.owner,data.id,data.observed);return Response.json({ok:true});}
   if(path==='/provider/claim'){requireThat(Number.isFinite(data.amount)&&data.amount>0,'PROVIDER_REQUEST','Не указан объём запроса.');return Response.json(this.providers.claim(data.id,data.hash,owner=>providerAvailability(this.env,owner).gigachat,data.amount));}
   if(path==='/provider/settle'){this.providers.settle(data.owner,data.id,data.observed);return Response.json({ok:true});}
   if(path==='/provider/usage'){requireThat(this.control.active(data.owner),'ACCESS','Нет доступа.');return Response.json(this.providers.usage(data.owner,data.provider));}
   if(path==='/access')return Response.json(this.control.access(data.owner,data));
   if(path==='/notice')return Response.json({send:this.control.notice(data.owner)});
   if(path==='/admit'){const allowed=this.control.allowRequest(data.owner,data);try{this.ops.record(data.owner,[{id:randomUUID(),component:'inbound',outcome:allowed?'ok':'RATE_LIMIT'}]);}catch{}return Response.json({allowed});}
   if(path==='/usage'){const shared=this.control.usage();return Response.json({...this.control.usage(data.owner),sharedRemaining:Math.max(0,shared.limit-shared.spent-shared.reserved),sharedLimit:shared.limit});}
   if(path==='/reserve')return Response.json({id:this.control.reserve(data.owner,data.amount,data)});
   if(path==='/settle'){this.control.settle(data.owner,data.id,data.observed);return Response.json({ok:true});}
   if(path==='/seed'){this.control.seed(data.day,data.spent);return Response.json({ok:true});}
   if(path==='/invite')return Response.json(this.control.invite(data.owner,data.label,data.requestId));
   if(path==='/overview'){requireThat(data.owner===String(this.env.TELEGRAM_OWNER_ID),'ADMIN_ONLY','Нет доступа.');return Response.json(this.control.overview());}
   if(path==='/revoke'){this.control.revoke(data.owner,data.member);await callUser(this.env,data.member,'/pause',{method:'POST'});return Response.json({ok:true});}
   if(path==='/schedule'){this.control.schedule(data.owner,data.at);return Response.json({ok:true});}
   if(path==='/wake'){const at=Date.now(),owners=this.control.due(),results=await Promise.allSettled(owners.map(owner=>callUser(this.env,owner,'/wake',{method:'POST'})));results.forEach((result,index)=>{if(result.status==='rejected'||!result.value.ok)this.control.schedule(owners[index],new Date(Date.now()+300000).toISOString());});try{this.ops.record('system',[{id:randomUUID(),component:'cron',outcome:results.every(result=>result.status==='fulfilled'&&result.value.ok)?'ok':'WAKE_FAILED',durationMs:Date.now()-at}]);this.control.db.prepare("INSERT OR REPLACE INTO ops_meta VALUES ('last_cron',?)").run(new Date().toISOString());}catch{}return Response.json({woken:results.filter(result=>result.status==='fulfilled'&&result.value.ok).length});}
   return new Response('Not found',{status:404});
  }catch(error){if(!(error instanceof BobError))throw error;return Response.json({code:error.code,text:error.message},{status:400});}
 }
}
