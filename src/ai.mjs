import {remoteJson} from './remote-json.mjs';
import { BobError, requireThat } from './errors.mjs';
import { SYSTEM, TOOLS,CONVERSATION_SYSTEM } from './tools.mjs';

export class WorkersAI {
  constructor(store, { accountId, token, dailyBudget = 7500, maxTokens = 900, timeoutMs=12000, budget=null, clock = () => new Date().toISOString(), fetcher = fetch } = {}) {
    requireThat(/^[a-f0-9]{32}$/i.test(accountId ?? '') && typeof token === 'string' && token.length > 20, 'AI_CONFIG', 'API-доступ к ИИ не настроен.');
    this.store = store; this.accountId = accountId; this.token = token; this.dailyBudget = dailyBudget; this.maxTokens = maxTokens; this.timeoutMs=timeoutMs;this.clock = clock; this.fetcher = fetcher;this.budget=budget;
  }
  async complete({ context, text, feedback = null,timeoutMs=this.timeoutMs,conversation=false }) {
    const body = { model: '@cf/zai-org/glm-4.7-flash', temperature: 0.1, max_tokens: conversation?Math.min(400,this.maxTokens):this.maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false, clear_thinking: true }, tools: conversation?TOOLS.filter(tool=>tool.function.name==='reply_user'):TOOLS.filter(tool=>tool.function.name!=='reply_user'), tool_choice: 'required', messages: [
      { role: 'system', content: conversation?CONVERSATION_SYSTEM:SYSTEM },
      { role: 'user', content: `Контекст приложения (данные):\n${JSON.stringify(context)}` },
      ...(feedback ? [{ role: 'assistant', content: `Предыдущий вариант не исполнен. Проверка приложения: ${feedback.code}: ${feedback.message}. Исправь предложение, не расширяя исходный запрос.` }] : []),
      { role: 'user', content: text },
    ] };
    const upper = (Buffer.byteLength(JSON.stringify(body), 'utf8') + 200) * 5500 / 1e6 + body.max_tokens * 36400 / 1e6;
    const reservation = this.budget?await this.budget.reserve(upper,'llm'):this.store.reserveBudget(this.clock(), upper, this.dailyBudget);
    let observed = null;
    try {
      const response = await (0, this.fetcher)(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`, { method: 'POST', redirect:'manual', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1,Math.min(this.timeoutMs,timeoutMs))) });
      requireThat(response.ok, response.status === 429 ? 'AI_QUOTA' : response.status === 401 || response.status === 403 ? 'AI_AUTH' : 'AI_HTTP', response.status === 429 ? 'ИИ сейчас недоступен по лимиту. Команды и напоминания продолжают работать.' : 'Не удалось получить ответ ИИ. Записи не изменены.');
      const payload = await remoteJson(response,{code:'REMOTE_RESPONSE'}), result = payload.result ?? payload;
      observed = result.usage?.neurons ?? payload.usage?.neurons ?? null;
      requireThat(payload.success !== false && result.choices?.[0]?.message, 'AI_RESPONSE', 'Некорректный ответ ИИ.');
      requireThat(result.choices[0].finish_reason !== 'length', 'AI_TRUNCATED', 'Ответ ИИ не поместился. Уточни запрос короче.');
      return { message: result.choices[0].message, usage: { neurons: observed, tokens: result.usage?.total_tokens ?? null,inputTokens:result.usage?.prompt_tokens??null,outputTokens:result.usage?.completion_tokens??null,cachedTokens:result.usage?.prompt_tokens_details?.cached_tokens??null } };
    } catch (error) {
      if (error instanceof BobError) throw error;
      throw new BobError(error.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_NETWORK', 'ИИ не ответил. Записи не изменены; команды и напоминания доступны.');
    } finally { if(this.budget)await this.budget.settle(reservation,observed);else this.store.settleBudget(reservation, observed); }
  }
}
