// Node-only transport. A custom CA applies to these fixed GigaChat requests,
// never to globalAgent, Windows, other providers or browser trust.
import {request as httpsRequest} from 'node:https';
import {X509Certificate} from 'node:crypto';
import {requireThat,BobError} from './errors.mjs';
const TARGETS=new Map([
 ['https://ngw.devices.sberbank.ru:9443/api/v2/oauth','POST'],
 ['https://api.giga.chat/v1/chat/completions','POST'],
 ['https://api.giga.chat/v2/chat/completions','POST'],
 ['https://api.giga.chat/v1/models','GET'],
]);
export function createGigaNodeFetch({ca,requester=httpsRequest,maxResponseBytes=1024*1024}={}){
 let certificate;try{certificate=new X509Certificate(ca);}catch{throw new BobError('GIGACHAT_CA','Укажи PEM-сертификат CA для GigaChat.');}
 requireThat(certificate.ca&&Number.isSafeInteger(maxResponseBytes)&&maxResponseBytes>=1024&&maxResponseBytes<=2*1024*1024,'GIGACHAT_CA','Некорректный CA или предел ответа.');
 return async(url,init={})=>{
  const method=String(init.method??'GET').toUpperCase();
  requireThat(TARGETS.get(String(url))===method&&init.redirect==='manual','GIGACHAT_DESTINATION','Этот транспорт разрешает только фиксированные методы GigaChat без перенаправлений.');
  const body=init.body??null;requireThat((body===null||typeof body==='string')&&(body===null||Buffer.byteLength(body)<=100000),'GIGACHAT_REQUEST','Слишком большой запрос GigaChat.');
  const headers=Object.fromEntries(new Headers(init.headers));if(body!==null)headers['content-length']=String(Buffer.byteLength(body));
  return new Promise((resolve,reject)=>{
   const req=requester(String(url),{method,headers,ca,rejectUnauthorized:true,signal:init.signal??AbortSignal.timeout(12000)},res=>{
    const chunks=[];let bytes=0;
    res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxResponseBytes){res.destroy(new BobError('GIGACHAT_RESPONSE','Ответ GigaChat слишком большой.'));return;}chunks.push(chunk);});
    res.once('aborted',()=>reject(new BobError('GIGACHAT_RESPONSE','GigaChat прервал ответ.')));res.once('error',reject);
    res.once('end',()=>{try{const responseHeaders=new Headers();for(const [key,value] of Object.entries(res.headers??{}))if(value!==undefined)responseHeaders.set(key,Array.isArray(value)?value.join(', '):String(value));resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:responseHeaders}));}catch(error){reject(error);}});
   });req.once('error',reject);req.end(body??undefined);
  });
 };
}
