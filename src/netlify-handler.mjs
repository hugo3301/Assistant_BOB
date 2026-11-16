import {GIGA_BODY_LIMIT} from './gigachat-relay.mjs';

// Modern Netlify Functions API: Request -> Response, no Lambda event conversion.
export function createNetlifyHandler(bridge){
 return async request=>{
  try{
   let forwarded=request;
   if(!['GET','HEAD'].includes(request.method)){
    const reader=request.body?.getReader(),chunks=[];let length=0;
    if(reader)while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>GIGA_BODY_LIMIT){await reader.cancel();return failure(413,'BRIDGE_SIZE');}chunks.push(value);}
    // Copy exact bytes; never parse/stringify the JSON covered by the relay HMAC.
    forwarded=new Request(request,{body:Buffer.concat(chunks),duplex:'half'});
   }
   return await bridge(forwarded);
  }catch{return failure(503,'BRIDGE_UNAVAILABLE');}
 };
}
function failure(status,code){return Response.json({code},{status,headers:{'cache-control':'no-store'}});}
