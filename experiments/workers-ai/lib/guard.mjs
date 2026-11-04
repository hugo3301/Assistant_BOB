import { DatabaseSync } from 'node:sqlite';

const nullable = type => ({ type: [type, 'null'] });
export const ACTION_TYPES = ['create_task', 'create_event', 'update_task', 'update_event', 'complete_task', 'list_tasks', 'list_events', 'plan_session'];
export const ACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    target_id: { ...nullable('string'), description: 'Существующий id для изменения, завершения или рабочего интервала. Для создания новой задачи/встречи null.' },
    title: { ...nullable('string'), description: 'Название нового дела; при неизменном названии существующего объекта null.' },
    starts_at: { ...nullable('string'), description: 'Начало события или работы, ISO 8601 с часовым поясом. Не время заблаговременного напоминания.' },
    due_at: { ...nullable('string'), description: 'Внешний срок сдачи. Дата без времени: YYYY-MM-DD. При планировании работы null.' },
    reminder_minutes: { ...nullable('integer'), minimum: 0, maximum: 43200, description: 'За сколько минут до события напомнить. Это свойство события; не создавай отдельное событие-напоминание.' },
    duration_minutes: { ...nullable('integer'), minimum: 1, maximum: 1440, description: 'Длительность, только если известна. Если не названа, null; не ставь 0.' },
    recurrence: { type: ['string', 'null'], enum: ['weekly', 'monthly', null] },
    project_id: nullable('string'),
  },
};
ACTION_SCHEMA.required = Object.keys(ACTION_SCHEMA.properties);
export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ready', 'clarify', 'infeasible'] },
    question: nullable('string'),
    actions: { type: 'array', maxItems: 5, items: ACTION_SCHEMA },
  }, required: ['status', 'question', 'actions'],
};
export const TOOL = {
  type: 'function', function: {
    name: 'submit_plan',
    description: 'Предложить проверяемый план действий BOB. Это единственный инструмент; уточнения и невозможность плана тоже передаются сюда. Сам вызов не означает успешную запись.',
    parameters: PLAN_SCHEMA,
  },
};
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function fail(code) { throw new Error(code); }
export function validateSchema(value, schema, path = '$') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && Number.isInteger(value) && types.includes('integer'))) fail(`SCHEMA_TYPE:${path}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`SCHEMA_ENUM:${path}`);
  if (actual === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail(`SCHEMA_RANGE:${path}`);
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`SCHEMA_REQUIRED:${path}.${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (!schema.properties?.[key]) fail(`SCHEMA_EXTRA:${path}.${key}`);
      validateSchema(child, schema.properties[key], `${path}.${key}`);
    }
  }
  if (actual === 'array') {
    if (value.length > (schema.maxItems ?? Infinity)) fail(`SCHEMA_SIZE:${path}`);
    value.forEach((child, index) => validateSchema(child, schema.items, `${path}[${index}]`));
  }
}

export function validDate(value, dateOnly = true) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || (!dateOnly && !match[4])) return false;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  if (match[4]) {
    if (+match[4] > 23 || +match[5] > 59 || +(match[6] ?? 0) > 59) return false;
    if (match[7] !== 'Z') {
      const [hours, minutes] = match[7].slice(1).split(':').map(Number);
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
    }
    return Number.isFinite(Date.parse(value));
  }
  return true;
}

export function decodePlan(payload, mode) {
  const result = payload.result ?? payload;
  if (result.choices?.[0]?.finish_reason === 'length') fail('TRUNCATED_RESPONSE');
  if (mode === 'tools') {
    const calls = result.choices?.[0]?.message?.tool_calls ?? result.tool_calls;
    if (!Array.isArray(calls) || calls.length !== 1) fail('EXPECTED_SINGLE_TOOL');
    const call = calls[0].function ?? calls[0];
    if (call.name !== 'submit_plan') fail('UNKNOWN_TOOL');
    const plan = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    validateSchema(plan, PLAN_SCHEMA);
    return plan;
  }
  const content = result.choices?.[0]?.message?.content ?? result.response;
  const plan = typeof content === 'string' ? JSON.parse(content) : content;
  validateSchema(plan, PLAN_SCHEMA);
  return plan;
}

export class TestStore {
  constructor(items = [], projects = ['P1']) {
    this.db = new DatabaseSync(':memory:');
    this.projects = new Set(projects);
    this.db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, owner TEXT, kind TEXT, title TEXT, starts_at TEXT, due_at TEXT, completed INTEGER, recurrence TEXT, project_id TEXT, duration_minutes INTEGER); CREATE TABLE receipts (request_id TEXT PRIMARY KEY, result TEXT); CREATE TABLE reminders (item_id TEXT, at TEXT);');
    const insert = this.db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const item of items) insert.run(item.id, item.owner ?? 'test-user', item.kind ?? 'task', item.title, item.starts_at ?? null, item.due_at ?? null, item.completed ?? 0, item.recurrence ?? null, item.project_id ?? null, item.duration_minutes ?? null);
  }
  snapshot() {
    return {
      items: this.db.prepare('SELECT * FROM items ORDER BY id').all(),
      reminders: this.db.prepare('SELECT * FROM reminders ORDER BY item_id,at').all(),
    };
  }
  close() { this.db.close(); }
  execute(plan, context, requestId) {
    validateSchema(plan, PLAN_SCHEMA);
    const previous = this.db.prepare('SELECT result FROM receipts WHERE request_id=?').get(requestId);
    if (previous) return { ...JSON.parse(previous.result), replayed: true };
    if (plan.status !== 'ready') {
      if (plan.actions.length) fail('NON_READY_HAS_ACTIONS');
      if (plan.status === 'clarify' && !plan.question?.trim()) fail('MISSING_QUESTION');
      return { writes: 0, status: plan.status };
    }
    if (plan.question !== null || !plan.actions.length) fail('READY_PLAN_INVALID');
    const policy = context.policy ?? {};
    const mutationTargets = new Set();
    const proposedIntervals = [];
    for (const action of plan.actions) {
      const readOnly = action.type.startsWith('list_');
      if (!readOnly && policy.readOnly) fail('READ_ONLY_CONTEXT');
      if (action.title !== null && (!action.title.trim() || action.title.length > 300)) fail('INVALID_TITLE');
      if (action.project_id !== null && !this.projects.has(action.project_id)) fail('UNKNOWN_PROJECT');
      if (action.due_at !== null && !validDate(action.due_at)) fail('INVALID_DUE_DATE');
      if (action.type === 'create_task' && action.due_at?.includes('T') && !policy.allowDeadlineTime) fail('DEADLINE_TIME_NOT_CONFIRMED');
      if (action.type === 'create_task' || (action.type === 'update_task' && policy.allowDeadlineChange)) {
        const pattern = new RegExp(`(?:^|\\s)(?:к|до|на)\\s+(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'giu');
        const anchors = [...String(context.sourceText ?? '').matchAll(pattern)];
        if (anchors.length === 1) {
          const anchor = anchors[0];
          if (!action.due_at) fail('EXPLICIT_DEADLINE_MISSING');
          const monthDay = `${String(MONTHS.indexOf(anchor[2].toLowerCase()) + 1).padStart(2, '0')}-${anchor[1].padStart(2, '0')}`;
          if (action.due_at.slice(5, 10) !== monthDay || (anchor[3] && !action.due_at.startsWith(anchor[3]))) fail('EXPLICIT_DEADLINE_MISMATCH');
          const following = String(context.sourceText).slice(anchor.index + anchor[0].length);
          const clock = /^\s*(?:в\s+)?(\d{1,2}):(\d{2})/iu.exec(following);
          if (clock) {
            if (!action.due_at.includes('T')) fail('EXPLICIT_DEADLINE_TIME_MISSING');
            const parts = new Intl.DateTimeFormat('en', { timeZone: context.timezone ?? 'Asia/Tomsk', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(action.due_at));
            const hour = Number(parts.find(part => part.type === 'hour').value);
            const minute = Number(parts.find(part => part.type === 'minute').value);
            if (hour !== Number(clock[1]) || minute !== Number(clock[2])) fail('EXPLICIT_DEADLINE_TIME_MISMATCH');
          }
        }
      }
      if (action.starts_at !== null && !validDate(action.starts_at, false)) fail('INVALID_START_DATE');
      if (action.reminder_minutes !== null && (action.reminder_minutes < 0 || action.reminder_minutes > 43200)) fail('INVALID_REMINDER');
      if (action.duration_minutes !== null && (action.duration_minutes <= 0 || action.duration_minutes > 1440)) fail('INVALID_DURATION');
      if (action.type.startsWith('create_') && (!action.title || action.target_id !== null)) fail('CREATE_FIELDS_INVALID');
      if (action.type === 'create_event' && action.starts_at === null) fail('EVENT_REQUIRES_START');
      const needsTarget = ['update_task', 'update_event', 'complete_task', 'plan_session'].includes(action.type);
      if (needsTarget) {
        const item = this.db.prepare('SELECT * FROM items WHERE id=? AND owner=?').get(action.target_id, 'test-user');
        if (!item) fail('UNKNOWN_OR_FOREIGN_TARGET');
        if ((policy.candidateIds?.length ?? 0) > 1 && !policy.resolvedId) fail('AMBIGUOUS_TARGET');
        if (policy.resolvedId && policy.resolvedId !== action.target_id) fail('WRONG_FOCUSED_TARGET');
        if (policy.candidateIds && !policy.candidateIds.includes(action.target_id)) fail('TARGET_OUT_OF_SCOPE');
        if (mutationTargets.has(action.target_id)) fail('DUPLICATE_MUTATION');
        mutationTargets.add(action.target_id);
        if (action.type === 'update_event' && item.kind !== 'event') fail('WRONG_TARGET_KIND');
        if (['update_task', 'complete_task', 'plan_session'].includes(action.type) && item.kind !== 'task') fail('WRONG_TARGET_KIND');
        if (action.due_at !== null && action.due_at !== item.due_at && !policy.allowDeadlineChange) fail('DEADLINE_CHANGE_NOT_AUTHORIZED');
        if (action.recurrence !== null && action.recurrence !== item.recurrence && !policy.allowSeriesChange) fail('SERIES_CHANGE_NOT_AUTHORIZED');
      }
      if (['update_event', 'plan_session'].includes(action.type) && !action.starts_at) fail('START_REQUIRED');
      if (action.type === 'plan_session' && (!action.duration_minutes || action.due_at !== null)) fail('SESSION_FIELDS_INVALID');
      if (['create_event', 'update_event', 'plan_session'].includes(action.type)) {
        const start = Date.parse(action.starts_at);
        const finish = start + (action.duration_minutes ?? 1) * 60000;
        // A small, explicit source-grounding rule, not a general Russian date
        // parser: a series explicitly starting tomorrow cannot start next week.
        if (/начиная\s+с\s+завтрашн/iu.test(context.sourceText ?? '')) {
          const dayInZone = value => {
            const parts = new Intl.DateTimeFormat('en', { timeZone: context.timezone ?? 'Asia/Tomsk', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
            const get = key => parts.find(part => part.type === key).value;
            return `${get('year')}-${get('month')}-${get('day')}`;
          };
          const [year, month, day] = dayInZone(context.now).split('-').map(Number);
          const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
          if (dayInZone(action.starts_at) !== tomorrow) fail('RELATIVE_START_MISMATCH');
        }
        if (start < Date.parse(context.now)) fail('START_IN_PAST');
        if (context.availability?.length && !context.availability.some(([from, to]) => start >= Date.parse(from) && finish <= Date.parse(to))) fail('OUTSIDE_AVAILABILITY');
        if ((context.busy ?? []).some(([from, to]) => start < Date.parse(to) && finish > Date.parse(from))) fail('TIME_CONFLICT');
        if (proposedIntervals.some(([from, to]) => start < to && finish > from)) fail('BATCH_TIME_CONFLICT');
        proposedIntervals.push([start, finish]);
        if (action.type === 'plan_session') {
          const target = this.db.prepare('SELECT due_at FROM items WHERE id=?').get(action.target_id);
          if (target.due_at?.includes('T') && finish > Date.parse(target.due_at)) fail('SESSION_AFTER_DEADLINE');
        }
      }
    }
    this.db.exec('BEGIN');
    try {
      let writes = 0;
      for (const [index, action] of plan.actions.entries()) {
        if (action.type.startsWith('list_')) continue;
        const id = action.type.startsWith('create_') || action.type === 'plan_session' ? `${requestId}:${index}` : action.target_id;
        if (action.type.startsWith('create_') || action.type === 'plan_session') {
          this.db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, 'test-user', action.type === 'create_task' ? 'task' : 'event', action.title ?? 'Работа над задачей', action.starts_at, action.type === 'plan_session' ? null : action.due_at, 0, action.recurrence, action.project_id, action.duration_minutes);
        } else if (action.type === 'complete_task') {
          this.db.prepare('UPDATE items SET completed=1 WHERE id=? AND owner=?').run(id, 'test-user');
          this.db.prepare('DELETE FROM reminders WHERE item_id=?').run(id);
        } else {
          this.db.prepare('UPDATE items SET title=COALESCE(?,title), starts_at=COALESCE(?,starts_at), due_at=COALESCE(?,due_at) WHERE id=? AND owner=?').run(action.title, action.starts_at, action.due_at, id, 'test-user');
          this.db.prepare('DELETE FROM reminders WHERE item_id=?').run(id);
        }
        if (action.starts_at && action.reminder_minutes !== null) this.db.prepare('INSERT INTO reminders VALUES (?,?)').run(id, new Date(Date.parse(action.starts_at) - action.reminder_minutes * 60000).toISOString());
        writes++;
      }
      const result = { status: 'ready', writes };
      this.db.prepare('INSERT INTO receipts VALUES (?,?)').run(requestId, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function action(overrides = {}) {
  return { type: 'create_task', target_id: null, title: 'Тестовая задача', starts_at: null, due_at: null, reminder_minutes: null, duration_minutes: null, recurrence: null, project_id: null, ...overrides };
}
