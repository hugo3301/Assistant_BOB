import { dayAt } from "./dates.mjs";

// Refresh only read-only period views. Receipts for mutations must never be replayed as new work.
export function refreshDelivery(ui, owner, payload, now) {
  const meta = payload.viewMeta;
  if (!meta || !["today", "tomorrow", "week"].includes(meta.filter?.scope))
    return { payload, changed: false };
  const user = ui.store.user(owner);
  if (
    meta.anchorDay === dayAt(now, user.timezone) &&
    meta.timezone === user.timezone
  )
    return { payload, changed: false };
  const view = ui.list(owner, meta.filter);
  return {
    changed: true,
    persist: view.persist,
    payload: {
      ...payload,
      text: view.text,
      entities: view.entities,
      replyMarkup: view.replyMarkup,
      viewMeta: view.viewMeta,
    },
  };
}
