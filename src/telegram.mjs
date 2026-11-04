import { BobError, requireThat } from './errors.mjs';
export function splitMessage(text, limit = 3500) {
  const result = []; let rest = String(text);
  while (rest.length > limit) { let end = rest.lastIndexOf('\n',limit); if (end < limit/2) end = limit; if (/^[\uDC00-\uDFFF]$/.test(rest[end])) end--; result.push(rest.slice(0,end)); rest = rest.slice(end); if (rest.startsWith('\n')) rest = rest.slice(1); }
  if (rest) result.push(rest); return result;
}
export function isOwnerUpdate(update, owner) {
  const callback=update?.callback_query,message=callback?.message??update?.message,sender=callback?.from??message?.from;
  return Number.isSafeInteger(update?.update_id) && message?.chat?.type === 'private' && String(sender?.id) === String(owner) && String(message?.chat?.id) === String(owner) && !sender?.is_bot && (!callback||(typeof callback.id==='string'&&typeof callback.data==='string'&&callback.data.length<=64&&Number.isSafeInteger(message.message_id)));
}
export class Telegram {
  constructor(token, {fetcher = fetch} = {}) { requireThat(/^\d+:[A-Za-z0-9_-]{30,}$/.test(token ?? ''),'TG_CONFIG','Telegram не настроен.'); this.token = token; this.fetcher = fetcher; }
  async call(method, data, multipart = false) {
    try {
      const response = await (0, this.fetcher)(`https://api.telegram.org/bot${this.token}/${method}`, {method:'POST', ...(multipart ? {body:data} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),signal:AbortSignal.timeout(15000)});
      const payload = await response.json();
      if (!response.ok || !payload.ok) { const error = new BobError('TG_API','Telegram временно не принял сообщение.'); error.retryAfter = Number(payload.parameters?.retry_after) || 0; error.unchanged=method==='editMessageText'&&/message is not modified/i.test(payload.description??'');error.editUnavailable=method==='editMessageText'&&/message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(payload.description??''); throw error; }
      return payload.result;
    } catch (error) { if (error instanceof BobError) throw error; throw new BobError('TG_NETWORK','Telegram не ответил.'); }
  }
  send(chat, text, replyMarkup) { return this.call('sendMessage',{chat_id:chat,text,link_preview_options:{is_disabled:true},reply_markup:replyMarkup??{keyboard:[[{text:'Сегодня'},{text:'Неделя'},{text:'Все дела'}],[{text:'Проекты'},{text:'Настройки'},{text:'Помощь'}]],resize_keyboard:true,is_persistent:true}}); }
  async edit(chat,message,text,replyMarkup){try{return await this.call('editMessageText',{chat_id:chat,message_id:message,text,reply_markup:replyMarkup,link_preview_options:{is_disabled:true}});}catch(error){if(error.unchanged)return;if(error.editUnavailable)return this.send(chat,text,replyMarkup);throw error;}}
  answer(id){return this.call('answerCallbackQuery',{callback_query_id:id});}
  typing(chat){return this.call('sendChatAction',{chat_id:chat,action:'typing'});}
  document(chat, file) { const form = new FormData(); form.set('chat_id',String(chat)); form.set('document',new Blob([file.text],{type:'application/json'}),file.name); return this.call('sendDocument',form,true); }
  async calendar(fileId) {
    const info = await this.call('getFile',{file_id:fileId});
    requireThat((info.file_size??0) <= 1000000 && /^[\w/.-]+$/.test(info.file_path ?? '') && !info.file_path.includes('..'),'ICAL_SIZE','Нужен .ics не больше 1 МБ.');
    try {
      const response = await (0, this.fetcher)(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`,{signal:AbortSignal.timeout(15000)});
      requireThat(response.ok,'ICAL_DOWNLOAD','Не удалось скачать файл Telegram.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; requireThat(size <= 1000000,'ICAL_SIZE','Файл больше 1 МБ.'); chunks.push(chunk); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.length;}
      return new TextDecoder().decode(bytes);
    } catch (error) { if (error instanceof BobError) throw error; throw new BobError('ICAL_DOWNLOAD','Не удалось скачать файл Telegram.'); }
  }
}
