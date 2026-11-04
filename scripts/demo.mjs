import { Store } from '../src/store.mjs';
import { Assistant } from '../src/assistant.mjs';
import { ReminderWorker } from '../src/reminders.mjs';
const call = (name, args) => ({ message: { tool_calls: [{ id: 'demo', function: { name, arguments: JSON.stringify(args) } }] } });
let now = '2026-11-04T02:00:00.000Z', index = 0;
const provider = { async complete({ context }) { return index++ === 0 ? call('create_event', { title: 'Встреча по проекту', when_text: 'завтра в 15:00' }) : call('move_event', { target_id: context.focus_id, when_text: 'завтра в 16:00' }); } };
const store = new Store(), bot = new Assistant(store, { provider, clock: () => now });
try {
  for (const text of ['Добавь встречу по проекту завтра в 15:00, напомни за час.', 'Перенеси её на завтра в 16:00.', '/week']) {
    console.log(`Ты: ${text}`); console.log(`BOB: ${(await bot.handle('local', text)).text}`);
  }
  now = '2026-11-05T08:00:00.000Z';
  const worker = new ReminderWorker(store, { clock: () => now });
  await worker.tick(async message => console.log(`Тестовая доставка, без Telegram: ${message.text}`));
  console.log(`Повторный тик: ${(await worker.tick(async () => { throw new Error('unexpected duplicate'); })).length} уведомлений.`);
} finally { store.close(); }
