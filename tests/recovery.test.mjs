import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Assistant } from '../src/assistant.mjs';
import { ReminderWorker } from '../src/reminders.mjs';
import { resolveDate } from '../src/dates.mjs';
import { BobError } from '../src/errors.mjs';
const NOW = '2026-11-04T02:00:00.000Z';
const tool = (name, args) => ({ id: name, function: { name, arguments: JSON.stringify(args) } });
const provider = (...steps) => ({ calls: 0, async complete() { return { message: { tool_calls: steps[this.calls++] } }; } });
function add(store, item) { store.ensureUser('alice'); store.putItem({ owner: 'alice', kind: 'task', title: 'Демо', ...item }, NOW, 60); }
const bot = (store, ai, clock = () => NOW) => new Assistant(store, { provider: ai, allowedOwners: ['alice'], clock });

test('date parser rejects unknown modifiers, conflicting dates and hidden recurrence', async () => {
  for (const text of ['средства', '12 мама', 'завтра через месяц', 'завтра послезавтра в 15:00', '12 ноября 14 ноября']) assert.throws(() => resolveDate(text, { now: NOW }));
  const store = new Store();
  try {
    const ai = provider([tool('create_event', { title: 'Зал', when_text: 'завтра в 15:00' })]);
    assert.equal((await bot(store, ai).handle('alice', 'Добавь зал завтра в 15:00 и каждую неделю.')).status, 'clarify');
    assert.equal(store.items('alice').length, 0);
  } finally { store.close(); }
});
test('late clarification survives restart and retains the original relative-date anchor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-pending-')), path = join(directory, 'db.sqlite');
  let store = new Store(path), now = '2026-11-04T16:50:00.000Z';
  try {
    await bot(store, provider([tool('create_event', { title: 'Встреча', when_text: 'завтра' })]), () => now).handle('alice', 'Добавь встречу завтра.', { requestId: 'one' });
    store.close(); store = new Store(path); now = '2026-11-04T17:10:00.000Z'; // midnight passed in Tomsk
    const result = await bot(store, null, () => now).handle('alice', 'в 15:00', { requestId: 'two' });
    assert.equal(result.changed, 1); assert.equal(result.modelCalls, 0);
    assert.equal(store.items('alice')[0].at, '2026-11-05T08:00:00.000Z');
    store.close(); store = new Store(path);
    const replay = await bot(store, null, () => now).handle('alice', 'в 15:00', { requestId: 'two' });
    assert.equal(replay.replayed, true); assert.equal(store.items('alice').length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('actual overlap and work beyond the deadline require clarification without partial writes', async () => {
  const store = new Store();
  try {
    add(store, { id: 'task-one', day: '2026-11-05', at: '2026-11-05T12:00:00.000Z' });
    add(store, { id: 'event-one', kind: 'event', title: 'Пары', day: '2026-11-05', at: '2026-11-05T08:00:00.000Z', duration: 90 });
    const ai = provider([tool('plan_work', { target_id: 'task-one', when_text: 'завтра в 15:30', duration_minutes: 60 })], [tool('plan_work', { target_id: 'task-one', when_text: 'завтра в 19:00', duration_minutes: 60 })]);
    const core = bot(store, ai);
    assert.equal((await core.handle('alice', 'Выдели на час работу над task-one завтра в 15:30.')).status, 'clarify');
    assert.equal((await core.handle('alice', 'Запланируй на час работу над task-one завтра в 19:00.')).status, 'clarify');
    assert.equal(store.items('alice').length, 2);
    assert.equal(store.item('alice', 'task-one').at, '2026-11-05T12:00:00.000Z');
  } finally { store.close(); }
});
test('explicit deadline protection and negated completion override model proposals', async () => {
  const store = new Store();
  try {
    add(store, { id: 'task-one', day: '2026-11-10' });
    const ai = provider([tool('change_deadline', { target_id: 'task-one', due_text: '12 ноября' })], [tool('complete_task', { target_id: 'task-one' })], [tool('complete_task', { target_id: 'task-one' })]);
    const core = bot(store, ai);
    assert.equal((await core.handle('alice', 'Перенеси работу над task-one на 12 ноября. Срок сдачи не меняй.')).changed, 0);
    assert.equal((await core.handle('alice', 'Отметь: task-one ещё не сделал.')).changed, 0);
    assert.equal(store.item('alice', 'task-one').day, '2026-11-10');
    assert.equal(store.item('alice', 'task-one').status, 'open');
    assert.equal(ai.calls, 3);
  } finally { store.close(); }
});
test('another process changing context during AI work prevents a stale write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-race-')), path = join(directory, 'db.sqlite');
  const store = new Store(path), other = new Store(path);
  try {
    add(store, { id: 'task-one' });
    const ai = { async complete() { other.settings('alice', { reminderMinutes: 120 }); return { message: { tool_calls: [tool('complete_task', { target_id: 'task-one' })] } }; } };
    const result = await bot(store, ai).handle('alice', 'Отметь task-one выполненной.');
    assert.equal(result.code, 'STALE_CONTEXT'); assert.equal(result.changed, 0);
    assert.equal(store.item('alice', 'task-one').status, 'open');
  } finally { store.close(); other.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('expired processing leases can be reclaimed but an old process cannot commit', () => {
  const store = new Store();
  try {
    store.ensureUser('alice');
    const old = store.beginTurn('alice', 'msg', 'Добавь дело', NOW);
    assert.throws(() => store.beginTurn('alice', 'msg', 'Добавь дело', NOW), error => error.code === 'TURN_BUSY');
    const next = store.beginTurn('alice', 'msg', 'Добавь дело', '2026-11-04T02:04:00.000Z');
    assert.throws(() => store.finishTurn('alice', 'msg', old.lease, 0, 'Добавь дело', {}), error => error.code === 'LEASE_LOST');
    store.finishTurn('alice', 'msg', next.lease, 0, 'Добавь дело', { text: 'ОК', changed: 0 });
    assert.equal(store.beginTurn('alice', 'msg', 'Добавь дело', NOW).cached.text, 'ОК');
  } finally { store.close(); }
});
test('expired and cancelled notifications skip; a claimed notification recovers after a crash', async () => {
  const store = new Store(); let now = NOW;
  try {
    add(store, { id: 'meeting', kind: 'event', day: '2026-11-04', at: '2026-11-04T03:00:00.000Z' });
    const worker = new ReminderWorker(store, { clock: () => now });
    worker.claim(now); // process died before delivery
    now = '2026-11-04T02:03:00.000Z';
    const sent = []; await worker.tick(async message => sent.push(message));
    assert.equal(sent.length, 1);
    add(store, { id: 'expired', kind: 'event', day: '2026-11-04', at: '2026-11-04T04:00:00.000Z' });
    add(store, { id: 'cancelled', kind: 'event', day: '2026-11-04', at: '2026-11-04T04:00:00.000Z' });
    store.changeItem('alice', 'cancelled', { status: 'cancelled' }, now);
    now = '2026-11-04T05:00:00.000Z';
    const result = await worker.tick(async message => sent.push(message));
    assert.equal(sent.length, 1); assert.equal(result[0].status, 'skipped');
  } finally { store.close(); }
});
test('AI quota errors cannot stop the independent reminder worker', async () => {
  const store = new Store();
  try {
    add(store, { id: 'meeting', kind: 'event', day: '2026-11-04', at: '2026-11-04T03:00:00.000Z' });
    const ai = { async complete() { throw new BobError('AI_QUOTA', 'Лимит'); } };
    assert.equal((await bot(store, ai).handle('alice', 'Добавь что-нибудь.')).code, 'AI_QUOTA');
    const sent = []; await new ReminderWorker(store, { clock: () => NOW }).tick(async message => sent.push(message));
    assert.equal(sent.length, 1);
  } finally { store.close(); }
});
test('a retried morning digest uses current tasks, including distant and undated obligations', async () => {
  const store = new Store(); let now = '2026-11-04T02:00:00.000Z';
  try {
    store.ensureUser('alice', { morningTime: '09:00' });
    const worker = new ReminderWorker(store, { clock: () => now });
    await worker.tick(async () => { throw Error('offline'); });
    add(store, { id: 'new', title: 'Новая срочная задача', day: '2026-11-04' });
    add(store, { id: 'far', title: 'Дальнее обязательство', day: '2028-01-10' });
    now = '2026-11-04T02:00:06.000Z';
    const sent = []; await worker.tick(async message => sent.push(message));
    assert.match(sent[0].text, /Новая срочная задача/);
    assert.match((await bot(store, null).handle('alice', '/ahead')).text, /Дальнее обязательство/);
  } finally { store.close(); }
});
test('a date-only task gains a reminder when an explicit time is added later', async () => {
  const store = new Store();
  try {
    const ai = provider([tool('create_task', { title: 'Демо', due_text: '12 ноября' })], [tool('change_deadline', { due_text: '12 ноября в 19:00' })]);
    const core = bot(store, ai);
    const created = await core.handle('alice', 'Добавь демо к 12 ноября.');
    assert.equal(store.pendingReminders('alice').length, 0);
    await core.handle('alice', 'Измени её срок сдачи на 12 ноября в 19:00.');
    assert.equal(store.item('alice', created.focusId).reminder_minutes, 60);
    assert.equal(store.pendingReminders('alice').filter(row => row.status === 'pending')[0].fire_at, '2026-11-12T11:00:00.000Z');
  } finally { store.close(); }
});
test('explicitly disabled reminders remain disabled when the event is moved', async () => {
  const store = new Store();
  try {
    const core = bot(store, provider([tool('create_event', { title: 'Встреча', when_text: 'завтра в 15:00' })], [tool('move_event', { when_text: 'завтра в 16:00' })]));
    await core.handle('alice', 'Добавь встречу завтра в 15:00, без напоминания.');
    await core.handle('alice', 'Перенеси её на завтра в 16:00.');
    assert.equal(store.pendingReminders('alice').length, 0);
  } finally { store.close(); }
});
test('offline search covers items beyond model context and never returns another owner', async () => {
  const store = new Store();
  try {
    for (let i = 0; i < 40; i++) add(store, { id: `task-${i}`, title: `Работа номер ${i}` });
    store.ensureUser('bob'); store.putItem({ id: 'foreign', owner: 'bob', kind: 'task', title: 'Работа номер 39 чужая' }, NOW, 60);
    const result = await bot(store, null).handle('alice', '/find номер 39');
    assert.match(result.text, /task-39/); assert.doesNotMatch(result.text, /чужая/); assert.equal(result.modelCalls, 0);
  } finally { store.close(); }
});
test('a timezone immediately after the model date phrase cannot silently disappear', async () => {
  const store = new Store();
  try {
    const core = bot(store, provider([tool('create_event', { title: 'Созвон', when_text: 'завтра в 15:00' })]));
    await core.handle('alice', 'Добавь созвон завтра в 15:00 по Москве.');
    assert.equal(store.items('alice')[0].at, '2026-11-05T12:00:00.000Z');
  } finally { store.close(); }
});
