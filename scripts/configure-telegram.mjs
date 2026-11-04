import { Telegram } from '../src/telegram.mjs';
const base = process.argv[2];
if (!/^https:\/\/assistant-bob-alpha\.[a-z0-9-]+\.workers\.dev$/.test(base ?? '')) throw Error('Supply the verified production workers.dev URL');
const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN);
const me = await telegram.call('getMe',{});
if (me.username !== 'mybob_robot') throw Error('Unexpected bot; configuration cancelled');
const response = await fetch(`${base}/health`), health = await response.json();
if (!response.ok || health.service !== 'BOB' || health.version !== '0.2.0-alpha') throw Error('Deployment is not ready');
const commands = [
  ['today','Сегодня и просроченное'],['week','Дела на ближайшие 7 дней'],['ahead','Общая картина: все сроки и дела без даты'],['tasks','Все открытые дела'],['find','Найти дело по названию'],['projects','Проекты и категории'],['project','Выбрать проект для новых дел'],['area','Выбрать категорию'],['repeat','Добавить еженедельные занятия'],['repeats','Список повторяющихся серий'],['diet','Сохранить или показать свой рацион'],['settings','Настройки сводки и напоминаний'],['morning','Время утренней сводки'],['ical','Выбрать группы из загруженного расписания'],['done','Завершить задачу по id'],['remove','Отменить дело по id'],['export','Скачать свои данные'],['status','Проверить состояние помощника'],['cancel','Отменить уточнение'],['help','Как пользоваться BOB'],
].map(([command,description])=>({command,description}));
for (const language_code of ['', 'ru']) {
  await telegram.call('setMyCommands',{commands,scope:{type:'chat',chat_id:Number(process.env.TELEGRAM_OWNER_ID)},language_code});
  await telegram.call('setMyDescription',{description:'BOB alpha — личный помощник: задачи, сроки, встречи, проекты и напоминания. Доступ только владельцу. Напиши /start, затем сообщение обычным текстом. ИИ: Cloudflare Workers AI.',language_code});
  await telegram.call('setMyShortDescription',{short_description:'Личный помощник BOB: дела, расписание и напоминания. Закрытая альфа.',language_code});
}
await telegram.call('setWebhook',{url:`${base}/telegram/webhook`,secret_token:process.env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false});
const hook = await telegram.call('getWebhookInfo',{});
console.log(JSON.stringify({bot:me.username,webhook:hook.url,pendingUpdates:hook.pending_update_count,commands:commands.length}));
