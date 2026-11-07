import {normalize,dayAt} from './dates.mjs';
export function modelContext(store,owner,text,now){
 const user=store.user(owner),source=normalize(text),items=store.items(owner);
 const modifying=/перен[а-я]*|передвин[а-я]*|измени[а-я]*|исправ[а-я]*|срок|дедлайн|сдач|сдал|сделал|готово|выполн[а-я]*|заверш[а-я]*|законч[а-я]*|отмет[а-я]*|отмен[а-я]*|удал[а-я]*|убери|поработ[а-я]*|работ[а-я]*\s+над/u.test(source);
 const reference=/\b(?:task|event|work|ical)-[a-z0-9:.-]+|(?:^|\s)(?:ее|его|эту|этот|это|ней|нему)(?=$|[\s,.!?])|^(?:все\s+)?(?:готово|сделал|сдал)/u.test(source);
 const needsItems=modifying||reference;
 const words=(source.match(/[а-яa-z]{3,}/gu)??[]).filter(word=>!['завтра','сегодня','покажи','перенеси','задачу','добавь','встреча','нужно','срок','дело','сдачу','отметь','задачей'].includes(word));
 const ranked=needsItems?items.map((item,index)=>({item,index,score:(reference&&item.id===user.focus_id?1000:0)+(source.includes(item.id)||source.includes(normalize(item.title))?500:0)+words.filter(word=>normalize(item.title).split(/[^а-яa-z]+/u).some(part=>part.startsWith(word.slice(0,Math.max(3,word.length-2))))).length*30})).filter(entry=>entry.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,16).map(({item})=>({id:item.id,kind:item.kind,title:item.title,day:item.at?dayAt(item.at,user.timezone):item.day,at:item.at,duration:item.duration})):[];
 return{now,timezone:user.timezone,focus_id:ranked.some(item=>item.id===user.focus_id)?user.focus_id:null,items:ranked,more_items:needsItems&&items.length>ranked.length,history:[]};
}
