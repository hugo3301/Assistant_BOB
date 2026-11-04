import {randomBytes} from 'node:crypto';
import {BobError,requireThat} from './errors.mjs';
import {normalize} from './dates.mjs';
import {selectItems,renderList,cardText,PAGE_SIZE,friendlyResponse} from './views.mjs';
import {naturalView} from './natural.mjs';
export const uiButton=(text,callback_data)=>({text,callback_data});
const data=(token,action,value='')=>`u|${token}|${action}|${value}`;
export class BotUI {
 constructor(store,{clock,dispatch,admin=false}){this.store=store;this.clock=clock;this.dispatch=dispatch;this.admin=admin;}
 snapshot(owner,payload){const token=randomBytes(10).toString('hex');return{token,payload,persist:()=>{this.store.db.prepare('INSERT INTO ui_views VALUES (?,?,?,?)').run(token,owner,JSON.stringify(payload),new Date(Date.parse(this.clock())+86400000).toISOString());this.store.db.prepare('DELETE FROM ui_views WHERE owner=? AND expires_at<?').run(owner,this.clock());}};}
 load(owner,token){const row=this.store.db.prepare('SELECT * FROM ui_views WHERE token=? AND owner=? AND expires_at>?').get(token,owner,this.clock());requireThat(row,'VIEW_EXPIRED','Эта кнопка устарела. Открой свежий список: Сегодня или Неделя.');return{token,payload:JSON.parse(row.data),persist:()=>{}};}
 list(owner,filter,page=0,snapshot=null){
  snapshot??=this.snapshot(owner,{type:'items',filter,ids:selectItems(this.store,owner,filter,this.clock()).map(item=>item.id)});
  const entries=snapshot.payload.ids.map(id=>this.store.item(owner,id)).filter(item=>item?.status==='open');
  const rendered=renderList(entries,{scope:filter.scope,now:this.clock(),timezone:this.store.user(owner).timezone,page});const rows=[];
  for(let index=0;index<rendered.visible.length;index+=2)rows.push(rendered.visible.slice(index,index+2).map((item,local)=>uiButton(`${rendered.page*PAGE_SIZE+index+local+1}. Открыть`,data(snapshot.token,'item',snapshot.payload.ids.indexOf(item.id)))));
  const nav=[];if(rendered.page>0)nav.push(uiButton('‹ Назад',data(snapshot.token,'page',rendered.page-1)));if(rendered.page+1<rendered.pages)nav.push(uiButton('Дальше ›',data(snapshot.token,'page',rendered.page+1)));if(nav.length)rows.push(nav);
  rows.push([uiButton('↻ Обновить',data(snapshot.token,'refresh')),uiButton('Меню',data(snapshot.token,'home'))]);
  const persist=()=>{snapshot.persist();this.store.db.prepare('INSERT INTO ui_state VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data').run(owner,JSON.stringify({token:snapshot.token,page:rendered.page,numbers:Object.fromEntries(rendered.visible.map((item,index)=>[rendered.page*PAGE_SIZE+index+1,item.id])),versions:Object.fromEntries(rendered.visible.map(item=>[item.id,item.version]))}));};
  return{text:rendered.text+(rendered.visible.length?'\n\nНажми номер, чтобы открыть дело.':''),replyMarkup:{inline_keyboard:rows},persist};
 }
 card(owner,id,back=null){const item=this.store.item(owner,id);requireThat(item,'ITEM_GONE','Это дело уже недоступно. Открой свежий список.');const snapshot=this.snapshot(owner,{type:'card',id,version:item.version,back}),rows=[];
  if(item.status==='open'){if(item.kind==='task')rows.push([uiButton('✅ Готово',data(snapshot.token,'done'))]);rows.push([uiButton('Перенести',data(snapshot.token,'move')),uiButton('Убрать',data(snapshot.token,'remove'))]);}
  rows.push([uiButton('К списку',data(snapshot.token,'back')),uiButton('Меню',data(snapshot.token,'home'))]);return{text:cardText(item,this.store.user(owner),this.clock()),focusId:id,replyMarkup:{inline_keyboard:rows},persist:snapshot.persist};
 }
 home(owner){const snapshot=this.snapshot(owner,{type:'home'});return{text:'BOB · твои дела под рукой\n\nНапиши обычными словами, например:\n«Завтра в 7 вечера встреча»\n«Сдать отчёт к пятнице»\n\nИли выбери, что показать. Расписание можно прислать файлом .ics.',replyMarkup:{inline_keyboard:[[uiButton('📅 Сегодня',data(snapshot.token,'today')),uiButton('🗓 Неделя',data(snapshot.token,'week'))],[uiButton('🔭 Все дела',data(snapshot.token,'ahead')),uiButton('📂 Проекты',data(snapshot.token,'projects'))],[uiButton('⚙ Настройки',data(snapshot.token,'settings'))],[uiButton('Ресурс ИИ','a|quota'),...(this.admin?[uiButton('Пригласить друга','a|invite')]:[])]]},persist:snapshot.persist};}
 settings(owner){const user=this.store.user(owner),snapshot=this.snapshot(owner,{type:'settings'});return{text:`⚙ Настройки\n\nУтренняя сводка: ${user.morning_time??'выключена'}\nНапоминания: за ${user.reminder_minutes} мин.\nЧасовой пояс: ${user.timezone}\n\nВремя отдельной встречи можно указать прямо в сообщении.`,replyMarkup:{inline_keyboard:[[uiButton('Сводка 08:00',data(snapshot.token,'morning','08:00')),uiButton('Сводка 09:00',data(snapshot.token,'morning','09:00')),uiButton('Выключить сводку',data(snapshot.token,'morning','off'))],[uiButton('За 30 мин',data(snapshot.token,'remind','30')),uiButton('За час',data(snapshot.token,'remind','60')),uiButton('За 2 часа',data(snapshot.token,'remind','120'))],[uiButton('Меню',data(snapshot.token,'home'))]]},persist:snapshot.persist};}
 projects(owner){const all=this.store.items(owner),names=this.store.db.prepare('SELECT name FROM projects WHERE owner=? ORDER BY name').all(owner).map(row=>row.name),snapshot=this.snapshot(owner,{type:'projects',names});const text=['📂 Проекты','',...names.map(name=>`${name} · ${all.filter(item=>item.project===name).length} открытых дел`)];if(!names.length)text.push('Пока нет проектов. Напиши /project и название, затем добавляй его дела.');text.push('','Без проекта: '+all.filter(item=>!item.project).length+' дел');return{text:text.join('\n'),replyMarkup:{inline_keyboard:[...names.slice(0,30).map((name,index)=>[uiButton(name.slice(0,45),data(snapshot.token,'project',index))]),[uiButton('Все дела',data(snapshot.token,'ahead')),uiButton('Меню',data(snapshot.token,'home'))]]},persist:snapshot.persist};}
 async handle(owner,text,{requestId,callback=null,requestText}={}){
  const source=requestText??(callback?`callback:${callback.id}:${callback.data}`:text),cached=this.store.cachedTurn(owner,requestId,source);if(cached)return cached;let view=null;
  try{
   if(callback){
    const match=/^u\|([a-f0-9]{20})\|([a-z]+)\|([\w:.-]*)$/.exec(callback.data??'');requireThat(match,'VIEW_EXPIRED','Эта кнопка устарела. Открой меню.');const snap=this.load(owner,match[1]),action=match[2],value=match[3];
    if(['home','today','week','ahead','settings','projects'].includes(action))view=action==='home'?this.home(owner):action==='settings'?this.settings(owner):action==='projects'?this.projects(owner):this.list(owner,{scope:action});
    else if(action==='page'||action==='refresh'){requireThat(snap.payload.type==='items','VIEW_EXPIRED','Открой свежий список.');view=this.list(owner,snap.payload.filter,Number(value)||0,action==='refresh'?null:snap);}
    else if(action==='item'){requireThat(snap.payload.type==='items'&&/^\d+$/.test(value),'VIEW_EXPIRED','Открой свежий список.');const id=snap.payload.ids[Number(value)];requireThat(id,'VIEW_EXPIRED','Открой свежий список.');const state=JSON.parse(this.store.db.prepare('SELECT data FROM ui_state WHERE owner=?').get(owner)?.data??'{}');view=this.card(owner,id,{token:snap.token,page:state.page??0});}
    else if(action==='back'){const back=snap.payload.back;view=back?this.list(owner,this.load(owner,back.token).payload.filter,back.page,this.load(owner,back.token)):this.list(owner,{scope:'all'});}
    else if(action==='project'){requireThat(snap.payload.type==='projects'&&snap.payload.names[Number(value)],'VIEW_EXPIRED','Открой проекты заново.');view=this.list(owner,{scope:'project',project:snap.payload.names[Number(value)]});}
    else if(['morning','remind'].includes(action)){requireThat(snap.payload.type==='settings'&&(action==='morning'?['08:00','09:00','off']:['30','60','120']).includes(value),'VIEW_EXPIRED','Открой настройки заново.');return friendlyResponse(await this.dispatch(owner,`/${action} ${value}`,{requestId,requestText:source}));}
    else if(['done','remove','move'].includes(action)){
     requireThat(snap.payload.type==='card','VIEW_EXPIRED','Открой дело заново.');const item=this.store.item(owner,snap.payload.id);requireThat(item,'ITEM_GONE','Это дело недоступно.');
     if(item.version!==snap.payload.version||item.status!=='open')view={...this.card(owner,item.id,snap.payload.back),text:'Карточка изменилась. Показываю актуальные данные.\n\n'+cardText(item,this.store.user(owner),this.clock())};
     else if(action==='move')view={text:item.kind==='task'?'На какой день перенести срок? Например: «на следующую пятницу».':'Когда теперь состоится? Например: «завтра в 7 вечера».',focusId:item.id,pending:{kind:'ui_move',id:item.id,version:item.version,referenceAt:this.clock(),expiresAt:new Date(Date.parse(this.clock())+3600000).toISOString()},persist:()=>{}};
     else return friendlyResponse(await this.dispatch(owner,`/${action==='done'?'done':'remove'} ${item.id}`,{requestId,requestText:source}));
    }else throw new BobError('VIEW_EXPIRED','Открой меню и выбери действие ещё раз.');
   }else{
    const clean=normalize(text).replace(/[!?.,]+$/u,'');const scope={'/today':'today','сегодня':'today','/week':'week','неделя':'week','на неделю':'week','/ahead':'ahead','все дела':'ahead','/tasks':'all'}[clean];
    const natural=naturalView(text),number=/^(?:открой\s+)?(\d+)$/u.exec(clean),state=JSON.parse(this.store.db.prepare('SELECT data FROM ui_state WHERE owner=?').get(owner)?.data??'{}');
    const numberedAction=/^(?:удали|убери|отмени|сдал|сделал|перенеси)\s+(?:дело\s+|задачу\s+|номер\s+|№\s*)?(\d+)(?=\s|[,.!]|$)/u.exec(clean);
    const selected=numberedAction?state.numbers?.[numberedAction[1]]:null,old=selected&&(!this.store.db.prepare('SELECT token FROM ui_views WHERE token=? AND owner=? AND expires_at>?').get(state.token,owner,this.clock())||state.versions?.[selected]!==this.store.item(owner,selected)?.version);
    if(old){view=this.list(owner,{scope:'all'});view.text='Список изменился или устарел. Выбери номер из свежего списка.\n\n'+view.text;}
    else if(scope)view=this.list(owner,{scope});else if(['/start','/help','помощь','меню','привет'].includes(clean))view=this.home(owner);else if(['/settings','настройки'].includes(clean))view=this.settings(owner);else if(['/projects','проекты'].includes(clean))view=this.projects(owner);else if(/^\/find\s+/iu.test(text))view=this.list(owner,{scope:'search',query:text.replace(/^\/find\s+/iu,'').trim()});else if(natural)view=this.list(owner,natural);else if(number&&state.numbers?.[number[1]]&&!this.store.user(owner).pending){this.load(owner,state.token);view=this.card(owner,state.numbers[number[1]],{token:state.token,page:state.page});}else return null;
   }
   const claim=this.store.beginTurn(owner,requestId,source,this.clock());if(claim.cached)return{...claim.cached,replayed:true};const user=this.store.user(owner),{persist,...result}=view;
   return this.store.finishTurn(owner,requestId,claim.lease,user.revision,text,{status:'ok',changed:0,modelCalls:0,pending:null,edit:Boolean(callback),...result},persist);
  }catch(error){if(!(error instanceof BobError))throw error;return{status:'error',code:error.code,text:error.message,changed:0,modelCalls:0};}
 }
}
