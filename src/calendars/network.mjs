import { BobError, requireThat } from "../errors.mjs";
export async function limitedText(response, limit = 2000000) {
  requireThat(
    Number(response.headers.get("content-length") ?? 0) <= limit,
    "CALENDAR_SIZE",
    "Календарь слишком большой для альфы. Подключи отдельный календарь.",
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    requireThat(
      size <= limit,
      "CALENDAR_SIZE",
      "Календарь слишком большой для альфы.",
    );
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
export async function request(fetcher, url, options = {}) {
  try {
    return await (0, fetcher)(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new BobError(
      "CALENDAR_NETWORK",
      "Не удалось связаться с календарём. Повторю позже; сохранённые дела остаются доступны.",
    );
  }
}
export function accepted(response, allowed = []) {
  if (response.ok || allowed.includes(response.status)) return;
  const code = [401, 403].includes(response.status)
    ? "CALENDAR_AUTH"
    : response.status === 412 || response.status === 409
      ? "CALENDAR_CONFLICT"
      : response.status === 429
        ? "CALENDAR_QUOTA"
        : "CALENDAR_HTTP";
  throw new BobError(
    code,
    code === "CALENDAR_AUTH"
      ? "Календарь не разрешил доступ. Проверь подключение."
      : code === "CALENDAR_CONFLICT"
        ? "Событие уже изменилось в календаре. Нужно сверить версии."
        : "Календарь временно недоступен. Повторю позже.",
  );
}
