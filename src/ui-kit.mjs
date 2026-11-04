export const UI=Object.freeze({today:'Сегодня',week:'Неделя',ahead:'Все дела',projects:'Проекты',settings:'Настройки',help:'Помощь',home:'В меню',back:'Назад',undo:'↩ Вернуть как было',cancel:'Отмена',pageSize:6});
export const nav=(label,destination='home')=>({text:label,callback_data:`n|${destination}`});
export const truncate=(value,length)=>{const points=Array.from(String(value));return points.length>length?points.slice(0,length-1).join('')+'…':points.join('');};
export function plural(count,forms=['дело','дела','дел']){const n=Math.abs(count)%100,k=n%10;return forms[n>=11&&n<=19?2:k===1?0:k>=2&&k<=4?1:2];}
export function minuteLabel(minutes){if(minutes===null)return'выключено';if(minutes===0)return'в момент начала';if(minutes%60===0){const hours=minutes/60;return`за ${hours} ${plural(hours,['час','часа','часов'])}`;}return`за ${minutes} ${plural(minutes,['минуту','минуты','минут'])}`;}
export function screen(title,{meta='',sections=[],hint=''}={}){
 const lines=[],entities=[];let offset=0;
 const line=(value,style=null)=>{const text=String(value);if(style&&text)entities.push({type:style,offset,length:text.length});lines.push(text);offset+=text.length+1;};
 line(title,'bold');if(meta)line(meta,'italic');
 for(const section of sections){line('');if(typeof section==='string')line(section);else{if(section.title)line(section.title,'bold');if(section.text)line(section.text);}}
 if(hint){line('');line(hint,'italic');}return{text:lines.join('\n'),entities};
}
export function plainEntities(text){const entities=[];let offset=0;for(const[index,line]of String(text).split('\n').entries()){if(line&&(index===0&&line.length<180||/^(?:Сегодня ·|Завтра ·|Без срока$|(?:пн|вт|ср|чт|пт|сб|вс),|\d+\.\s)/iu.test(line)))entities.push({type:'bold',offset,length:line.length});offset+=line.length+1;}return entities;}
export function splitRichMessage(text,entities=[],limit=3500){
 const result=[];let start=0;
 while(start<text.length){let end=Math.min(start+limit,text.length);if(end<text.length){const newline=text.lastIndexOf('\n',end);if(newline>start+limit/2)end=newline;if(/[\uDC00-\uDFFF]/u.test(text[end]??''))end--;}
  const styles=entities.flatMap(entity=>{const from=Math.max(start,entity.offset),to=Math.min(end,entity.offset+entity.length);return from<to?[{...entity,offset:from-start,length:to-from}]:[];});result.push({text:text.slice(start,end),entities:styles});start=end;if(text[start]==='\n')start++;
 }return result;
}
