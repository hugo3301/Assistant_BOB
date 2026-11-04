import {normalize} from './dates.mjs';
export function modelContext(store,owner,text,now){
 const user=store.user(owner),items=store.items(owner),words=(normalize(text).match(/[а-яa-z]{3,}/gu)??[]).filter(word=>!['завтра','сегодня','покажи','перенеси','задачу','добавь','встреча','нужно','срок','дело'].includes(word));
 const ranked=items.map((item,index)=>({item,index,score:(item.id===user.focus_id?1000:0)+(normalize(text).includes(normalize(item.title))?500:0)+words.filter(word=>normalize(item.title).split(/[^а-яa-z]+/u).some(part=>part.startsWith(word.slice(0,Math.max(3,word.length-2))))).length*30+(item.kind==='task'?4:0)})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,16).map(({item})=>({id:item.id,kind:item.kind,title:item.title,day:item.day,at:item.at,duration:item.duration}));
 return{now,timezone:user.timezone,focus_id:user.focus_id,items:ranked,more_items:items.length>ranked.length,history:user.history.slice(-2).map(turn=>({user:turn.user.slice(0,400),assistant:turn.assistant.slice(0,400)}))};
}
