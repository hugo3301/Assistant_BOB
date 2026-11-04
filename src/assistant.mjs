import { randomUUID } from 'node:crypto';
import { BobError, requireThat } from './errors.mjs';
import { resolveDate, verifyDatePhrase, normalize, formatDate, cleanUserText,dayAt } from './dates.mjs';
import { selectTarget, allowDeadlineChange, isNewRequest, validatePermission } from './policy.mjs';
import { decodeCalls } from './tools.mjs';
import { overview } from './views.mjs';
import {modelContext} from './context.mjs';
import {conversationIntent,fastConversation} from './conversation.mjs';

export function reminderFromText(text, fallback) {
  const source = normalize(text);
  if (/не\s+напоминай|без\s+напоминан/u.test(source)) return null;
  if (/за\s+полчаса/u.test(source)) return 30;
  if (/за\s+(?:один\s+)?час(?:\s|[,.!?]|$)/u.test(source)) return 60;
  if (/за\s+два\s+часа/u.test(source)) return 120;
  const match = /за\s+(\d+)\s*(минут[а-я]*|час[а-я]*)/u.exec(source);
  if (match) { const minutes = Number(match[1]) * (match[2].startsWith('час') ? 60 : 1); requireThat(minutes <= 43200, 'REMINDER_RANGE', 'Слишком большой интервал напоминания.'); return minutes; }
  return fallback;
}
export function durationFromText(text) {
  const source = normalize(text);
  if (/(?:на|выдели|уточнение:)\s+полчаса/u.test(source) || source === 'полчаса') return 30;
  if (/(?:на|выдели|уточнение:)\s+(?:один\s+)?час(?:\s|[,.!?]|$)/u.test(source) || source === 'час') return 60;
  const match = /(?:на|выдели|уточнение:)\s+(\d+)\s*(минут[а-я]*|час[а-я]*)/u.exec(source);
  return match ? Number(match[1]) * (match[2].startsWith('час') ? 60 : 1) : null;
}

export class Assistant {
  constructor(store, { provider = null, allowedOwners = ['local'], clock = () => new Date().toISOString(), maxCalls = 2, timeBudgetMs=18000 } = {}) {
    requireThat(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 2, 'CALL_LIMIT', 'Допускаются один или два модельных шага.');
    this.store = store; this.provider = provider; this.allowedOwners = new Set(allowedOwners); this.clock = () => new Date(clock()).toISOString(); this.maxCalls = maxCalls; this.timeBudgetMs=timeBudgetMs;this.locks = new Map();
  }
  handle(owner, text, options = {}) {
    requireThat(this.allowedOwners.has(owner), 'OWNER_NOT_ALLOWED', 'Этот помощник не настроен для данного владельца.');
    const next = (this.locks.get(owner) ?? Promise.resolve()).catch(() => {}).then(() => this.run(owner, text, options));
    const final = next.finally(() => { if (this.locks.get(owner) === final) this.locks.delete(owner); });
    this.locks.set(owner, final); return final;
  }
  prepare(owner, calls, text, user, referenceAt = this.clock()) {
    const items = this.store.items(owner), prepared = [], targets = new Set(), intervals = [];
    for (const [index, call] of calls.entries()) {
      const { name, args } = call;
      validatePermission(name, text);
      if (!['list_items', 'ask_user'].includes(name)) requireThat(!/кажд|еженед|ежеднев|раз[а]?\s+в\s+недел/iu.test(text), 'REPEAT_UNSUPPORTED', 'Серию пока нужно задать командой. Например: /repeat пн,ср,пт 18:00 60 Зал — занятия по часу в 18:00.');
      if (name === 'list_items') { prepared.push({ kind: 'read', scope: args.scope }); continue; }
      if (name === 'ask_user') { prepared.push({ kind: 'question', question: args.question }); continue; }
      if (name === 'reply_user') { requireThat(!/(?:^|[\s.!?,])(?:я\s+)?(?:добавил|сохранил|перен[её]с|удалил|отменил|завершил|отправил|настроил)(?:а|и)?(?=$|[\s,.!?:;])/iu.test(args.answer),'REPLY_ACTION_CLAIM','Ответ не должен заявлять об изменении дел.');prepared.push({kind:'answer',text:args.answer});continue; }
      let target = null;
      if (['change_deadline', 'move_event', 'plan_work', 'complete_task', 'cancel_item'].includes(name)) {
        try { target = selectTarget(text, items, user.focus_id, args.target_id); }
        catch (error) { error.details = { ...error.details, index }; throw error; }
        requireThat(!targets.has(target.id), 'DUPLICATE_TARGET', 'Один объект нельзя менять дважды в одном пакете.');
        targets.add(target.id);
        if (name === 'change_deadline') requireThat(target.kind === 'task' && allowDeadlineChange(text), 'DEADLINE_PERMISSION', 'Нужно изменить срок сдачи или выделить другое время для работы?');
        if (name === 'move_event') requireThat(target.kind === 'event' || target.kind === 'work', 'WRONG_KIND', 'Это задача со сроком. Нужно изменить срок сдачи или время работы?');
        if (name === 'complete_task' || name === 'plan_work') requireThat(target.kind === 'task', 'WRONG_KIND', 'Для этого действия нужна задача.');
      }
      let date = null, field = null;
      if (name === 'create_task' && args.due_text) field = 'due_text';
      if (name === 'change_deadline') field = 'due_text';
      if (['create_event', 'move_event', 'plan_work'].includes(name)) field = 'when_text';
      if (field) {
        try {
          verifyDatePhrase(args[field], text);
          let phrase = args[field];
          const position = normalize(text).indexOf(normalize(phrase));
          if (position >= 0 && !/моск|мск/u.test(normalize(phrase))) {
            const zone = /^\s+(по\s+москве|мск)(?=\s|[,.!?]|$)/u.exec(normalize(text).slice(position + normalize(phrase).length));
            if (zone) phrase = `${phrase} ${zone[1]}`;
          }
          if (position >= 0 && !/\d{1,2}:\d{2}|(?:^|\s)в\s+\d/u.test(normalize(phrase))) {
            const rest = normalize(text).slice(position + normalize(phrase).length);
            const explicitClock = /^\s+(в\s+\d{1,2}(?::\d{2})?(?:\s+(?:по\s+москве|мск))?)(?=\s|[,.!?]|$)/u.exec(rest);
            if (explicitClock) phrase = `${phrase} ${explicitClock[1]}`;
          }
          let contextText=text;
          if(target&&['move_event','change_deadline'].includes(name)){
            const targetDay=target.at?dayAt(target.at,user.timezone):target.day,part=/вечер|утр|ноч[ьи]|днем|обед/iu.test(phrase);
            try{const explicit=resolveDate(phrase,{now:referenceAt,timezone:user.timezone,allowPast:true});if(!explicit.at&&target.at&&!part)contextText+='\nПрежнее время выбранного дела: в '+new Intl.DateTimeFormat('en',{timeZone:user.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(target.at));}
            catch(error){if(error.code==='DATE_MISSING'&&targetDay){try{const probe=resolveDate(phrase,{now:referenceAt,timezone:user.timezone,contextText:targetDay,allowPast:true});if(probe.at||part)contextText+='\nПрежний день выбранного дела: '+targetDay;}catch{}}}
          }
          date = resolveDate(phrase, { now: referenceAt, timezone: user.timezone, requireTime: field === 'when_text'&&!target?.all_day, contextText, defaultToday: field === 'when_text' });
          requireThat(!date.at || date.at > this.clock(), 'DATE_IN_PAST', 'Это время уже прошло. Укажи новую дату.');
        } catch (error) { error.details = { ...error.details, index, field }; throw error; }
      }
      if (name === 'create_task' && !args.due_text && /(?:к|до)\s+\d{1,2}\s+[а-я]+/iu.test(text)) throw new BobError('EXPLICIT_DEADLINE_MISSING', 'В сообщении указан срок; его нужно сохранить.');
      const duration = durationFromText(text);
      if (name === 'plan_work') requireThat(Number.isInteger(duration) && duration > 0 && duration <= 1440, 'DURATION_MISSING', 'Сколько времени выделить на работу? Например: «на час» или «на 45 минут».');
      if (duration !== null) requireThat(duration > 0 && duration <= 1440, 'DURATION_RANGE', 'Длительность должна быть от 1 до 1440 минут.');
      if (date?.at && ['create_event', 'move_event', 'plan_work'].includes(name)) {
        const start = Date.parse(date.at), end = start + (duration ?? target?.duration ?? 1) * 60000;
        const busy = items.filter(item => item.id !== target?.id && item.kind !== 'task' && item.at);
        requireThat(!busy.some(item => start < Date.parse(item.at) + (item.duration ?? 1) * 60000 && end > Date.parse(item.at)), 'TIME_CONFLICT', 'На это время уже есть дело. Укажи другое время.');
        if (name === 'plan_work') {
          requireThat(!busy.some(item => item.day === date.day && item.duration === null && Date.parse(item.at) < end), 'BUSY_DURATION_UNKNOWN', 'На этот день есть занятие с неизвестной длительностью. Сначала уточни его длительность.');
          requireThat(!target.at || end <= Date.parse(target.at), 'AFTER_DEADLINE', 'Работа закончится после срока сдачи. Выбери более раннее время.');
        }
        requireThat(!intervals.some(([from, to]) => start < to && end > from), 'BATCH_CONFLICT', 'Новые интервалы накладываются друг на друга.');
        intervals.push([start, end]);
      }
      const minutes = reminderFromText(text, target ? target.reminder_minutes : user.reminder_minutes);
      if (name.startsWith('create_') || name === 'plan_work') {
        const kind = name === 'create_task' ? 'task' : name === 'plan_work' ? 'work' : 'event';
        const title = name === 'plan_work' ? `Работа: ${target.title}` : args.title.trim();
        prepared.push({ kind: 'create', item: { id: `${kind}-${randomUUID().slice(0, 8)}`, owner, kind, title, day: date?.day ?? null, at: date?.at ?? null, approximate:date?.approximate??false, duration: kind === 'task' ? null : duration, parent_id: name === 'plan_work' ? target.id : null }, reminderMinutes: minutes });
      } else if (['change_deadline', 'move_event'].includes(name)) prepared.push({ kind: 'change', target, changes: { day: date.day, at: date.at, approximate:date.approximate, ...(name === 'move_event' && duration !== null ? { duration } : {}) }, reminderMinutes: minutes });
      else if (['complete_task', 'cancel_item'].includes(name)) prepared.push({ kind: 'change', target, changes: { status: name === 'complete_task' ? 'completed' : 'cancelled' } });
    }
    return prepared;
  }
  async run(owner, text, { requestId = randomUUID(), source = 'user',requestText,applicationCalls } = {}) {
    requireThat(typeof text === 'string' && text.trim().length > 0 && text.length <= 8000, 'INVALID_TEXT', 'Сообщение должно содержать от 1 до 8000 символов.');
    if (source !== 'user') return { status: 'material', text: 'Материал не является командой пользователя. Записи не изменены.', changed: 0 };
    this.store.ensureUser(owner);
    const claim = this.store.beginTurn(owner, requestId, requestText??text, this.clock());
    if (claim.cached) return { ...claim.cached, replayed: true };
    text = cleanUserText(text);
    let user = this.store.user(owner), modelCalls = 0;const deadline=Date.now()+this.timeBudgetMs;
    const commit = (response, mutate) => this.store.finishTurn(owner, requestId, claim.lease, user.revision, text, { modelCalls, ...response }, mutate);
    try {
      const command = /^\/(today|week|ahead|tasks)$/i.exec(text.trim());
      if (command) return commit({ status: 'ok', text: overview(this.store, owner, command[1] === 'tasks' ? 'all' : command[1], this.clock()), changed: 0 });
      const search = /^\/find\s+(.+)$/iu.exec(text.trim());
      if (search) {
        const query = normalize(search[1]);
        const found = this.store.items(owner).filter(item => normalize(item.title).includes(query) || normalize(item.id).includes(query));
        return commit({ status: 'ok', text: found.length ? found.map(item => `${item.title} — ${item.day ? formatDate(item.day, item.at, user.timezone,item.approximate) : 'без срока'} [${item.id}]`).join('\n') : 'Подходящих открытых дел нет.', changed: 0 });
      }
      if (/^\/(?:cancel|отмена)$/i.test(text.trim())) return commit({ status: 'ok', text: 'Уточнение отменено. Дела не изменены.', changed: 0, pending: null });
      const conversational=conversationIntent(text,user.pending);
      if(conversational){const fast=fastConversation(text,{now:this.clock(),timezone:user.timezone});if(fast!==null)return commit({status:'ok',text:fast,changed:0});}
      let pending = ['date','target','question'].includes(user.pending?.kind)?user.pending:null;
      if(conversational)pending=null;
      if(applicationCalls)pending=null;
      if (pending && (pending.expiresAt <= this.clock() || isNewRequest(text))) pending = null;
      const effectiveText = pending ? `${pending.originalText}\nУточнение: ${text}` : text;
      const referenceAt = pending?.referenceAt ?? this.clock();
      let calls = applicationCalls??null;
      if (pending?.kind === 'date') {
        calls = structuredClone(pending.calls);
        const args = calls[pending.index].args;
        args[pending.field] = text;
      } else if (pending?.kind === 'target') {
        const number = /^\s*(\d+)\s*$/.exec(text);
        const choices = pending.candidates.filter(candidate => this.store.item(owner, candidate.id)?.status === 'open');
        let chosen = number ? choices[Number(number[1]) - 1] : null;
        if (!chosen) {
          const matches = choices.filter(candidate => normalize(candidate.title).includes(normalize(text)) || normalize(text).includes(candidate.id));
          if (matches.length === 1) chosen = matches[0];
        }
        if (chosen) {
          calls = structuredClone(pending.calls);
          calls[pending.index].args.target_id = chosen.id;
          // An explicit choice in the displayed list is application evidence.
          pending.selectedId = chosen.id;
        }
      }
      let lastError = null, usage = [];
      for (let attempt = 0; attempt < this.maxCalls; attempt++) {
        if (!calls) {
          requireThat(this.provider, 'AI_OFFLINE', 'ИИ не подключён. Доступны /today, /week, /ahead и /tasks.');
          const context = conversational?{now:this.clock(),timezone:user.timezone}:modelContext(this.store,owner,effectiveText,this.clock());
          const remaining=deadline-Date.now();requireThat(remaining>=500,'AI_TIMEOUT','ИИ не успел ответить. Попробуй ещё раз; дела не изменены.');
          modelCalls++;
          const generated = await this.provider.complete({ context, text: effectiveText, feedback: lastError,timeoutMs:remaining,conversation:conversational });
          if (generated.usage) usage.push(generated.usage);
          try { calls = decodeCalls(generated.message); }
          catch (error) { lastError = error; if (attempt + 1 < this.maxCalls) continue; throw error; }
        }
        try {
          const sourceText = pending?.selectedId ? `${effectiveText}\nВыбрано: ${pending.selectedId}` : effectiveText;
          if(conversational)requireThat(calls.length===1&&['reply_user','ask_user'].includes(calls[0].name),'CONVERSATION_ONLY','Этот вопрос не разрешает просматривать или менять дела. Ответь через reply_user.');
          const prepared = this.prepare(owner, calls, sourceText, user, referenceAt);
          if(prepared[0]?.kind==='answer')return commit({status:'ok',text:prepared[0].text,changed:0,usage});
          if(conversational&&prepared[0]?.kind==='question')return commit({status:'clarify',text:prepared[0].question,changed:0,usage});
          if (prepared[0]?.kind === 'question') return commit({ status: 'clarify', text: prepared[0].question, changed: 0, usage, pending: { kind: 'question', originalText: effectiveText, referenceAt, expiresAt: new Date(Date.parse(this.clock()) + 86400000).toISOString() } });
          const changes = prepared.filter(action => action.kind !== 'read');
          const lines = prepared.map(action => action.kind === 'read' ? overview(this.store, owner, action.scope, this.clock()) : action.kind === 'create' ? `Добавил: ${action.item.title}${action.item.day ? ` — ${formatDate(action.item.day, action.item.at, user.timezone,action.item.approximate)}` : ' — без срока'} [${action.item.id}]` : action.changes.status ? `${action.changes.status === 'completed' ? 'Выполнено' : 'Отменено'}: ${action.target.title}` : `Перенёс: ${action.target.title} — ${formatDate(action.changes.day, action.changes.at, user.timezone,action.changes.approximate)}`);
          const focusId = changes.length === 1 ? changes[0].kind === 'create' ? changes[0].item.id : changes[0].target.id : user.focus_id;
          return commit({ status: 'ok', text: lines.join('\n'), changed: changes.length, focusId, pending: null, usage }, () => {
            for (const action of changes) {
              if (action.kind === 'create') this.store.putItem(action.item, this.clock(), action.reminderMinutes);
              else {
                this.store.changeItem(owner, action.target.id, action.changes, this.clock(), action.reminderMinutes);
                if (action.changes.status) for (const child of this.store.items(owner).filter(item => item.parent_id === action.target.id)) this.store.changeItem(owner, child.id, { status: 'cancelled' }, this.clock());
              }
            }
          });
        } catch (error) {
          if (!(error instanceof BobError)) throw error;
          const expiresAt = new Date(Date.parse(this.clock()) + 86400000).toISOString();
          if (error.details?.field) return commit({ status: 'clarify', text: error.message, changed: 0, usage, pending: { kind: 'date', originalText: effectiveText, referenceAt, calls, index: error.details.index, field: error.details.field, append: Boolean(error.details.append), expiresAt } });
          if (['TARGET_AMBIGUOUS', 'TARGET_MISMATCH'].includes(error.code)) {
            const candidates = error.details.candidates ?? [];
            return commit({ status: 'clarify', text: `${error.message}\n${candidates.map((item, index) => `${index + 1}. ${item.title} [${item.id}]`).join('\n')}`, changed: 0, usage, pending: { kind: 'target', originalText: effectiveText, referenceAt, calls, index: error.details.index, candidates, expiresAt } });
          }
          if (['DEADLINE_PERMISSION', 'DURATION_MISSING', 'BUSY_DURATION_UNKNOWN', 'TIME_CONFLICT', 'BATCH_CONFLICT', 'AFTER_DEADLINE', 'WRONG_KIND', 'REPEAT_UNSUPPORTED'].includes(error.code)) return commit({ status: 'clarify', text: error.message, changed: 0, usage, pending: { kind: 'question', originalText: effectiveText, referenceAt, expiresAt } });
          lastError = error; calls = null;
          if (attempt + 1 >= this.maxCalls) throw error;
        }
      }
      throw lastError ?? new BobError('NO_ACTION', 'Не удалось определить действие. Уточни запрос.');
    } catch (error) {
      if (!(error instanceof BobError)) throw error;
      user = this.store.user(owner);
      return commit({ status: 'error', code: error.code, text: `${error.message}\nЗаписи не изменены.`, changed: 0 });
    }
  }
}
