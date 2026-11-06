import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {requireThat} from './errors.mjs';
export const GIGA_CLAIM_URL='https://assistant-bob-alpha.assistant-bob.workers.dev/providers/gigachat/claim';
export const GIGA_BODY_LIMIT=110000;
export const bodyHash=body=>createHash('sha256').update(body).digest('hex');
export function relaySignature(secret,{timestamp,deadline,reservationId,hash}){return createHmac('sha256',secret).update(['POST','/api/gigachat',timestamp,deadline,reservationId,hash].join('\n')).digest('hex');}
export function signatureMatches(a,b){return typeof a==='string'&&/^[a-f0-9]{64}$/u.test(a)&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export class GigaRelay {
 constructor({url,secret,fetcher=fetch,clock=()=>Date.now()}){const target=new URL(url);requireThat(target.protocol==='https:'&&/^[a-z0-9-]+\.(?:vercel|netlify)\.app$/u.test(target.hostname)&&target.pathname==='/api/gigachat'&&!target.search&&!target.hash&&!target.username&&!target.password&&!target.port&&typeof secret==='string'&&secret.length>=32,'PROVIDER_CONFIG','Мост GigaChat не настроен.');Object.assign(this,{url:target.href,secret,fetcher,clock});}
 async request(encoded,reservationId,timeoutMs){requireThat(/^[a-f0-9-]{36}$/u.test(reservationId),'PROVIDER_REQUEST','Некорректный резерв GigaChat.');const timestamp=String(this.clock()),deadline=String(Number(timestamp)+Math.max(1,Math.min(12000,Math.floor(timeoutMs)))),body=JSON.stringify({reservationId,request:JSON.parse(encoded)});requireThat(Buffer.byteLength(body)<=GIGA_BODY_LIMIT,'PROVIDER_REQUEST','Запрос GigaChat слишком большой.');const signature=relaySignature(this.secret,{timestamp,deadline,reservationId,hash:bodyHash(body)});return (0,this.fetcher)(this.url,{method:'POST',headers:{'Content-Type':'application/json','X-BOB-Time':timestamp,'X-BOB-Deadline':deadline,'X-BOB-Reservation':reservationId,'X-BOB-Signature':signature},body,redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Number(deadline)-this.clock()))});}
}
