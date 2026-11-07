import {BobError,requireThat} from '../errors.mjs';
import {plannerOwner} from '../planner/auth.mjs';
import {APP_ORIGIN} from '../calendars/pages.mjs';
import {limitedText} from '../calendars/network.mjs';
import {callControl} from '../routing.mjs';
import {adminPage} from './page.mjs';

export async function adminPublic(request,env){
 const path=new URL(request.url).pathname,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if(path==='/dashboard'&&request.method==='GET')return adminPage();
 if(!['/dashboard/data','/dashboard/export'].includes(path))return new Response('Not found',{status:404,headers});
 if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers:{...headers,Allow:'POST'}});
 try{
  requireThat(request.headers.get('Origin')===APP_ORIGIN&&/^application\/json(?:;|$)/iu.test(request.headers.get('Content-Type')??''),'ADMIN_AUTH','Открой панель кнопкой в BOB.');
  const raw=await limitedText(new Response(request.body,{headers:request.headers}),18000);let data;try{data=JSON.parse(raw);}catch{}
  requireThat(data&&typeof data==='object'&&!Array.isArray(data),'ADMIN_AUTH','Некорректный запрос.');
  const owner=plannerOwner(data.initData,env.TELEGRAM_BOT_TOKEN);
  requireThat(owner===String(env.TELEGRAM_OWNER_ID),'ADMIN_ONLY','Панель доступна только владельцу BOB.');
  const access=await callControl(env,'/access',{owner,start:false});requireThat(access.allowed,'ADMIN_ONLY','Доступ отключён.');
  const result=await callControl(env,'/ops',{owner,period:data.period??'day',exporting:path.endsWith('/export')});
  return Response.json(result,{headers:{...headers,...(path.endsWith('/export')?{'Content-Disposition':'attachment; filename="bob-ops.json"'}:{})}});
 }catch(error){return Response.json({code:error instanceof BobError?error.code:'OPS_UNAVAILABLE',text:error?.code==='PLANNER_AUTH'?'Открой панель заново кнопкой в BOB.':error instanceof BobError?error.message:'Панель временно недоступна. Попробуй обновить.'},{status:['ADMIN_AUTH','PLANNER_AUTH'].includes(error?.code)?401:error?.code==='ADMIN_ONLY'?403:error?.code==='OPS_RATE'?429:400,headers});}
}
