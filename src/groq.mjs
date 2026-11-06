import {BobError,requireThat} from './errors.mjs';
import {transcription} from './voice.mjs';
export class GroqSpeech {
 constructor({token,budget,fetcher=fetch,timeoutMs=15000}){requireThat(typeof token==='string'&&token.length>20&&budget,'PROVIDER_CONFIG','Groq пока не подключён.');Object.assign(this,{token,budget,fetcher,timeoutMs});}
 async transcribe(bytes,seconds){
  requireThat(Number.isFinite(seconds)&&seconds>0&&seconds<=120&&bytes.byteLength<=2000000,'VOICE_LENGTH','Пришли голосовое до 2 минут и 2 МБ.');
  const charged=Math.max(10,Math.ceil(seconds)),id=await this.budget.reserve(charged);let observed=null;
  try {
   const body=new FormData();body.set('file',new Blob([bytes],{type:'audio/ogg'}),'voice.ogg');body.set('model','whisper-large-v3-turbo');body.set('language','ru');body.set('response_format','verbose_json');body.set('temperature','0');
   const response=await (0,this.fetcher)('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${this.token}`},body,redirect:'manual',signal:AbortSignal.timeout(this.timeoutMs)});
   requireThat(response.ok,response.status===429?'PROVIDER_QUOTA':response.status===401||response.status===403?'PROVIDER_AUTH':'VOICE_API','Groq не смог распознать запись. Попробуй позже, выбери Cloudflare в /providers или напиши текстом.');
   const payload=await response.json();requireThat(typeof payload.text==='string','VOICE_API','Groq вернул неполный ответ. Попробуй ещё раз или напиши текстом.');observed=charged;return{...transcription(payload),provider:'groq',audioSeconds:charged};
  }catch(error){if(error instanceof BobError)throw error;throw new BobError(error.name==='TimeoutError'?'VOICE_TIMEOUT':'VOICE_NETWORK','Groq не ответил. Дела не изменены; можно написать текстом.');}
  finally{await this.budget.settle(id,observed);}
 }
}
