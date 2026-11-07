import {requireThat} from './errors.mjs';
export const PRIVATE_INPUT_MESSAGE='Похоже, в сообщении есть пароль или ключ доступа. Я не буду сохранять его или передавать в ИИ. Удали секрет и пришли просьбу заново. Ключи подключений вводи только на специальных страницах настройки.';
const PATTERNS=[
 /\b(?:gsk_[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|cfut_[A-Za-z0-9_-]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|\d{8,12}:[A-Za-z0-9_-]{35})\b/gu,
 /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
 /(?:\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY)|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)|пароль|токен|секрет)\s*[=:]\s*["']?[A-Za-z0-9_+/.=-]{12,}["']?/giu,
];
export function configuredSecrets(env={}){return Object.entries(env).filter(([key,value])=>/(?:TOKEN|SECRET|KEY)$/u.test(key)&&typeof value==='string'&&value.length>=16).map(([,value])=>value);}
export function containsCredential(value,secrets=[]){const text=String(value??'');return secrets.some(secret=>text.includes(secret))||PATTERNS.some(pattern=>{pattern.lastIndex=0;return pattern.test(text);});}
export function redactCredentials(value,secrets=[]){let text=String(value??'');for(const secret of [...secrets].sort((a,b)=>b.length-a.length))text=text.replaceAll(secret,'[скрыто]');for(const pattern of PATTERNS){pattern.lastIndex=0;text=text.replace(pattern,'[скрыто]');}return text;}
export function assertPrivateInput(value,secrets=[]){requireThat(!containsCredential(value,secrets),'SENSITIVE_INPUT',PRIVATE_INPUT_MESSAGE);}
export function minimalUpdate(update,secrets=[]){
 const source=update.message??update.callback_query?.message;
 const message={message_id:source.message_id,chat:{id:source.chat.id,type:source.chat.type},from:{id:source.from?.id,is_bot:Boolean(source.from?.is_bot)}};
 if(update.callback_query)return {update_id:update.update_id,callback_query:{id:update.callback_query.id,data:update.callback_query.data,from:{id:update.callback_query.from.id,is_bot:Boolean(update.callback_query.from.is_bot)},message}};
 for(const field of ['text','caption'])if(typeof source[field]==='string')message[field]=source[field];
 for(const [kind,fields] of Object.entries({voice:['file_id','file_unique_id','duration','file_size'],document:['file_id','file_unique_id','file_name','mime_type','file_size']}))if(source[kind])message[kind]=Object.fromEntries(fields.filter(key=>source[kind][key]!==undefined).map(key=>[key,source[kind][key]]));
 if([message.text,message.caption,message.document?.file_name].some(value=>containsCredential(value,secrets))){delete message.voice;delete message.document;delete message.caption;message.text='/security-input-blocked';}
 return {update_id:update.update_id,message};
}
