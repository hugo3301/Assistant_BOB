import {requireThat} from './errors.mjs';
export async function remoteJson(response,{limit=1048576,code='REMOTE_RESPONSE'}={}){
 if(Number(response.headers.get('Content-Length')??0)>limit){await response.body?.cancel();requireThat(false,code,'Внешний сервис вернул слишком большой ответ.');}
 const reader=response.body?.getReader();requireThat(reader,code,'Внешний сервис вернул пустой ответ.');let size=0;const chunks=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();requireThat(false,code,'Внешний сервис вернул слишком большой ответ.');}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{reader.releaseLock();}
}
