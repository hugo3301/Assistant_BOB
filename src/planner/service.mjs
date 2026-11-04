import { requireThat } from "../errors.mjs";
import { plannerData } from "./model.mjs";

export class PlannerService {
  constructor(
    store,
    owner,
    ui,
    { enabled = () => true, clock = () => new Date().toISOString() } = {},
  ) {
    this.store = store;
    this.owner = owner;
    this.ui = ui;
    this.enabled = enabled;
    this.clock = clock;
    this.reads = [];
  }
  async http(request) {
    requireThat(
      this.enabled() && !this.ui.profile(this.owner)?.onboarding,
      "PLANNER_ACCESS",
      "Доступ к календарю отключён или ещё не выбран часовой пояс. Открой BOB.",
    );
    const now = this.clock(),
      cutoff = Date.parse(now) - 60000;
    this.reads = this.reads.filter((at) => at > cutoff);
    requireThat(
      this.reads.length < 30,
      "PLANNER_RATE",
      "Слишком много обновлений. Подожди минуту.",
    );
    this.reads.push(Date.parse(now));
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (new URL(request.url).pathname === "/planner/data")
      return Response.json(plannerData(this.store, this.owner, now), {
        headers,
      });
    const { id } = await request.json();
    requireThat(
      typeof id === "string" &&
        id.length <= 256 &&
        this.store.item(this.owner, id),
      "PLANNER_ITEM",
      "Дело недоступно. Обнови календарь.",
    );
    const snapshot = this.ui.snapshot(this.owner, { type: "planner", id });
    snapshot.persist();
    return Response.json(
      { url: "https://t.me/mybob_robot?start=p_" + snapshot.token },
      { headers },
    );
  }
}
