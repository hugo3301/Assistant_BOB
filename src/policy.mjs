import { BobError, requireThat } from './errors.mjs';
import { normalize } from './dates.mjs';

const STOP = new Set(['по', 'на', 'в', 'и', 'с', 'к', 'до', 'ее', 'его', 'эту', 'этот', 'это', 'уже', 'мне', 'я', 'задачу', 'дело', 'нужно', 'надо', 'сдал', 'готово', 'выполнено', 'перенеси', 'отметь', 'отмени', 'сдачу', 'срок', 'дедлайн', 'завтра', 'сегодня']);
function tokens(text) { return (normalize(text).match(/[а-яa-z0-9]+/g) ?? []).filter(word => word.length >= 3 && !STOP.has(word)); }
export function selectTarget(text, items, focusId, proposedId = null) {
  const source = normalize(text);
  const explicit = items.filter(item => source.includes(item.id));
  let candidates = explicit.length > 1 && proposedId && explicit.some(item => item.id === proposedId) ? explicit.filter(item => item.id === proposedId) : explicit;
  const completion = source.replace(/[,.!—-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!candidates.length && focusId && /^(?:все\s+)?(?:готово|сделал|сдал|выполнено)(?:\s+отметь\s+выполненн[а-я]*)?$/u.test(completion)) candidates = items.filter(item => item.id === focusId);
  if (!candidates.length && /(?:^|\s)(ее|его|эту|этот|это|этой|нему|ней)(?:\s|[,.!?]|$)/u.test(source) && focusId) candidates = items.filter(item => item.id === focusId);
  if (!candidates.length) {
    const words = tokens(text);
    const ranked = items.map(item => {
      const titleWords = tokens(item.title);
      const exact = source.includes(normalize(item.title)) ? 100 : 0;
      return { item, score: exact + words.filter(word => titleWords.some(other => word === other || (word.length >= 3 && other.startsWith(word.slice(0, 3))))).length };
    });
    const highest = Math.max(0, ...ranked.map(entry => entry.score));
    if (highest) candidates = ranked.filter(entry => entry.score === highest).map(entry => entry.item);
  }
  if (candidates.length !== 1) throw new BobError('TARGET_AMBIGUOUS', candidates.length ? 'Какое именно дело?' : 'Какое дело нужно изменить? Укажи название или id.', { candidates: (candidates.length ? candidates : items).slice(0, 8).map(item => ({ id: item.id, title: item.title })) });
  requireThat(!proposedId || candidates[0].id === proposedId, 'TARGET_MISMATCH', 'Модель выбрала другое дело. Укажи нужное название или id.', { candidates: candidates.map(item => ({ id: item.id, title: item.title })) });
  return candidates[0];
}
export function allowDeadlineChange(text) {
  const source = normalize(text);
  if (/(?:не\s+(?:мен|перен)[а-я]*.{0,25}(?:срок|сдач|дедлайн)|(?:срок|сдач|дедлайн).{0,25}не\s+(?:мен|перен))/u.test(source)) return false;
  return /срок|сдач|дедлайн/u.test(source) && /перен|измен|обнов|исправ/u.test(source);
}
export const isReadRequest = text => /^\s*(?:\/today|\/week|\/ahead|\/tasks|покажи|список|какие\s+(?:дела|задачи|пары)|что\s+у\s+меня)/iu.test(text);
export const isNewRequest = text => /^\s*(?:\/|добав|создай|запиши|покажи|отмет|отмени|заплан)/iu.test(text);

export function validatePermission(name, text) {
  const source = normalize(text);
  if(!['list_items','ask_user'].includes(name))requireThat(!/^\s*(?:как\s|если\s|что будет|можно ли)/u.test(source),'QUESTION_ONLY','Это вопрос о действии. Если хочешь изменить дела, напиши просьбу напрямую.');
  if (isReadRequest(text)) requireThat(name.startsWith('list_') || name === 'ask_user', 'READ_ONLY', 'Запрос на просмотр не разрешает изменять дела.');
  if (name === 'complete_task') requireThat(!/не\s+(?:сдал|сделал|готов|выполн|заверш|законч|отмеч|отмет)/u.test(source), 'COMPLETE_NOT_REQUESTED', 'В сообщении есть отрицание выполнения. Уточни, нужно ли закрыть дело.');
  if (name === 'cancel_item') requireThat(!/не\s+(?:(?:надо|нужно|хочу)\s+)?(?:отмен|удал|убир)/u.test(source), 'CANCEL_NOT_REQUESTED', 'В сообщении есть запрет отмены. Дело оставлено.');
  if(name==='cancel_item')requireThat(!/(?:^|\s)все(?:х)?(?:\s|[,.!?]|$)/u.test(source),'BULK_SCOPE','Чтобы убрать несколько дел, уточни: все дела, все задачи или все пары. Я покажу количество и спрошу подтверждение.');
  if (name === 'complete_task') requireThat(/сдал|сделал|готово|выполн|заверш|законч|отмет/iu.test(text), 'COMPLETE_NOT_REQUESTED', 'Ты не просил отмечать дело выполненным.');
  if (name === 'cancel_item') requireThat(/отмен|удал|не\s+нуж[а-я]*|убери/iu.test(text), 'CANCEL_NOT_REQUESTED', 'Ты не просил отменять дело.');
}
