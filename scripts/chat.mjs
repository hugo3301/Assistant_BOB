import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { Store } from '../src/store.mjs';
import { Assistant } from '../src/assistant.mjs';
import { WorkersAI } from '../src/ai.mjs';
import { Alpha } from '../src/alpha.mjs';
const store = new Store(resolve('work/bob.sqlite'));
let provider = null;
if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) provider = new WorkersAI(store, { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
const assistant = new Alpha(store, new Assistant(store, { provider }));
const readline = createInterface({ input: stdin, output: stdout });
console.log('BOB — локальное диалоговое ядро. /today /week /ahead /tasks /find текст; /cancel отменяет уточнение, /exit завершает.');
console.log('Часовой пояс прототипа: Asia/Tomsk; утренняя отправка не включена. Telegram пока не подключён.');
try {
  while (true) {
    const text = (await readline.question('Ты: ')).trim();
    if (text === '/exit') break;
    if (!text) continue;
    try { const response = await assistant.handle('local', text, {requestId:crypto.randomUUID()}); console.log(`BOB: ${response.text}`); }
    catch { console.log('BOB: Не удалось обработать сообщение. Не считай действие выполненным; проверь /tasks.'); }
  }
} finally { readline.close(); store.close(); }
