import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { Assistant } from '../src/assistant.mjs';
import { WorkersAI } from '../src/ai.mjs';
import { ReminderWorker } from '../src/reminders.mjs';
const run = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const directory = resolve('work/core-validation', run);
mkdirSync(directory, { recursive: true });
const path = resolve(directory, 'state.sqlite');
let store, now = '2026-11-04T02:00:00.000Z';
const clock = () => now;
const entries = [], notifications = [];
function open() {
  store = new Store(path);
  const provider = new WorkersAI(store, { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, dailyBudget: 300, maxTokens: 1200, clock });
  return new Assistant(store, { provider, allowedOwners: ['validation'], clock });
}
try {
  let bot = open();
  for (const [index, text] of [
    'Добавь задачу: подготовить демонстрацию к 12 ноября. Время сдачи пока неизвестно.',
    'Перенеси её сдачу на 14 ноября.',
    'Её я сдал, отметь выполненной.',
    'Добавь встречу с научруком завтра в 15:00, напомни за час.',
    'Перенеси её на завтра в 16:00.',
    '/week',
  ].entries()) {
    const response = await bot.handle('validation', text, { requestId: `message-${index}` });
    entries.push({ text, response });
    console.log(JSON.stringify({ step: index + 1, status: response.status, changed: response.changed, modelCalls: response.modelCalls, text: response.text }));
    if (index === 0) { store.close(); bot = open(); }
  }
  now = '2026-11-05T08:00:00.000Z';
  const worker = new ReminderWorker(store, { clock });
  await worker.tick(async message => notifications.push(message));
  await worker.tick(async message => notifications.push(message));
  const result = { run, source: 'real Cloudflare GLM calls; synthetic data; local notification sink, not Telegram', entries, items: store.items('validation', { includeClosed: true }), reminders: store.pendingReminders('validation'), usage: store.usage('2026-11-04'), notifications };
  const tasks = result.items.filter(item => item.kind === 'task'), events = result.items.filter(item => item.kind === 'event');
  result.checks = {
    createdTask: tasks.length === 1,
    correctedTask: tasks.length === 1 && tasks[0].day === '2026-11-14',
    completedTask: tasks.length === 1 && tasks[0].status === 'completed',
    movedEvent: events.length === 1 && events[0].at === '2026-11-05T09:00:00.000Z',
    oneNotification: notifications.length === 1 && notifications[0].text.includes('16:00'),
    noAiForOverview: entries.at(-1).response.modelCalls === 0,
  };
  writeFileSync(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ checks: result.checks, usage: result.usage, directory }, null, 2));
  if (!Object.values(result.checks).every(Boolean)) process.exitCode = 1;
} finally { store?.close(); }
