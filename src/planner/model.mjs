import { dayAt } from "../dates.mjs";
import { displayTitle } from "../view-renderer.mjs";
import { zoneLabel } from "../zones.mjs";

export function plannerData(store, owner, now = new Date().toISOString()) {
  const timezone = store.user(owner).timezone;
  const sources = new Map(
    store.db
      .prepare("SELECT id,provider FROM calendar_connections WHERE owner=?")
      .all(owner)
      .map((row) => [row.id, row.provider === "google" ? "Google" : "Яндекс"]),
  );
  const items = store
    .items(owner)
    .map((item) => ({
      id: item.id,
      title: displayTitle(item.title),
      kind: item.kind,
      day: item.at ? dayAt(item.at, timezone) : (item.day ?? null),
      at: item.at ?? null,
      duration: item.duration ?? null,
      all_day: Boolean(item.all_day),
      end_day: item.end_day ?? null,
      source_day: item.source_day ?? null,
      project: item.project ?? null,
      area: item.area ?? "Личное",
      approximate: Boolean(item.approximate),
      reminder_minutes: item.reminder_minutes,
      source:
        sources.get(item.calendar_connection_id) ??
        (item.source_key ? "Расписание .ics" : null),
    }))
    .sort(
      (a, b) =>
        (a.day ?? "9999").localeCompare(b.day ?? "9999") ||
        (a.at ?? "").localeCompare(b.at ?? "") ||
        a.title.localeCompare(b.title, "ru"),
    );
  const projects = store.db
    .prepare("SELECT name FROM projects WHERE owner=? ORDER BY name")
    .all(owner)
    .map((row) => row.name);
  return {
    now,
    timezone,
    zoneLabel: zoneLabel(timezone, now),
    today: dayAt(now, timezone),
    projects,
    items,
  };
}

// Shared by browser and tests: local day spans, column layout and conflict groups.
export function calendarGeometry(items, days, timezone) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = (instant) =>
    Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
  const local = (instant) => {
    const p = parts(instant);
    return {
      day: `${p.year}-${p.month}-${p.day}`,
      minute: Number(p.hour) * 60 + Number(p.minute),
    };
  };
  const plus = (day, n) =>
    new Date(Date.parse(day + "T12:00:00Z") + n * 86400000)
      .toISOString()
      .slice(0, 10);
  const prepared = items.map((item) => {
    if (!item.at) return { item };
    const start = local(item.at),
      known = item.kind !== "task" && Number(item.duration) > 0;
    return {
      item,
      start,
      known,
      finish: known
        ? local(
            new Date(
              Date.parse(item.at) + item.duration * 60000 - 1,
            ).toISOString(),
          )
        : start,
    };
  });
  return days.map((day) => {
    const floating = [],
      timed = [];
    for (const preparedItem of prepared) {
      const { item, start, known, finish } = preparedItem;
      if (!item.at) {
        let end = item.end_day;
        if (
          item.all_day &&
          end &&
          item.source_day &&
          item.day !== item.source_day
        )
          end = plus(
            item.day,
            Math.max(
              1,
              Math.round(
                (Date.parse(end) - Date.parse(item.source_day)) / 86400000,
              ),
            ),
          );
        if (item.day === day || (item.all_day && item.day <= day && end > day))
          floating.push(item);
        continue;
      }
      if (start.day > day || finish.day < day) continue;
      const from = start.day < day ? 0 : start.minute;
      let to = known
        ? finish.day > day
          ? 1440
          : Math.min(1440, finish.minute + 1)
        : Math.min(1440, from + 20);
      if (to <= from)
        to = Math.min(1440, from + Math.max(1, item.duration ?? 1));
      timed.push({
        item,
        start: from,
        end: to,
        known,
        lane: 0,
        lanes: 1,
        conflict: false,
        continuesBefore: start.day < day,
        continuesAfter: finish.day > day,
      });
    }
    timed.sort(
      (a, b) =>
        a.start - b.start ||
        b.end - a.end ||
        a.item.id.localeCompare(b.item.id),
    );
    let group = [],
      ends = [];
    const finishGroup = () => {
      for (const entry of group) entry.lanes = ends.length;
      group = [];
      ends = [];
    };
    for (const entry of timed) {
      // Minimum visual height also occupies a lane; uncertainty never creates a factual conflict.
      if (group.length && entry.start >= Math.max(...ends)) finishGroup();
      let lane = ends.findIndex((end) => end <= entry.start);
      if (lane < 0) lane = ends.length;
      entry.lane = lane;
      ends[lane] = Math.max(entry.end, entry.start + 45);
      group.push(entry);
    }
    finishGroup();
    const known = timed.filter((entry) => entry.known);
    for (let i = 0; i < known.length; i++)
      for (
        let j = i + 1;
        j < known.length && known[j].start < known[i].end;
        j++
      ) {
        // Wall-clock lanes can overlap during DST; only absolute intervals imply a conflict.
        const a = known[i].item,
          b = known[j].item;
        if (
          Date.parse(a.at) < Date.parse(b.at) + b.duration * 60000 &&
          Date.parse(b.at) < Date.parse(a.at) + a.duration * 60000
        )
          known[i].conflict = known[j].conflict = true;
      }
    return { day, timed, floating };
  });
}
