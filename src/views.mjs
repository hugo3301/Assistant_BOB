import {selectItems,renderList} from './view-renderer.mjs';
export * from './view-renderer.mjs';
export function overview(store,owner,scope,now){return renderList(selectItems(store,owner,scope,now),{scope,now,timezone:store.user(owner).timezone}).text;}
