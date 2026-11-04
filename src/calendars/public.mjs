import { BobError, requireThat } from "../errors.mjs";
import { callUser, callControl } from "../routing.mjs";
import { readTicket } from "./security.mjs";
import { errorPage } from "./pages.mjs";
import { limitedText } from "./network.mjs";
export async function calendarPublic(request, env) {
  const url = new URL(request.url),
    path = url.pathname;
  if (
    ![
      "/calendars/connect",
      "/calendars/google/start",
      "/calendars/google/callback",
      "/calendars/yandex",
      "/calendars/select",
    ].includes(path)
  )
    return new Response("Not found", { status: 404 });
  try {
    let raw = "",
      ticket;
    if (request.method === "POST") {
      requireThat(
        /^application\/x-www-form-urlencoded(?:;|$)/iu.test(
          request.headers.get("content-type") ?? "",
        ),
        "CALENDAR_BROWSER",
        "Открой подключение через BOB.",
      );
      raw = await limitedText(
        new Response(request.body, { headers: request.headers }),
        16000,
      );
      ticket = new URLSearchParams(raw).get("ticket");
    } else
      ticket = url.searchParams.get(
        path === "/calendars/google/callback" ? "state" : "ticket",
      );
    const data = readTicket(
        env.CALENDAR_SECRET_KEY,
        ticket,
        new Date().toISOString(),
      ),
      access = await callControl(env, "/access", {
        owner: data.owner,
        start: false,
      });
    requireThat(access.allowed, "CALENDAR_ACCESS", "Доступ к альфе отключён.");
    return await callUser(env, data.owner, "/calendars/http" + url.search, {
      method: request.method,
      headers: {
        "x-calendar-path": path,
        "Content-Type": request.headers.get("content-type") ?? "",
        Origin: request.headers.get("origin") ?? "",
        Cookie: request.headers.get("cookie") ?? "",
      },
      ...(request.method === "POST" ? { body: raw } : {}),
    });
  } catch (error) {
    return errorPage(
      error instanceof BobError
        ? error.message
        : "Не удалось открыть подключение. Открой новую ссылку из BOB.",
    );
  }
}
