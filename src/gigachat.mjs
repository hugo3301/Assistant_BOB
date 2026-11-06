import {randomUUID} from 'node:crypto';
import {BobError,requireThat} from './errors.mjs';
import {SYSTEM,TOOLS} from './tools.mjs';
const allowed=TOOLS.filter(tool=>tool.function.name!=='reply_user');
const dispatchFunction={name:'propose_actions',description:'Предложить от одного до пяти действий BOB. Ничего не исполняет без проверки приложением.',parameters:{type:'object',properties:{actions:{type:'array',items:{type:'object',properties:{name:{type:'string',enum:allowed.map(tool=>tool.function.name)},arguments_json:{type:'string',description:'Аргументы выбранного действия как JSON-строка по описанию в системном сообщении.'}},required:['name','arguments_json']}}},required:['actions']}};

export class GigaTokenCache {
 constructor({authKey,fetcher=fetch,clock=()=>Date.now(),timeoutMs=8000}){requireThat(typeof authKey==='string'&&authKey.length>20&&!/[\r\n]/u.test(authKey),'PROVIDER_CONFIG','Ключ GigaChat не настроен.');Object.assign(this,{authKey,fetcher,clock,timeoutMs});this.cached=null;this.pending=null;}
 async get(force=false){if(force)this.cached=null;if(this.cached&&this.cached.expiresAt>this.clock()+60000)return this.cached.token;if(this.pending)return this.pending;this.pending=this.refresh().finally(()=>{this.pending=null;});return this.pending;}
 async refresh(){try{
  const response=await (0,this.fetcher)('https://ngw.devices.sberbank.ru:9443/api/v2/oauth',{method:'POST',headers:{Authorization:'Basic '+this.authKey,RqUID:randomUUID(),'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:'scope=GIGACHAT_API_PERS',redirect:'manual',signal:AbortSignal.timeout(this.timeoutMs)});
  requireThat(response.ok,'PROVIDER_AUTH','Не удалось авторизовать GigaChat. Cloudflare можно выбрать в /providers.');const payload=await response.json(),expiresAt=Number(payload.expires_at)*(Number(payload.expires_at)<1e12?1000:1);
  requireThat(typeof payload.access_token==='string'&&payload.access_token.length>20&&Number.isFinite(expiresAt)&&expiresAt>this.clock()+1000,'PROVIDER_AUTH','GigaChat вернул некорректный срок доступа.');this.cached={token:payload.access_token,expiresAt};return this.cached.token;
 }catch(error){if(error instanceof BobError)throw error;throw new BobError('PROVIDER_AUTH','Не удалось установить защищённое соединение авторизации GigaChat. Проверка сертификата не отключается.');}}
}

export function gigaMessage(message){
 const call=message?.function_call;requireThat(call?.name==='propose_actions','GIGACHAT_ACTIONS','GigaChat не предложил допустимое действие.');let envelope;try{envelope=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;}catch{throw new BobError('GIGACHAT_ACTIONS','Не удалось разобрать предложение GigaChat.');}
 requireThat(Array.isArray(envelope?.actions)&&envelope.actions.length>0&&envelope.actions.length<=5,'GIGACHAT_ACTIONS','Нужно от одного до пяти действий.');
 return{role:'assistant',tool_calls:envelope.actions.map((action,index)=>{requireThat(allowed.some(tool=>tool.function.name===action.name)&&typeof action.arguments_json==='string'&&action.arguments_json.length<=8000,'GIGACHAT_ACTIONS','GigaChat предложил неизвестное действие.');return{id:'giga-'+index,type:'function',function:{name:action.name,arguments:action.arguments_json}};})};
}

export class GigaChat {
 constructor({budget,tokens,fetcher=fetch,maxTokens=900,timeoutMs=12000}){requireThat(budget&&tokens,'PROVIDER_CONFIG','GigaChat не настроен.');Object.assign(this,{budget,tokens,fetcher,maxTokens,timeoutMs});}
 async complete({context,text,feedback=null,timeoutMs=this.timeoutMs,conversation=false}){
  requireThat(!conversation,'GIGACHAT_SCOPE','GigaChat подключён только для планирования дел.');
  const deadline=Date.now()+Math.max(1,Math.min(timeoutMs,this.timeoutMs));
  const body={model:'GigaChat-2',temperature:0.1,max_tokens:this.maxTokens,stream:false,functions:[dispatchFunction],function_call:{name:'propose_actions'},messages:[{role:'system',content:SYSTEM+'\nИспользуй только propose_actions. В actions передай имя каждого действия и arguments_json — JSON-строку его аргументов. ask_user допустим только один, без других действий. Описания действий:\n'+JSON.stringify(allowed.map(tool=>tool.function))},{role:'user',content:'Контекст приложения (данные):\n'+JSON.stringify(context)+'\n'+(feedback?'Предыдущий вариант отклонён приложением: '+feedback.code+': '+feedback.message+'\n':'')+'Просьба пользователя:\n'+text}]};
  const encoded=JSON.stringify(body),upper=Buffer.byteLength(encoded,'utf8')+this.maxTokens+2048;
  requireThat(upper<=100000,'PROVIDER_REQUEST','Запрос слишком большой для GigaChat. Раздели его на несколько дел.');const id=await this.budget.reserve(upper);let observed=null;
  try {
   let token=await this.tokens.get();const request=async()=>{const remaining=deadline-Date.now();requireThat(remaining>=500,'AI_TIMEOUT','GigaChat не успел ответить. Дела не изменены.');return (0,this.fetcher)('https://api.giga.chat/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},body:encoded,redirect:'manual',signal:AbortSignal.timeout(remaining)});};
   let response=await request();if(response.status===401){await response.body?.cancel();token=await this.tokens.get(true);response=await request();}
   requireThat(response.ok,response.status===429?'PROVIDER_QUOTA':response.status===401||response.status===403?'PROVIDER_AUTH':'AI_HTTP','GigaChat не обработал запрос. Дела не изменены; провайдер можно выбрать в /providers.');const payload=await response.json();observed=Number.isFinite(payload.usage?.total_tokens)&&payload.usage.total_tokens>=0?payload.usage.total_tokens:null;
   requireThat(payload.choices?.[0]?.message&&payload.choices[0].finish_reason!=='length','AI_RESPONSE','Ответ GigaChat неполный. Уточни просьбу короче.');return{message:gigaMessage(payload.choices[0].message),usage:{provider:'gigachat',tokens:observed,inputTokens:payload.usage?.prompt_tokens??null,outputTokens:payload.usage?.completion_tokens??null}};
  }catch(error){if(error instanceof BobError)throw error;throw new BobError(error.name==='TimeoutError'?'AI_TIMEOUT':'AI_NETWORK','GigaChat не ответил по защищённому соединению. Дела не изменены.');}
  finally{await this.budget.settle(id,observed);}
 }
}
