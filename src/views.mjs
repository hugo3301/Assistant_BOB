import { dayAt, addDays, formatDate } from './dates.mjs';
export function overview(store, owner, scope, now) {
  const user = store.user(owner), today = dayAt(now, user.timezone);
  const end = scope === 'today' ? today : scope === 'week' ? addDays(today, 6) : '9999-12-31';
  const items = store.items(owner).filter(item => scope === 'all' || (!item.day ? scope === 'ahead' : item.day <= end));
  const labels = { today: 'Сегодня', week: 'Ближайшие 7 дней', ahead: 'Все известные сроки и дела без даты', all: 'Все открытые дела' };
  const lines = items.map(item => {
    const overdue = item.day && (item.at ? item.at < now : item.day < today);
    const date = item.day ? formatDate(item.day, item.at, user.timezone) : 'без срока';
    const group = item.project ? ` [проект: ${item.project}]` : item.area && item.area !== 'Личное' ? ` [${item.area}]` : '';
    return `${overdue ? 'Просрочено: ' : ''}${item.title}${group} — ${date} [${item.id}]`;
  });
  return `${labels[scope] ?? labels.all}:\n${lines.length ? lines.join('\n') : 'Дел пока нет.'}`;
}
