import { BobError, requireThat } from './errors.mjs';
import { SYSTEM, TOOLS } from './tools.mjs';

export class WorkersAI {
  constructor(store, { accountId, token, dailyBudget = 7500, maxTokens = 1200, clock = () => new Date().toISOString(), fetcher = fetch } = {}) {
    requireThat(/^[a-f0-9]{32}$/i.test(accountId ?? '') && typeof token === 'string' && token.length > 20, 'AI_CONFIG', 'API-доступ к ИИ не настроен.');
    this.store = store; this.accountId = accountId; this.token = token; this.dailyBudget = dailyBudget; this.maxTokens = maxTokens; this.clock = clock; this.fetcher = fetcher;
  }
  async complete({ context, text, feedback = null }) {
    const body = { model: '@cf/zai-org/glm-4.7-flash', temperature: 0.1, max_tokens: this.maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false, clear_thinking: true }, tools: TOOLS, tool_choice: 'required', messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Контекст приложения (данные):\n${JSON.stringify(context)}` },
      ...(feedback ? [{ role: 'assistant', content: `Предыдущий вариант не исполнен. Проверка приложения: ${feedback.code}: ${feedback.message}. Исправь предложение, не расширяя исходный запрос.` }] : []),
      { role: 'user', content: text },
    ] };
    const upper = (Buffer.byteLength(JSON.stringify(body), 'utf8') + 200) * 5500 / 1e6 + this.maxTokens * 36400 / 1e6;
    const reservation = this.store.reserveBudget(this.clock(), upper, this.dailyBudget);
    let observed = null;
    try {
      const response = await (0, this.fetcher)(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
      requireThat(response.ok, response.status === 429 ? 'AI_QUOTA' : response.status === 401 || response.status === 403 ? 'AI_AUTH' : 'AI_HTTP', response.status === 429 ? 'ИИ сейчас недоступен по лимиту. Команды и напоминания продолжают работать.' : 'Не удалось получить ответ ИИ. Записи не изменены.');
      const payload = await response.json(), result = payload.result ?? payload;
      observed = result.usage?.neurons ?? payload.usage?.neurons ?? null;
      requireThat(payload.success !== false && result.choices?.[0]?.message, 'AI_RESPONSE', 'Некорректный ответ ИИ.');
      requireThat(result.choices[0].finish_reason !== 'length', 'AI_TRUNCATED', 'Ответ ИИ не поместился. Уточни запрос короче.');
      return { message: result.choices[0].message, usage: { neurons: observed, tokens: result.usage?.total_tokens ?? null } };
    } catch (error) {
      if (error instanceof BobError) throw error;
      throw new BobError(error.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_NETWORK', 'ИИ не ответил. Записи не изменены; команды и напоминания доступны.');
    } finally { this.store.settleBudget(reservation, observed); }
  }
}
