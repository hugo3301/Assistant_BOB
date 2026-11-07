import {GIGA_BODY_LIMIT} from './gigachat-relay.mjs';

// Netlify's buffered Lambda boundary preserves the bytes covered by the relay HMAC.
export function createNetlifyHandler(bridge){
 return async event=>{
  try{
   const encoded=event.body??'';
   if(typeof encoded!=='string'||encoded.length>GIGA_BODY_LIMIT*2)return failure(413,'BRIDGE_SIZE');
   const body=Buffer.from(encoded,event.isBase64Encoded?'base64':'utf8');
   if(body.byteLength>GIGA_BODY_LIMIT)return failure(413,'BRIDGE_SIZE');
   const method=event.httpMethod??'GET',url=event.rawUrl??'https://bridge.invalid'+(event.path??'/');
   const request=new Request(url,{method,headers:event.headers??{},...(!['GET','HEAD'].includes(method)?{body}:{} )});
   const response=await bridge(request);
   return {statusCode:response.status,headers:Object.fromEntries(response.headers),body:await response.text(),isBase64Encoded:false};
  }catch{return failure(503,'BRIDGE_UNAVAILABLE');}
 };
}
function failure(statusCode,code){return {statusCode,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify({code}),isBase64Encoded:false};}
