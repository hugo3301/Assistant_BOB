import {BobError} from './errors.mjs';
export const control=env=>env.CONTROL.get(env.CONTROL.idFromName('bob-control:v1'));
export function callUser(env,owner,path,init={}){return env.BOB.get(env.BOB.idFromName(`owner:${owner}:v1`)).fetch('https://internal'+path,{...init,headers:{...init.headers,'x-bob-user':owner}});}
export async function callControl(env,path,data={}){const response=await control(env).fetch('https://internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new BobError(result.code??'CONTROL_UNAVAILABLE',result.text??'Сервис временно недоступен.');return result;}
export class SharedBudget{
 constructor(env,owner){this.env=env;this.owner=owner;}
 async reserve(amount,kind='llm',seconds=0){return(await callControl(this.env,'/reserve',{owner:this.owner,amount,kind,seconds})).id;}
 async settle(id,observed){await callControl(this.env,'/settle',{owner:this.owner,id,observed});}
 usage(){return callControl(this.env,'/usage',{owner:this.owner});}
}
