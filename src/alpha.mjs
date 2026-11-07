import { randomUUID } from 'node:crypto';
import { BobError, requireThat } from './errors.mjs';
import { dayAt, addDays, localToUtc, formatDate, normalize } from './dates.mjs';
import { calendarPreview, calendarImport } from './calendar.mjs';
import {prepareCalendarUpload,prepareCalendarChoice,isCalendarAnswer} from './calendar-flow.mjs';
import {BotUI} from './bot-ui.mjs';
import {friendlyZone,morningInput,zoneLabel} from './zones.mjs';
import {reminderFromText} from './assistant.mjs';
import {nav,UI,minuteLabel} from './ui-kit.mjs';
import {isNewRequest} from './policy.mjs';
import {BulkActions} from './bulk-actions.mjs';
import {quickActions} from './natural.mjs';
import {conversationIntent} from './conversation.mjs';
import {unrelatedRequest} from './input-scope.mjs';
import {PRIVATE_INPUT_MESSAGE} from './privacy.mjs';

export const HELP = `Я BOB, твой личный помощник. Напиши: «Добавь задачу сдать отчёт к 12 ноября» или «Встреча завтра в 15:00, напомни за час». Следом можно: «Перенеси её на завтра в 16:00».

/today — сегодня и просроченное
/week — ближайшие 7 дней
/ahead — вся картина, включая далёкие сроки и дела без даты
/find текст — поиск
/projects — обзор проектов и категорий
/project Название — создать/выбрать проект для новых дел; /project off — выйти
/area Учёба — категория новых дел (Учёба, Проекты, Зал, Питание, Личное)
/done id — завершить задачу; /remove id — отменить дело
/repeat пн,ср,пт 18:00 60 Зал — еженедельные занятия (60 минут)
/repeats — серии; /repeat stop id — остановить серию
Пришли .ics — расставлю пары и напоминания. Если в файле разные группы, один раз уточню свои обычным вопросом и запомню выбор.
/diet текст — сохранить свой рацион; /diet — показать
/settings — настройки; /morning 08:00 или off; /remind 60; /timezone Asia/Tomsk
/export — выгрузить данные файлом
/cancel — отменить уточнение

Альфа: серии задаются командой, сложные даты могут требовать уточнения. Сообщения с делами обрабатывает Cloudflare Workers AI. Неотправленные уведомления видны в /status.`;
export class Alpha {
  constructor(store, assistant, { clock = () => new Date().toISOString(),admin=false } = {}) { this.store = store; this.assistant = assistant; this.clock = clock; this.bulk=new BulkActions(store,{clock});this.ui=new BotUI(store,{clock,admin,dispatch:(owner,text,options)=>this.handle(owner,text,{...options,skipUi:true})}); }
  preferences(owner) { return this.store.db.prepare('SELECT * FROM alpha_preferences WHERE owner=?').get(owner); }
  async handle(owner, text, { requestId=randomUUID(), documentText,caption='',requestText,callback,skipUi=false,returnMarkup } = {}) {
    requireThat(this.assistant.allowedOwners.has(owner), 'OWNER_NOT_ALLOWED', 'Нет доступа.');
    if([text,caption,documentText].some(value=>value&&this.assistant.sensitiveText(value)))return {status:'error',code:'SENSITIVE_INPUT',changed:0,modelCalls:0,text:PRIVATE_INPUT_MESSAGE};
    this.store.ensureUser(owner);
    const input=this.store.user(owner).pending;
    if(!skipUi&&!callback&&documentText===undefined&&!this.ui.profile(owner)?.onboarding&&(conversationIntent(text,input)||unrelatedRequest(text,input))){const bulkAnswer=await this.bulk.handle(owner,text,{requestId,requestText});if(bulkAnswer)return bulkAnswer;return this.assistant.handle(owner,text,{requestId,requestText:requestText??text});}
    if(!skipUi&&!callback&&documentText===undefined&&input?.kind==='ui_input'&&input.expiresAt>this.clock()&&!isNewRequest(text)&&! /^(?:удали|убери|надо|нужно|сдать|перенеси)\s/iu.test(text)){
      try{let value=text.trim();if(input.field==='timezone'){value=friendlyZone(value);requireThat(value,'SETTING','Не узнал город. Можно выбрать его кнопкой или написать «UTC+5».');}if(input.field==='morning')value=morningInput(value,this.clock(),this.store.user(owner).timezone);if(input.field==='remind'){value=/^\d+$/u.test(value)?Number(value):reminderFromText('за '+value,null);requireThat(value!==null,'SETTING','Напиши, насколько заранее: например, «за полчаса» или «45 минут».');}
        return this.handle(owner,`/${input.field==='timezone'?'timezone':input.field} ${value}`,{requestId,requestText:requestText??text,skipUi:true,returnMarkup:{inline_keyboard:[[nav(input.field==='project'?'К проектам':input.field==='diet'?'Мой рацион':'К настройкам',input.field==='project'?'projects':input.field==='diet'?'diet':'settings'),nav(UI.home)]]}});
      }catch(error){if(!(error instanceof BobError))throw error;return this.ui.handle(owner,`/ui-input ${input.field}`,{requestId,requestText:requestText??text,inputError:error.message});}
    }
    if(!skipUi&&!callback&&this.ui.profile(owner)?.onboarding&&!/^\/timezone\s/iu.test(text)){const zone=documentText===undefined?friendlyZone(text):null;if(zone)return this.handle(owner,`/timezone ${zone}`,{requestId,requestText:requestText??text,skipUi:true,returnMarkup:{inline_keyboard:[[nav('Продолжить','home'),nav(UI.settings,'settings')]]}});return this.ui.handle(owner,'/start',{requestId,requestText:requestText??text});}
    if(!skipUi&&documentText===undefined){const result=await this.bulk.handle(owner,text,{requestId,callback,requestText});if(result)return result;}
    if(!skipUi&&documentText===undefined&&(callback||!isCalendarAnswer(this.store,owner,text,this.clock()))){const result=await this.ui.handle(owner,text,{requestId,callback,requestText});if(result)return result;}
    const moving=this.store.user(owner).pending;
    if(!callback&&documentText===undefined&&moving?.kind==='ui_move'&&moving.expiresAt>this.clock()&&!isNewRequest(text)){
      const item=this.store.item(owner,moving.id);
      if(item?.status!=='open'||item.version!==moving.version)return this.assistant.handle(owner,'/cancel',{requestId,requestText:text});
      const task=item.kind==='task',source=`Перенеси ${task?'срок сдачи ':''}${item.id} на ${text}`;
      return this.assistant.handle(owner,source,{requestId,requestText:text,applicationCalls:[{name:task?'change_deadline':'move_event',args:{target_id:item.id,[task?'due_text':'when_text']:text}}]});
    }
    const command = /^\/(\w+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    let name = documentText === undefined ? command?.[1]?.toLowerCase() : 'calendar_upload';
    let argument = command?.[2]?.trim() ?? '';
    if(name==='timezone')argument=friendlyZone(argument)??argument;
    if(!name&&isCalendarAnswer(this.store,owner,text,this.clock()))name='calendar_choice';
    if (!['start','help','settings','morning','timezone','remind','projects','project','area','done','remove','repeat','repeats','diet','status','ical','calendar_upload','calendar_choice','export'].includes(name)){const quick=quickActions(text,this.store,owner);return this.assistant.handle(owner, quick?.text??text.replace(/^(\/\w+)@mybob_robot\b/u, '$1'), { requestId,requestText:requestText??text,...(quick?{applicationCalls:quick.calls}:{}) });}
    this.store.ensureUser(owner); const now = this.clock();
    const claim = this.store.beginTurn(owner, requestId, requestText??(documentText === undefined ? text : text + '\n' + caption + '\n' + documentText), now);
    if (claim.cached) return { ...claim.cached, replayed: true };
    const user = this.store.user(owner), preferences = this.preferences(owner);
    let result = '', mutate = () => {}, file = null,extra={};
    try {
      if (name === 'start' || name === 'help') result = HELP;
      if (name === 'settings') result = `Часовой пояс: ${user.timezone}\nСводка: ${user.morning_time ?? 'выключена'}\nНапоминать за ${user.reminder_minutes} мин.\nПроект новых дел: ${preferences.project ?? 'не выбран'}\nКатегория: ${preferences.area}`;
      if (name === 'morning') {
        requireThat(argument === 'off' || /^([01]\d|2[0-3]):[0-5]\d$/.test(argument), 'SETTING', 'Например: /morning 08:00 или /morning off');
        mutate = () => { this.store.db.prepare('UPDATE users SET morning_time=? WHERE id=?').run(argument === 'off' ? null : argument, owner); this.store.db.prepare("UPDATE reminders SET status='cancelled' WHERE owner=? AND kind='morning' AND status IN ('pending','claimed')").run(owner);const today=dayAt(now,user.timezone),from=argument==='off'?null:localToUtc(today,argument,user.timezone)>now?today:addDays(today,1);this.store.db.prepare('UPDATE ui_profiles SET morning_from=? WHERE owner=?').run(from,owner); };
        result = argument === 'off' ? 'Утренняя сводка выключена.' : `Утренняя сводка настроена\n\nКаждый день в ${argument}\n${zoneLabel(user.timezone,now)}`;
      }
      if (name === 'timezone') {
        try { new Intl.DateTimeFormat('en', { timeZone: argument }).format(); } catch { throw new BobError('SETTING', 'Выбери город в настройках или напиши смещение, например UTC+5.'); }
        mutate = () => { this.store.db.prepare('UPDATE users SET timezone=? WHERE id=?').run(argument, owner); this.store.db.prepare("UPDATE reminders SET status='cancelled' WHERE owner=? AND kind='morning' AND status IN ('pending','claimed')").run(owner);const today=dayAt(now,argument),from=user.morning_time?(localToUtc(today,user.morning_time,argument)>now?today:addDays(today,1)):null;this.store.db.prepare('UPDATE ui_profiles SET onboarding=0,morning_from=? WHERE owner=?').run(from,owner); };
        result = `Часовой пояс настроен\n\n${zoneLabel(argument,now)}\nДела и напоминания показываю по твоему времени.`;
      }
      if (name === 'remind') {
        const minutes = Number(argument); requireThat(/^\d+$/.test(argument) && minutes <= 43200, 'SETTING', 'Укажи число минут: /remind 60');
        mutate = () => this.store.db.prepare('UPDATE users SET reminder_minutes=? WHERE id=?').run(minutes, owner);
        result = `Напоминания для новых дел\n\n${minuteLabel(minutes)}`;
      }
      if (name === 'project') {
        requireThat(argument.length > 0 && argument.length <= 80 && !/[\r\n]/u.test(argument), 'PROJECT', 'Укажи название проекта до 80 символов или /project off.');
        mutate = () => { if (argument !== 'off') this.store.db.prepare('INSERT OR IGNORE INTO projects(owner,name) VALUES (?,?)').run(owner, argument); this.store.db.prepare('UPDATE alpha_preferences SET project=? WHERE owner=?').run(argument === 'off' ? null : argument, owner); };
        result = argument === 'off' ? 'Новые дела вне проекта.' : `Проект «${argument}» выбран. Новые дела будут в нём.`;
      }
      if (name === 'area') {
        const area = ['Учёба','Проекты','Зал','Питание','Личное'].find(value => normalize(value) === normalize(argument));
        requireThat(area, 'AREA', 'Выбери: Учёба, Проекты, Зал, Питание, Личное.');
        mutate = () => this.store.db.prepare('UPDATE alpha_preferences SET area=? WHERE owner=?').run(area, owner); result = `Категория новых дел: ${area}.`;
      }
      if (name === 'projects') {
        const items = this.store.items(owner), groups = this.store.db.prepare('SELECT name FROM projects WHERE owner=? ORDER BY name').all(owner).map(row => ({ title: `Проект «${row.name}»`, items: items.filter(item => item.project === row.name) }));
        for (const area of ['Учёба','Проекты','Зал','Питание','Личное']) { const found = items.filter(item => !item.project && item.area === area); if (found.length) groups.push({title: area, items: found}); }
        result = groups.length ? groups.map(group => `${group.title}: ${group.items.length} открытых\n${group.items.map(item => `• ${item.title} — ${item.day ? formatDate(item.day,item.at,user.timezone) : 'без даты'} [${item.id}]`).join('\n') || 'Пока без задач. Добавь ближайший шаг.'}`).join('\n\n') : 'Проектов пока нет. /project Название — создать и выбрать.';
      }
      if (name === 'done' || name === 'remove') {
        const item = this.store.item(owner, argument);
        requireThat(item?.status === 'open' && (name !== 'done' || item.kind === 'task'), 'TARGET', 'Укажи id открытого дела из /tasks; /done закрывает только задачи.');
        extra.focusId=item.id;
        mutate = () => { this.store.changeItem(owner, item.id, {status: name === 'done' ? 'completed' : 'cancelled'}, now); for (const child of this.store.items(owner).filter(child => child.parent_id === item.id)) this.store.changeItem(owner, child.id, {status:'cancelled'}, now); };
        result = `${name === 'done' ? 'Выполнено' : 'Отменено'}: ${item.title}`;
      }
      if (name === 'diet') {
        requireThat(argument.length <= 6000, 'DIET', 'Сохрани рацион текстом до 6000 символов.');
        if (argument) { mutate = () => this.store.db.prepare('UPDATE alpha_preferences SET diet=? WHERE owner=?').run(argument, owner); result = 'Твой рацион сохранён. /diet — показать. Это твоя запись, автоматические рекомендации по питанию не добавлял.'; }
        else result = preferences.diet ?? 'Рацион пока не записан. /diet твой текст — сохранить.';
      }
      if (name === 'repeat') {
        if (argument.startsWith('stop ')) {
          const id = argument.slice(5).trim(), series = this.store.db.prepare('SELECT * FROM weekly_series WHERE id=? AND owner=? AND active=1').get(id, owner);
          requireThat(series, 'SERIES', 'Серия не найдена. /repeats — список.');
          mutate = () => { this.store.db.prepare('UPDATE weekly_series SET active=0 WHERE id=? AND owner=?').run(id, owner); for (const item of this.store.items(owner).filter(item => item.series_id === id && item.at > now)) this.store.changeItem(owner, item.id, {status:'cancelled'}, now); };
          result = `Серия «${series.title}» остановлена, будущие занятия и напоминания отменены.`;
        } else {
          const match = /^([а-я,]+)\s+([0-2]\d:[0-5]\d)\s+(\d{1,4})\s+(.{1,120})$/iu.exec(argument), map = {вс:0,пн:1,вт:2,ср:3,чт:4,пт:5,сб:6};
          requireThat(match, 'SERIES', 'Формат: /repeat пн,ср,пт 18:00 60 Зал');
          const days = [...new Set(match[1].toLowerCase().split(',').map(day => map[day]))], duration = Number(match[3]);
          requireThat(days.every(day => day !== undefined) && Number(match[2].slice(0,2)) < 24 && duration > 0 && duration <= 1440, 'SERIES', 'Проверь дни, время и длительность.');
          const id = `series-${randomUUID().slice(0,8)}`;
          mutate = () => { this.store.db.prepare('INSERT INTO weekly_series VALUES (?,?,?,?,?,?,?,?,?)').run(id,owner,match[4],JSON.stringify(days),match[2],duration,user.timezone,1,now); this.expandSeries(owner, now, id); };
          result = `Серия «${match[4]}»: ${match[1]}, ${match[2]}, ${duration} мин., ${user.timezone}. Ближайшие 6 недель появятся в обзоре; горизонт автоматически пополняется. /repeat stop ${id} — остановить.`;
        }
      }
      if (name === 'repeats') result = this.store.db.prepare('SELECT * FROM weekly_series WHERE owner=? AND active=1').all(owner).map(series => `${series.title} — ${series.time}, ${series.timezone} [${series.id}]`).join('\n') || 'Активных серий нет. Пример: /repeat пн,ср,пт 18:00 60 Зал';
      if (name === 'calendar_upload') {
        const plan=prepareCalendarUpload(this.store,owner,documentText,caption,now);result=plan.text;mutate=plan.mutate;extra.pending=null;
      }
      if(name==='calendar_choice'){const plan=prepareCalendarChoice(this.store,owner,text,now);result=plan.text;mutate=plan.mutate;extra.pending=null;}
      if (name === 'ical') {
        const staged = this.store.db.prepare('SELECT * FROM calendar_previews WHERE owner=?').get(owner);
        requireThat(staged, 'CALENDAR', 'Сначала пришли .ics файлом.');
        if (!argument || argument === 'list') result = calendarPreview(staged.body,user.timezone,now).text;
        else {
          const plan=prepareCalendarChoice(this.store,owner,argument,now);result=plan.text;mutate=plan.mutate;extra.pending=null;
        }
      }
      if (name === 'status') {
        const usage = this.store.usage(now.slice(0,10)), failures = this.store.db.prepare("SELECT COUNT(*) AS count FROM reminders WHERE owner=? AND status='failed'").get(owner).count;
        result = `BOB alpha работает.\nИИ сегодня: ${usage.spent.toFixed(2)} neurons, резерв ${usage.reserved.toFixed(2)}.\nНе доставлено после повторов: ${failures}.\nСводка: ${user.morning_time ?? 'выключена'}, ${user.timezone}.\nДля нештатного случая сохрани /export. Доставка зависит от Telegram/Cloudflare, точная секунда не гарантирована.`;
      }
      if (name === 'export') {
        file = { name: 'bob-export.json', text: JSON.stringify({version:1,exportedAt:now,user:{timezone:user.timezone,morningTime:user.morning_time,reminderMinutes:user.reminder_minutes},preferences,items:this.store.items(owner,{includeClosed:true}),series:this.store.db.prepare('SELECT * FROM weekly_series WHERE owner=?').all(owner),projects:this.store.db.prepare('SELECT name FROM projects WHERE owner=?').all(owner)},null,2) };
        result = 'Экспорт твоих данных BOB. Храни файл у себя; ключей доступа в нём нет.';
      }
      return this.store.finishTurn(owner,requestId,claim.lease,user.revision,text,{status:'ok',text:result,changed:['done','remove','repeat'].includes(name)?1:0,modelCalls:0,...(['done','remove','timezone','morning','remind','project','area'].includes(name)?{pending:null}:{}),...extra,...(returnMarkup?{replyMarkup:returnMarkup}:{}),...(file ? {file} : {})},mutate);
    } catch (error) {
      if (!(error instanceof BobError)) throw error;
      return this.store.finishTurn(owner,requestId,claim.lease,user.revision,text,{status:'error',code:error.code,text:error.message,changed:0,modelCalls:0});
    }
  }
  expandSeries(owner, now, onlyId = null) {
    const user = this.store.user(owner);
    const series = this.store.db.prepare('SELECT * FROM weekly_series WHERE owner=? AND active=1').all(owner).filter(row => !onlyId || row.id === onlyId);
    let added = 0;
    for (const row of series) {
      const days = JSON.parse(row.days), today = dayAt(now,row.timezone);
      for (let offset = 0; offset < 42; offset++) {
        const day = addDays(today,offset); if (!days.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
        let at; try { at = localToUtc(day,row.time,row.timezone); } catch { continue; }
        const id = `${row.id}:${day}`;
        if (at <= now || this.store.item(owner,id)) continue;
        this.store.putItem({id,owner,kind:'event',title:row.title,day,at,duration:row.duration,series_id:row.id,area:/зал|трениров/iu.test(row.title)?'Зал':'Личное',project:null},now,user.reminder_minutes); added++;
      }
    }
    return added;
  }
}
