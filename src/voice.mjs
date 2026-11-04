import {Buffer} from 'node:buffer';
import {BobError,requireThat} from './errors.mjs';
import {FREE_POLICY} from './control.mjs';

export function opusDuration(bytes){
 const buffer=Buffer.from(bytes);let offset=0,serial=null,preSkip=null,granule=0n,eos=false;
 while(offset<buffer.length){
  requireThat(offset+27<=buffer.length&&buffer.toString('ascii',offset,offset+4)==='OggS'&&buffer[offset+4]===0,'VOICE_FORMAT','Не получилось прочитать запись. Пришли обычное голосовое сообщение Telegram.');
  const segments=buffer[offset+26],header=27+segments;requireThat(offset+header<=buffer.length,'VOICE_FORMAT','Голосовое повреждено. Попробуй отправить заново.');
  const length=buffer.subarray(offset+27,offset+header).reduce((sum,value)=>sum+value,0),end=offset+header+length;requireThat(end<=buffer.length,'VOICE_FORMAT','Голосовое повреждено. Попробуй отправить заново.');
  const currentSerial=buffer.readUInt32LE(offset+14);if(serial===null)serial=currentSerial;requireThat(serial===currentSerial,'VOICE_FORMAT','В записи несколько звуковых дорожек. Пришли обычное голосовое.');
  if(preSkip===null){requireThat(length>=19&&buffer.toString('ascii',offset+header,offset+header+8)==='OpusHead','VOICE_FORMAT','Нужна голосовая запись OGG/Opus из Telegram.');preSkip=buffer.readUInt16LE(offset+header+10);}
  const position=buffer.readBigUInt64LE(offset+6);if(position!==0xffffffffffffffffn){requireThat(position>=granule,'VOICE_FORMAT','В записи повреждена временная шкала.');granule=position;}
  if(buffer[offset+5]&4)eos=true;offset=end;
 }
 requireThat(eos&&preSkip!==null&&granule>BigInt(preSkip),'VOICE_EMPTY','В записи нет звука. Попробуй записать ещё раз.');
 const seconds=Number(granule-BigInt(preSkip))/48000;requireThat(seconds<=FREE_POLICY.voiceSeconds+0.1,'VOICE_LENGTH','Голосовое длиннее 2 минут. Раздели его на несколько коротких сообщений.');return seconds;
}
export function transcription(payload){
 const result=payload.result??payload,text=String(result.text??'').trim().replace(/\s+/gu,' '),segments=result.segments??[],count=segments.filter(segment=>segment.no_speech_prob!==undefined||segment.avg_logprob!==undefined).length;
 const uncertain=count>0&&segments.filter(segment=>(segment.no_speech_prob??0)>=0.6||(segment.avg_logprob??0)<-1).length>=count/2;
 const silence=segments.length===0&&result.transcription_info?.word_count===0;
 const artifact=/^(?:спасибо за просмотр|продолжение следует|субтитры(?: сделал| подготовил)?)[.! ]*$/iu.test(text);
 return{text,uncertain:uncertain||silence||artifact||text.length<2||text.length>8000||!/[а-яa-z]/iu.test(text)};
}
export class SpeechAI{
 constructor({accountId,token,budget,fetcher=fetch,timeoutMs=20000}){requireThat(/^[a-f0-9]{32}$/iu.test(accountId??'')&&typeof token==='string'&&token.length>20,'AI_CONFIG','Распознавание пока не подключено.');this.accountId=accountId;this.token=token;this.budget=budget;this.fetcher=fetcher;this.timeoutMs=timeoutMs;}
 async transcribe(bytes,seconds){
  const amount=50*seconds/60+1,reservation=await this.budget.reserve(amount,'stt',seconds);let observed=null;
  try{
   const response=await (0,this.fetcher)(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/@cf/openai/whisper-large-v3-turbo`,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({audio:Buffer.from(bytes).toString('base64'),task:'transcribe',language:'ru',vad_filter:true,condition_on_previous_text:false}),signal:AbortSignal.timeout(this.timeoutMs)});
   requireThat(response.ok,response.status===429?'AI_QUOTA':'VOICE_API',response.status===429?'Распознавание сейчас недоступно по лимиту. Можно написать текстом.':'Не удалось распознать голос. Попробуй ещё раз или напиши текстом.');
   const payload=await response.json();observed=payload.usage?.neurons??payload.result?.usage?.neurons??null;
   requireThat(payload.success!==false&&typeof(payload.result??payload).text==='string','VOICE_API','Не удалось разобрать запись. Дела не изменены.');return{...transcription(payload),neurons:observed??amount};
  }catch(error){if(error instanceof BobError)throw error;throw new BobError(error.name==='TimeoutError'?'VOICE_TIMEOUT':'VOICE_NETWORK','Не дождался распознавания. Дела не изменены. Попробуй ещё раз или напиши текстом.');}
  finally{await this.budget.settle(reservation,observed);}
 }
}
export class VoiceFlow{
 constructor(store,owner,{telegram,speech,clock=()=>new Date().toISOString()}){this.store=store;this.owner=owner;this.telegram=telegram;this.speech=speech;this.clock=clock;store.db.exec('CREATE TABLE IF NOT EXISTS voice_receipts(owner TEXT NOT NULL,request_id TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner,request_id))');}
 async handle(voice,requestId,dispatch){
  requireThat(voice&&Number.isFinite(voice.duration)&&voice.duration>0&&voice.duration<=FREE_POLICY.voiceSeconds,'VOICE_LENGTH','Пришли голосовое до 2 минут. Длинную просьбу можно разделить на несколько сообщений.');
  requireThat((voice.file_size??0)<=FREE_POLICY.voiceBytes,'VOICE_SIZE','Запись слишком большая. Пришли голосовое до 2 минут и 2 МБ.');
  const row=this.store.db.prepare('SELECT result FROM voice_receipts WHERE owner=? AND request_id=?').get(this.owner,requestId);let result=row?JSON.parse(row.result):null;
  if(!result){const bytes=await this.telegram.voice(voice.file_id),seconds=opusDuration(bytes);requireThat(Math.abs(seconds-voice.duration)<=2,'VOICE_FORMAT','Не удалось проверить длительность записи. Запиши голосовое ещё раз.');result=await this.speech.transcribe(bytes,seconds);this.store.db.prepare('INSERT INTO voice_receipts VALUES (?,?,?,?)').run(this.owner,requestId,JSON.stringify(result),this.clock());this.store.db.prepare('DELETE FROM voice_receipts WHERE owner=? AND created_at<?').run(this.owner,new Date(Date.parse(this.clock())-7*86400000).toISOString());}
  if(result.uncertain)return{status:'clarify',changed:0,modelCalls:0,text:result.text?`Расслышал неуверенно\n\n«${result.text}»\n\nЗапиши ещё раз или напиши текстом. Пока ничего не менял.`:'Не расслышал голос\n\nПопробуй говорить ближе к микрофону или напиши текстом. Дела не изменены.'};
  const response=await dispatch(result.text);return{...response,text:`🎙 Услышал\n«${result.text}»\n\n${response.text}`,voice:true};
 }
}
