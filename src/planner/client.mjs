// Browser source is bundled as text; private values enter only through authenticated POST.
export const CLIENT = String.raw`
const $=id=>document.getElementById(id);
const tg=window.Telegram?.WebApp;
let data=null,loading=false,selected=null,shown=80,loadedAt=0;
const requestedDay=new URL(location.href).searchParams.get('date');
let view=['day','week','ahead'].includes(new URL(location.href).searchParams.get('view'))?new URL(location.href).searchParams.get('view'):'day';
const plus=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const el=(tag,attrs={},...children)=>{const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='class')n.className=v;else if(k.startsWith('on'))n[k]=v;else n.setAttribute(k,String(v));}for(const c of children.flat())if(c!==null&&c!==undefined)n.append(c instanceof Node?c:document.createTextNode(String(c)));return n;};
const button=(label,run,attrs={})=>el('button',{type:'button',onclick:run,...attrs},label);
const dayLabel=(day,short=false)=>day?new Intl.DateTimeFormat('ru',{timeZone:'UTC',weekday:short?'short':undefined,day:'numeric',month:short?'short':'long',year:short?(day.slice(0,4)!==data?.today?.slice(0,4)?'numeric':undefined):'numeric'}).format(new Date(day+'T12:00:00Z')):'Без срока';
const clock=at=>new Intl.DateTimeFormat('ru',{timeZone:data.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));
const fullTime=at=>new Intl.DateTimeFormat('ru',{timeZone:data.timezone,day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(new Date(at));
const endAt=item=>new Date(Date.parse(item.at)+(item.duration??0)*60000).toISOString();
const when=item=>item.at?(item.kind==='task'?'Срок · ':'')+clock(item.at)+(item.duration&&item.kind!=='task'?'–'+clock(endAt(item)):'')+(item.approximate?' · около':''):item.all_day?'Весь день':!item.day?'Без срока':item.kind==='task'?'Срок без времени':'Время не указано';
const overdue=item=>item.kind==='task'&&Boolean(item.at?Date.parse(item.at)<Date.parse(data.now):item.day&&item.day<data.today);
const now=()=>new Date(Date.parse(data.now)+(DEMO?0:performance.now()-loadedAt)).toISOString();
const category=item=>item.kind==='task'?'task':item.area==='Учёба'?'study':'';
function notice(text,error=false){$('message').replaceChildren(el('div',{class:'notice'+(error?' error':'')},text));}
function setView(next){view=next;shown=80;render();}
function listItem(item){const n=button('',()=>detail(item),{class:'list-item','aria-label':item.title+', '+(item.day?dayLabel(item.day)+', ':'')+when(item)});n.append(el('b',{},item.title),el('small',{},(item.day?dayLabel(item.day,true)+' · ':'')+when(item)+(item.project?' · '+item.project:'')));return n;}
function group(title,items){return el('section',{class:'group'},el('h2',{},title+' · '+items.length),el('div',{class:'list'},...items.map(listItem)));}
function openDialog(){if(!$('details').open)$('details').showModal();$('close-details').focus({preventScroll:true});try{tg?.BackButton?.show();}catch{}}
function closeDialog(){$('details').close();try{tg?.BackButton?.hide();}catch{}}
function detail(item){
  const box=$('detail-content');box.replaceChildren(el('div',{class:'brand'},item.kind==='task'?'ЗАДАЧА':'СОБЫТИЕ'),el('h2',{id:'detail-title'},item.title));
  const row=(label,value)=>box.append(el('div',{class:'detail-row'},el('small',{},label),value));
  if(item.at){row(item.kind==='task'?'Срок':'Начало',fullTime(item.at)+(item.approximate?' · примерно':''));if(item.kind!=='task')row('Длительность',item.duration?item.duration+' мин · до '+fullTime(endAt(item)):'Не указана · блок отмечает начало, а не длительность');}
  else{row(item.kind==='task'?'Срок':'Когда',item.day?dayLabel(item.day):'Без даты');if(item.all_day){let end=item.end_day;if(end&&item.source_day&&item.source_day!==item.day)end=plus(item.day,Math.max(1,Math.round((Date.parse(end)-Date.parse(item.source_day))/86400000)));row('Весь день',end&&end>plus(item.day,1)?'По '+dayLabel(plus(end,-1))+' включительно':'Да');}}
  if(overdue(item))row('Состояние','Срок прошёл · задача остаётся открытой');
  if(item.at&&item.duration&&item.kind!=='task'){const overlaps=data.items.filter(other=>other.id!==item.id&&other.at&&other.duration&&other.kind!=='task'&&Date.parse(other.at)<Date.parse(endAt(item))&&Date.parse(item.at)<Date.parse(endAt(other)));if(overlaps.length)row('Совпадение времени',overlaps.map(other=>other.title).join('; '));}
  if(item.project)row('Проект',item.project);row('Сфера',item.area);if(item.source)row('Источник',item.source);
  if(item.at)row('Напоминание',item.reminder_minutes===0?'В момент начала':'За '+item.reminder_minutes+' мин');
  const action=button(DEMO?'Пример карточки · действия отключены':'Изменить или завершить в BOB',async()=>{
    action.disabled=true;
    try{const result=await api('/planner/item',{id:item.id});tg.openTelegramLink(result.url);tg.close();}catch(error){action.disabled=false;action.textContent=error.message;}
  },{class:'primary'});if(DEMO)action.disabled=true;box.append(action);openDialog();
}
function pile(entries){$('detail-content').replaceChildren(el('h2',{id:'detail-title'},'В одно время · '+entries.length),el('p',{class:'muted'},'Открой дело, чтобы увидеть время и подробности.'),el('div',{class:'list'},...entries.map(entry=>listItem(entry.item))));openDialog();}
function renderCalendar(content){
  const week=view==='week',days=Array.from({length:week?7:1},(_,index)=>plus(selected,index));
  const columns=geometry(data.items,days,data.timezone);
  const tools=el('div',{class:'tools'},el('div',{class:'arrows'},button('‹',()=>shift(week?-7:-1),{class:'icon','aria-label':week?'На 7 дней назад':'Предыдущий день'}),button('Сегодня',()=>{selected=data.today;render();}),button('›',()=>shift(week?7:1),{class:'icon','aria-label':week?'На 7 дней вперёд':'Следующий день'})));
  const date=el('input',{type:'date',class:'date-field',value:selected,min:'1900-01-01',max:'2100-12-25','aria-label':'Выбрать дату',onchange:event=>{if(/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)&&event.target.value>='1900-01-01'&&event.target.value<='2100-12-25'){selected=event.target.value;render();}}});tools.append(date);content.append(tools,el('h2',{class:'date-label'},week?dayLabel(days[0],true)+' — '+dayLabel(days[6],true):dayLabel(selected)));
  const overdueItems=data.items.filter(overdue);
  if(overdueItems.length)content.append(button('Просроченные задачи: '+overdueItems.length+' · открыть обзор →',()=>setView('ahead'),{class:'notice warn short'}));
  content.append(el('p',{class:'toolbar-note'},week?'Листай календарь вбок. Нажми на блок, чтобы открыть дело.':'Нажми на блок, чтобы открыть дело. Пунктир — срок или начало без длительности.'));
  if(!columns.some(column=>column.timed.length||column.floating.length))content.append(el('div',{class:'empty'},el('h2',{},week?'На эти 7 дней планов нет':'На этот день планов нет'),el('p',{},'Можно выбрать другую дату. Новое дело добавь сообщением в BOB.')));
  const scroll=el('div',{class:'calendar-scroll'+(week?' week':''),'aria-label':week?'Календарь на 7 дней, с горизонтальной прокруткой':'Календарь дня',tabindex:'0'}),grid=el('div',{class:'calendar-inner'});grid.style.setProperty('--days',days.length);
  grid.append(el('div',{class:'corner'},'Время'));
  for(const column of columns)grid.append(el('div',{class:'day-head'+(column.day===data.today?' current':'')},dayLabel(column.day,true),el('small',{},column.timed.length+' по времени · '+column.floating.length+' без времени')));
  grid.append(el('div',{class:'all-day-label'},'Без времени'));
  for(const column of columns){const floating=el('div',{class:'all-day'});for(const item of column.floating.slice(0,2))floating.append(button(item.title,()=>detail(item),{class:'chip '+category(item),'aria-label':item.title+', '+when(item)}));if(column.floating.length>2)floating.append(button('Ещё '+(column.floating.length-2),()=>pile(column.floating.slice(2).map(item=>({item}))),{class:'chip'}));grid.append(floating);}
  const hours=el('div',{class:'hours'});for(let hour=0;hour<24;hour++){const tick=el('span',{class:'hour'},String(hour).padStart(2,'0')+':00');tick.style.setProperty('--minute',hour*60);hours.append(tick);}grid.append(hours);
  let groupNumber=0;
  for(const column of columns){const lane=el('div',{class:'day-column','aria-label':dayLabel(column.day)});const hidden=new Map();
    // A visual cluster is contiguous even when short labels need extra height.
    let cluster=[],until=-1;
    const flush=()=>{if(!cluster.length)return;const clusterId=++groupNumber;for(const entry of cluster)entry.cluster=clusterId;cluster=[];};
    for(const entry of column.timed){if(entry.start>=until){flush();until=-1;}cluster.push(entry);until=Math.max(until,entry.start+45,entry.end);}flush();
    for(const entry of column.timed){if(entry.lanes>3&&entry.lane>=2){const values=hidden.get(entry.cluster)??[];values.push(entry);hidden.set(entry.cluster,values);continue;}
      const item=entry.item,block=button('',()=>detail(item),{class:'event '+category(item)+(!entry.known?' unknown':'')+(entry.conflict?' conflict':''),'aria-label':item.title+', '+when(item)+(entry.conflict?', совпадает с другим событием':'')});
      block.style.setProperty('--start',entry.start);block.style.setProperty('--length',Math.max(1,entry.end-entry.start));block.style.setProperty('--lane',entry.lane);block.style.setProperty('--lanes',Math.min(3,entry.lanes));
      block.append(el('b',{},(entry.continuesBefore?'← ':'')+when(item)+(entry.continuesAfter?' →':'')+(entry.conflict?' ⚠':'')),el('span',{class:'event-title'},item.title));lane.append(block);
    }
    for(const entries of hidden.values()){const first=Math.min(...entries.map(entry=>entry.start)),last=Math.max(...entries.map(entry=>entry.end));const more=button('Ещё '+entries.length+' дел',()=>pile(entries),{class:'event more','aria-label':'Показать ещё '+entries.length+' дел в это время'});for(const[key,value]of Object.entries({start:first,length:Math.max(50,last-first),lane:2,lanes:3}))more.style.setProperty('--'+key,value);lane.append(more);}
    if(column.day===data.today){const line=el('div',{class:'now-line','aria-hidden':'true'});line.dataset.today='yes';lane.append(line);}grid.append(lane);
  }
  scroll.append(grid);content.append(scroll,el('div',{class:'legend'},el('span',{},'События'),el('span',{class:'study'},'Учёба'),el('span',{class:'task'},'Задачи и сроки')));
  requestAnimationFrame(()=>{const selectedTimes=columns[0].timed.filter(entry=>!entry.continuesBefore).map(entry=>entry.start),otherTimes=columns.flatMap(column=>column.timed.filter(entry=>!entry.continuesBefore).map(entry=>entry.start)),times=selectedTimes.length?selectedTimes:otherTimes,first=times.length?Math.min(...times):8*60;scroll.scrollTop=Math.max(0,first-20);updateNow();});
}
function updateNow(){if(!data)return;const p=new Intl.DateTimeFormat('en',{timeZone:data.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now()));const minute=Number(p.find(part=>part.type==='hour').value)*60+Number(p.find(part=>part.type==='minute').value);for(const line of document.querySelectorAll('.now-line'))line.style.setProperty('--minute',minute);}
let filterProject='',filterArea='';
function renderOverview(content){
  content.append(el('h2',{class:'date-label'},'Общая картина'),el('p',{class:'toolbar-note'},'Все открытые дела, включая дальние сроки и планы без даты.'));
  const projects=[...new Set([...(data.projects??[]),...data.items.map(item=>item.project).filter(Boolean)])].sort(),areas=[...new Set(data.items.map(item=>item.area).filter(Boolean))].sort();
  if(filterProject&&!projects.includes(filterProject))filterProject='';if(filterArea&&!areas.includes(filterArea))filterArea='';
  const select=(label,options,value,change)=>{const n=el('select',{'aria-label':label,onchange:event=>{change(event.target.value);shown=80;render();}},el('option',{value:''},label),...options.map(option=>el('option',{value:option},option)));n.value=value;return n;};
  content.append(el('div',{class:'filters'},select('Все проекты',projects,filterProject,value=>filterProject=value),select('Все сферы',areas,filterArea,value=>filterArea=value)));
  const items=data.items.filter(item=>(!filterProject||item.project===filterProject)&&(!filterArea||item.area===filterArea));
  content.append(el('div',{class:'stats'},...[[items.length,'открыто'],[items.filter(overdue).length,'просрочено'],[items.filter(item=>!item.day).length,'без даты']].map(([count,label])=>el('div',{class:'stat'},el('b',{},count),label))));
  const idleProjects=projects.filter(project=>!data.items.some(item=>item.project===project));if(!filterProject&&!filterArea&&idleProjects.length)content.append(el('div',{class:'notice'},'Проекты без открытых дел: '+idleProjects.join(', ')+'. Проверь, нужен ли следующий шаг.'));
  const groups=new Map([['Просроченные задачи',[]],['Сегодня',[]],['Ближайшие 7 дней',[]],['Дальние планы и сроки',[]],['Без даты',[]],['Прошедшие события',[]]]);
  for(const item of items){let allEnd=item.end_day??(item.day?plus(item.day,1):null);if(item.all_day&&item.source_day&&item.source_day!==item.day&&item.end_day)allEnd=plus(item.day,Math.max(1,Math.round((Date.parse(item.end_day)-Date.parse(item.source_day))/86400000)));const pastEvent=item.kind!=='task'&&(item.at?(item.duration?Date.parse(endAt(item))<=Date.parse(data.now):item.day<data.today):item.day&&(item.all_day?allEnd<=data.today:item.day<data.today));const coversToday=item.all_day&&item.day<=data.today&&allEnd>data.today;const key=overdue(item)?'Просроченные задачи':!item.day?'Без даты':pastEvent?'Прошедшие события':item.day===data.today||coversToday?'Сегодня':item.day>=data.today&&item.day<=plus(data.today,6)?'Ближайшие 7 дней':'Дальние планы и сроки';groups.get(key).push(item);}
  let remaining=shown;for(const[title,entries]of groups)if(entries.length&&remaining>0){const visible=entries.slice(0,remaining);remaining-=visible.length;content.append(group(title+(visible.length<entries.length?' · показано '+visible.length+' из '+entries.length:''),visible));}
  if(items.length>shown)content.append(button('Показать ещё дела · осталось '+(items.length-shown),()=>{shown+=80;render();},{class:'load-more'}));
  if(!items.length)content.append(el('div',{class:'empty'},el('h2',{},'Здесь пока нет дел'),el('p',{},filterProject||filterArea?'Попробуй выбрать другую сферу или проект.':'Напиши задачу в BOB или загрузи расписание .ics.')));
}
function shift(count){const next=plus(selected,count);if(next>='1900-01-01'&&next<='2100-12-25'){selected=next;render();}}
function render(){if(!data)return;for(const tab of document.querySelectorAll('[data-view]')){tab.setAttribute('aria-selected',String(tab.dataset.view===view));tab.setAttribute('tabindex',tab.dataset.view===view?'0':'-1');}const content=$('content');content.setAttribute('aria-labelledby','tab-'+view);content.replaceChildren();if(view==='ahead')renderOverview(content);else renderCalendar(content);$('status').textContent='Снимок на '+clock(data.now)+' · '+data.items.length+' открытых дел. Обнови после изменений в BOB.';}
async function api(path,extra={}){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg?.initData??'',...extra}),cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});let result;try{result=await response.json();}catch{throw Error('Сервер временно недоступен. Попробуй обновить.');}if(!response.ok)throw Error(result.text??'Не удалось открыть план.');return result;}
async function refresh(){if(loading)return;loading=true;$('refresh').disabled=true;
  try{if(!DEMO&&!tg?.initData)throw Error('Открой календарь кнопкой в личном чате @mybob_robot. В обычном браузере личные дела недоступны.');const next=DEMO??await api('/planner/data');data=next;loadedAt=performance.now();selected??=/^\d{4}-\d{2}-\d{2}$/.test(requestedDay??'')&&requestedDay>='1900-01-01'&&requestedDay<='2100-12-25'&&plus(requestedDay,0)===requestedDay?requestedDay:data.today;$('zone').textContent=data.zoneLabel??data.timezone;$('message').replaceChildren();render();}
  catch(error){notice(error.name==='TimeoutError'?'Сервер отвечает дольше обычного. Нажми обновление ещё раз.':error.message,true);if(!data)$('content').replaceChildren();}
  finally{loading=false;$('refresh').disabled=false;}
}
$('refresh').onclick=refresh;$('close-details').onclick=closeDialog;$('details').addEventListener('close',()=>{try{tg?.BackButton?.hide();}catch{}});
for(const tab of document.querySelectorAll('[data-view]')){tab.onclick=()=>setView(tab.dataset.view);tab.onkeydown=event=>{if(['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){event.preventDefault();const views=['day','week','ahead'],index=event.key==='Home'?0:event.key==='End'?2:(views.indexOf(view)+(event.key==='ArrowRight'?1:2))%3;setView(views[index]);$('tab-'+view).focus();}};}
try{tg?.ready();tg?.expand();tg?.BackButton?.onClick(closeDialog);tg?.setHeaderColor('#101722');tg?.setBackgroundColor('#101722');tg?.onEvent('activated',()=>{if(performance.now()-loadedAt>60000)refresh();});}catch{}
setInterval(updateNow,60000);refresh();
`;
