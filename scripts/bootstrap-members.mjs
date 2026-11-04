const base='https://assistant-bob-alpha.assistant-bob.workers.dev';
const headers={Authorization:`Bearer ${process.env.ADMIN_SECRET}`};
try{
 const response=await fetch(base+'/admin/bootstrap',{method:'POST',headers,signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error();const result=await response.json();if(!result.initialized)throw Error();
 const registryResponse=await fetch(base+'/admin/registry',{headers,signal:AbortSignal.timeout(20000)});if(!registryResponse.ok)throw Error();const registry=await registryResponse.json();
 console.log(JSON.stringify({initialized:true,members:registry.members.filter(member=>member.active).length,capacity:registry.capacity,access:registry.mode,sharedUsage:registry.usage}));
}catch{console.error('Не удалось подтвердить начальное состояние участников и общей квоты.');process.exitCode=1;}
