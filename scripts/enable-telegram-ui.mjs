const base='https://assistant-bob-alpha.assistant-bob.workers.dev';
try{
 const response=await fetch(base+'/admin/telegram',{method:'POST',headers:{Authorization:`Bearer ${process.env.ADMIN_SECRET}`},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('Telegram setup not accepted');
 const result=await response.json();if(result.callbackUpdatesEnabled!==true)throw Error('Telegram setup not confirmed');console.log(JSON.stringify(result));
}catch{console.error('Не удалось подтвердить включение кнопок Telegram через сервер.');process.exitCode=1;}
