// Real free speech API; only locally synthesized audio and an isolated database.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {SpeechAI,opusDuration,VoiceFlow} from '../src/voice.mjs';
const path=process.argv[2];if(!path)throw Error('Supply a locally synthesized OGG fixture');
const bytes=readFileSync(path),seconds=opusDuration(bytes),store=new Store(),clock=()=> '2026-11-04T02:00:00.000Z';
const budget={reserve:async amount=>store.reserveBudget(new Date().toISOString(),amount,100),settle:async(id,observed)=>store.settleBudget(id,observed)};
const speech=new SpeechAI({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,budget});
try{
 const alpha=new Alpha(store,new Assistant(store,{allowedOwners:['validation'],clock}),{clock}),flow=new VoiceFlow(store,'validation',{telegram:{voice:async()=>bytes},speech,clock});store.ensureUser('validation');
 const start=performance.now(),response=await flow.handle({file_id:'synthetic-local-file',duration:Math.round(seconds),file_size:bytes.length},'voice-live',text=>alpha.handle('validation',text,{requestId:'voice-live'}));
 const silence=process.argv.includes('--silence'),item=store.items('validation')[0],passed=silence?response.changed===0&&response.status==='clarify'&&!item:response.changed===1&&item?.at==='2026-11-05T12:00:00.000Z'&&item?.reminder_minutes===60;
 const result={fixture:silence?'synthetic silence OGG/Opus':'local Russian Windows speech, OGG/Opus',synthetic:true,productionWrites:false,telegramCalls:0,seconds,status:response.status,code:response.code??null,passed,sttAndActionMs:Math.round(performance.now()-start),text:response.text,accounting:store.usage(new Date().toISOString().slice(0,10))};mkdirSync('work',{recursive:true});writeFileSync(silence?'work/voice-silence-summary.json':'work/voice-live-summary.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!passed)process.exitCode=1;
}finally{store.close();}
