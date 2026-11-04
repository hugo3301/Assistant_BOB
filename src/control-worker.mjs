import {DurableObject} from 'cloudflare:workers';
import {ControlStore} from './control.mjs';
import {cloudDatabase} from './cloud-store.mjs';
import {callUser} from './routing.mjs';
import {BobError,requireThat} from './errors.mjs';
export class ControlObject extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.env=env;this.control=new ControlStore(cloudDatabase(ctx.storage),{admin:String(env.TELEGRAM_OWNER_ID),mode:env.ALPHA_ACCESS_MODE==='open'?'open':'invite'});if(env.AI_BUDGET_SEED_DAY===new Date().toISOString().slice(0,10))this.control.seed(env.AI_BUDGET_SEED_DAY,Number(env.AI_BUDGET_SEED_NEURONS)||0);}
 async fetch(request){
  const path=new URL(request.url).pathname,data=request.method==='POST'?await request.json():{};
  try{
   if(path==='/access')return Response.json(this.control.access(data.owner,data));
   if(path==='/notice')return Response.json({send:this.control.notice(data.owner)});
   if(path==='/usage')return Response.json(this.control.usage(data.owner));
   if(path==='/reserve')return Response.json({id:this.control.reserve(data.owner,data.amount,data)});
   if(path==='/settle'){this.control.settle(data.owner,data.id,data.observed);return Response.json({ok:true});}
   if(path==='/seed'){this.control.seed(data.day,data.spent);return Response.json({ok:true});}
   if(path==='/invite')return Response.json(this.control.invite(data.owner,data.label,data.requestId));
   if(path==='/overview'){requireThat(data.owner===String(this.env.TELEGRAM_OWNER_ID),'ADMIN_ONLY','Нет доступа.');return Response.json(this.control.overview());}
   if(path==='/revoke'){this.control.revoke(data.owner,data.member);await callUser(this.env,data.member,'/pause',{method:'POST'});return Response.json({ok:true});}
   if(path==='/schedule'){this.control.schedule(data.owner,data.at);return Response.json({ok:true});}
   if(path==='/wake'){const results=await Promise.allSettled(this.control.due().map(owner=>callUser(this.env,owner,'/wake',{method:'POST'})));return Response.json({woken:results.filter(result=>result.status==='fulfilled'&&result.value.ok).length});}
   return new Response('Not found',{status:404});
  }catch(error){if(!(error instanceof BobError))throw error;return Response.json({code:error.code,text:error.message},{status:400});}
 }
}
