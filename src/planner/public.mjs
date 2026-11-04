import { BobError, requireThat } from "../errors.mjs";
import { callControl, callUser } from "../routing.mjs";
import { limitedText } from "../calendars/network.mjs";
import { APP_ORIGIN } from "../calendars/pages.mjs";
import { plannerOwner } from "./auth.mjs";
import { plannerPage } from "./page.mjs";

export async function plannerPublic(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/planner" && request.method === "GET") return plannerPage();
  if (!["/planner/data", "/planner/item"].includes(path))
    return new Response("Not found", { status: 404 });
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method !== "POST")
    return Response.json(
      { text: "Открой календарь кнопкой в BOB." },
      { status: 405, headers: { ...headers, Allow: "POST" } },
    );
  try {
    requireThat(
      request.headers.get("Origin") === APP_ORIGIN &&
        /^application\/json(?:;|$)/iu.test(
          request.headers.get("Content-Type") ?? "",
        ),
      "PLANNER_AUTH",
      "Открой календарь в Telegram.",
    );
    const raw = await limitedText(
      new Response(request.body, { headers: request.headers }),
      18000,
    );
    let data;
    try {
      data = JSON.parse(raw);
    } catch {}
    requireThat(
      data && typeof data === "object" && !Array.isArray(data),
      "PLANNER_AUTH",
      "Открой календарь в Telegram.",
    );
    const owner = plannerOwner(data.initData, env.TELEGRAM_BOT_TOKEN);
    const access = await callControl(env, "/access", { owner, start: false });
    requireThat(access.allowed, "PLANNER_ACCESS", "Доступ к альфе отключён.");
    return await callUser(env, owner, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(path.endsWith("/item") ? { id: data.id } : {}),
    });
  } catch (error) {
    return Response.json(
      {
        text:
          error instanceof BobError
            ? error.message
            : "Не удалось открыть план. Попробуй обновить.",
        code: error instanceof BobError ? error.code : "PLANNER_UNAVAILABLE",
      },
      {
        status:
          error?.code === "PLANNER_AUTH"
            ? 401
            : error?.code === "PLANNER_ACCESS"
              ? 403
              : error?.code === "PLANNER_RATE"
                ? 429
                : 400,
        headers,
      },
    );
  }
}
