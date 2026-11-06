// Explicit real API check: three locally synthesized fixtures, no Telegram or production writes.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from '../src/store.mjs';
import {Assistant} from '../src/assistant.mjs';
import {Alpha} from '../src/alpha.mjs';
import {ControlStore} from '../src/control.mjs';
import {ProviderLedger} from '../src/provider-ledger.mjs';
import {GroqSpeech} from '../src/groq.mjs';
import {VoiceFlow,opusDuration} from '../src/voice.mjs';
if(!process.argv.includes('--run')){console.log('Use --run <synthetic-fixture-directory>; sends up to three synthetic OGG files to Groq Free.');process.exit(0);}
const directory=process.argv.at(-1);if(!directory||directory==='--run')throw Error('Supply synthetic fixture directory');
if(process.env.GROQ_FREE_CONFIRMED!=='true')throw Error('Verify actual Free plan before running');
const controlDb=new Store(),control=new ControlStore(controlDb.db,{admin:'validation',mode:'open'}),ledger=new ProviderLedger(control),results=[];
try{for(const [file,silence] of [['russian-fixture.ogg',false],['russian-stereo-no-eos.ogg',false],['silence.ogg',true]]){
 const store=new Store(),clock=()=> '2026-11-06T02:00:00.000Z',bytes=readFileSync(resolve(directory,file)),seconds=opusDuration(bytes),budget={reserve:async n=>ledger.reserve('validation','groq',n),settle:async(...args)=>ledger.settle('validation',...args)};
 try{store.ensureUser('validation');const alpha=new Alpha(store,new Assistant(store,{allowedOwners:['validation'],clock}),{clock}),flow=new VoiceFlow(store,'validation',{telegram:{voice:async()=>bytes},speech:new GroqSpeech({token:process.env.GROQ_API_KEY,budget}),clock}),start=performance.now();const response=await flow.handle({file_id:'synthetic',duration:Math.round(seconds),file_size:bytes.length},'synthetic:'+file,text=>alpha.handle('validation',text,{requestId:'synthetic:'+file}));const item=store.items('validation')[0],passed=silence?response.changed===0&&response.status==='clarify'&&!item:response.changed===1&&item?.at==='2026-11-07T12:00:00.000Z'&&item?.reminder_minutes===60;results.push({fixture:file,seconds,passed,status:response.status,code:response.code??null,sttAndActionMs:Math.round(performance.now()-start),transcript:response.transcript??null,changed:response.changed,modelCalls:response.modelCalls??0});}
 catch(error){results.push({fixture:file,passed:false,code:error.code??'UNEXPECTED',message:error.code?error.message:'Unexpected test error'});break;}finally{store.close();}
}const report={synthetic:true,productionWrites:false,telegramCalls:0,provider:'groq',results,usage:ledger.usage('validation','groq'),passed:results.length===3&&results.every(row=>row.passed)};mkdirSync('work',{recursive:true});writeFileSync('work/groq-live-summary.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
}finally{controlDb.close();}
