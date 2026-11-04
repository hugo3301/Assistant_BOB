import test from 'node:test';
import assert from 'node:assert/strict';
import { TestStore, action, decodePlan, validDate } from '../lib/guard.mjs';
import { ITEMS, CASES, EXPECTED_VALID_EVENT } from '../eval/cases.mjs';
import { decodeDomainPlan } from '../lib/domain-tools.mjs';

const now = '2026-11-04T09:00:00+07:00';
const plan = (...actions) => ({ status: 'ready', question: null, actions });
function withStore(fn) { const store = new TestStore(ITEMS); try { fn(store); } finally { store.close(); } }

test('valid event creates a saved reminder at the correct UTC time', () => withStore(store => {
  assert.equal(store.execute(EXPECTED_VALID_EVENT, { now }, 'event-1').writes, 1);
  assert.equal(store.snapshot().reminders[0].at, '2026-11-05T07:00:00.000Z');
}));
test('replaying a request does not duplicate events or reminders', () => withStore(store => {
  store.execute(EXPECTED_VALID_EVENT, { now }, 'event-1');
  const before = store.snapshot();
  assert.equal(store.execute(EXPECTED_VALID_EVENT, { now }, 'event-1').replayed, true);
  assert.deepEqual(store.snapshot(), before);
}));
test('unknown targets cannot be written', () => withStore(store => {
  assert.throws(() => store.execute(plan(action({ type: 'complete_task', target_id: 'L404' })), { now }, 'x'), /UNKNOWN_OR_FOREIGN/);
}));
test('an existing target owned by another user cannot be written', () => withStore(store => {
  const before = store.snapshot();
  assert.throws(() => store.execute(plan(action({ type: 'complete_task', target_id: 'PRIVATE' })), { now }, 'x'), /UNKNOWN_OR_FOREIGN/);
  assert.deepEqual(store.snapshot(), before);
}));
test('two unresolved candidates cannot be changed by a model guess', () => withStore(store => {
  assert.throws(() => store.execute(plan(action({ type: 'complete_task', target_id: 'L1' })), { now, policy: { candidateIds: ['L1', 'L2'] } }, 'x'), /AMBIGUOUS_TARGET/);
}));
test('a focused object cannot be replaced with another valid object', () => withStore(store => {
  assert.throws(() => store.execute(plan(action({ type: 'complete_task', target_id: 'L2' })), { now, policy: { resolvedId: 'L1' } }, 'x'), /WRONG_FOCUSED/);
}));
test('read-only requests reject otherwise valid completion instructions', () => withStore(store => {
  const before = store.snapshot();
  assert.throws(() => store.execute(plan(action({ type: 'complete_task', target_id: 'L1' })), { now, policy: { readOnly: true } }, 'x'), /READ_ONLY/);
  assert.deepEqual(store.snapshot(), before);
}));
test('a request to plan work cannot change a protected deadline', () => withStore(store => {
  assert.throws(() => store.execute(plan(action({ type: 'update_task', target_id: 'L1', due_at: '2026-11-12' })), { now }, 'x'), /DEADLINE_CHANGE/);
}));
test('an explicitly authorized deadline correction is accepted', () => withStore(store => {
  store.execute(plan(action({ type: 'update_task', target_id: 'L1', due_at: '2026-11-12' })), { now, policy: { allowDeadlineChange: true } }, 'x');
  assert.equal(store.snapshot().items.find(item => item.id === 'L1').due_at, '2026-11-12');
}));
test('multi-action plans are rejected atomically when a later target is invalid', () => withStore(store => {
  const before = store.snapshot();
  assert.throws(() => store.execute(plan(action(), action({ type: 'complete_task', target_id: 'L404' })), { now }, 'x'));
  assert.deepEqual(store.snapshot(), before);
}));
test('a database error during the second insertion rolls back the first insertion', () => withStore(store => {
  store.db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?)').run('x:1', 'test-user', 'task', 'Существующая', null, null, 0, null, null, null);
  const before = store.snapshot();
  assert.throws(() => store.execute(plan(action(), action()), { now }, 'x'), /UNIQUE/);
  assert.deepEqual(store.snapshot(), before);
}));
test('session duration must fit within availability', () => withStore(store => {
  const session = action({ type: 'plan_session', target_id: 'L1', starts_at: '2026-11-05T18:00:00+07:00', duration_minutes: 180 });
  assert.throws(() => store.execute(plan(session), { now, availability: [['2026-11-05T18:00:00+07:00', '2026-11-05T19:00:00+07:00']] }, 'x'), /OUTSIDE_AVAILABILITY/);
}));
test('events cannot overlap known busy intervals', () => withStore(store => {
  assert.throws(() => store.execute(EXPECTED_VALID_EVENT, { now, busy: [['2026-11-05T14:00:00+07:00', '2026-11-05T16:00:00+07:00']] }, 'x'), /TIME_CONFLICT/);
}));
test('invalid calendar dates are rejected instead of being normalized', () => {
  assert.equal(validDate('2027-02-30T15:00:00+07:00'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2027-02-29'), false);
  assert.equal(validDate('2026-11-05T15:00'), false);
});
test('two new events in one batch cannot overlap each other', () => withStore(store => {
  const before = store.snapshot();
  const event = action({ type: 'create_event', starts_at: '2026-11-05T15:00:00+07:00', duration_minutes: 60 });
  assert.throws(() => store.execute(plan(event, { ...event, starts_at: '2026-11-05T15:30:00+07:00' }), { now }, 'x'), /BATCH_TIME_CONFLICT/);
  assert.deepEqual(store.snapshot(), before);
}));
test('completing a task removes pending reminders for that task', () => withStore(store => {
  store.db.prepare('INSERT INTO reminders VALUES (?,?)').run('L1', '2026-11-06T00:00:00Z');
  store.execute(plan(action({ type: 'complete_task', target_id: 'L1' })), { now }, 'x');
  assert.equal(store.snapshot().reminders.length, 0);
}));
test('malformed output, unknown tools, and extra fields are rejected', () => {
  assert.throws(() => decodePlan({ choices: [{ message: { content: '```json\n{}\n```' } }] }, 'schema'));
  assert.throws(() => decodePlan({ tool_calls: [{ name: 'execute_sql', arguments: {} }] }, 'tools'), /UNKNOWN_TOOL/);
  assert.throws(() => decodePlan({ response: { ...EXPECTED_VALID_EVENT, sql: 'DROP TABLE items' } }, 'schema'), /SCHEMA_EXTRA/);
});
test('clarification cannot conceal writes', () => withStore(store => {
  assert.throws(() => store.execute({ status: 'clarify', question: 'Какую?', actions: [action()] }, { now }, 'x'), /NON_READY_HAS_ACTIONS/);
}));
test('a follow-up completion targets the focused task', () => withStore(store => {
  store.execute(plan(action({ type: 'complete_task', target_id: 'L1' })), { now, policy: { candidateIds: ['L1', 'L2'], resolvedId: 'L1' } }, 'x');
  assert.equal(store.snapshot().items.find(item => item.id === 'L1').completed, 1);
  assert.equal(store.snapshot().items.find(item => item.id === 'L2').completed, 0);
}));
test('the corpus contains at least twenty independent Russian-language cases', () => {
  assert.equal(CASES.length, 24);
  assert.equal(new Set(CASES.map(item => item.id)).size, CASES.length);
});
test('a date-only deadline cannot silently acquire an invented time', () => withStore(store => {
  assert.throws(() => store.execute(plan(action({ due_at: '2026-11-20T00:00:00+07:00' })), { now }, 'x'), /DEADLINE_TIME_NOT_CONFIRMED/);
  store.execute(plan(action({ due_at: '2026-11-20' })), { now }, 'date-only');
}));
test('domain tools map only declared arguments into actions', () => {
  const input = { choices: [{ message: { tool_calls: [{ function: { name: 'create_task', arguments: '{"title":"Купить бумагу"}' } }] } }] };
  const parsed = decodeDomainPlan(input);
  assert.equal(parsed.actions[0].type, 'create_task');
  assert.equal(parsed.actions[0].due_at, null);
  assert.equal(parsed.actions[0].starts_at, null);
});
test('a clarification cannot be combined with a domain mutation', () => {
  assert.throws(() => decodeDomainPlan({ tool_calls: [{ name: 'ask_user', arguments: { question: 'Какую?' } }, { name: 'complete_task', arguments: { target_id: 'L1' } }] }), /CLARIFICATION_MIXED/);
});
test('a weekly series explicitly starting tomorrow cannot begin on a guessed later day', () => withStore(store => {
  const context = { now, timezone: 'Asia/Tomsk', sourceText: 'Зал каждый четверг, начиная с завтрашнего дня.' };
  const event = action({ type: 'create_event', title: 'Зал', starts_at: '2026-11-10T18:00:00+07:00', recurrence: 'weekly' });
  assert.throws(() => store.execute(plan(event), context, 'bad'), /RELATIVE_START_MISMATCH/);
  store.execute(plan({ ...event, starts_at: '2026-11-05T18:00:00+07:00' }), context, 'good');
}));
test('a plainly stated deadline cannot be omitted from a new task', () => withStore(store => {
  const before = store.snapshot();
  const context = { now, sourceText: 'Добавь задачу: подготовить демо к 12 ноября. Время сдачи не указано.' };
  assert.throws(() => store.execute(plan(action({ title: 'Подготовить демо' })), context, 'missing'), /EXPLICIT_DEADLINE_MISSING/);
  assert.deepEqual(store.snapshot(), before);
  store.execute(plan(action({ title: 'Подготовить демо', due_at: '2026-11-12' })), context, 'correct');
}));
test('an explicit deadline cannot be replaced with a different day', () => withStore(store => {
  assert.throws(() => store.execute(plan(action({ due_at: '2026-11-13' })), { now, sourceText: 'Отчёт к 12 ноября' }, 'bad'), /EXPLICIT_DEADLINE_MISMATCH/);
}));
test('an explicitly named deadline time cannot disappear during an update', () => withStore(store => {
  const context = { now, sourceText: 'Преподаватель перенёс срок сдачи L1 на 12 ноября в 19:00.', policy: { allowDeadlineChange: true } };
  assert.throws(() => store.execute(plan(action({ type: 'update_task', target_id: 'L1', due_at: '2026-11-12' })), context, 'missing-time'), /EXPLICIT_DEADLINE_TIME_MISSING/);
  assert.throws(() => store.execute(plan(action({ type: 'update_task', target_id: 'L1', due_at: '2026-11-12T18:00:00+07:00' })), context, 'wrong-time'), /EXPLICIT_DEADLINE_TIME_MISMATCH/);
  store.execute(plan(action({ type: 'update_task', target_id: 'L1', due_at: '2026-11-12T19:00:00+07:00' })), context, 'right-time');
}));
