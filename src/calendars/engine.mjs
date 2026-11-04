import { randomUUID } from "node:crypto";
import { BobError, requireThat } from "../errors.mjs";
import {
  canonical,
  digest,
  localPatch,
  remoteKey,
  syncRange,
} from "./model.mjs";
import { dayAt } from "../dates.mjs";

export class CalendarSync {
  constructor(
    store,
    owner,
    { adapter, clock = () => new Date().toISOString(), enabled = () => true },
  ) {
    this.store = store;
    this.owner = owner;
    this.adapter = adapter;
    this.clock = clock;
    this.enabled = enabled;
    this.running = new Map();
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS calendar_connections(id TEXT PRIMARY KEY,owner TEXT NOT NULL,provider TEXT NOT NULL,calendar_id TEXT,label TEXT NOT NULL,credentials TEXT,status TEXT NOT NULL DEFAULT 'choosing',is_default INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,enabled_at TEXT,next_at TEXT,last_ok TEXT,last_error TEXT,lease_until TEXT);
   CREATE INDEX IF NOT EXISTS calendar_connections_owner ON calendar_connections(owner,status,next_at);
   CREATE TABLE IF NOT EXISTS calendar_links(connection_id TEXT NOT NULL,owner TEXT NOT NULL,remote_id TEXT NOT NULL,item_id TEXT NOT NULL,base_local TEXT,base_remote TEXT,remote_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'clean',last_checked TEXT,PRIMARY KEY(connection_id,remote_id),UNIQUE(connection_id,item_id));
   CREATE TABLE IF NOT EXISTS calendar_conflicts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,remote_id TEXT NOT NULL,local_json TEXT NOT NULL,remote_json TEXT NOT NULL,local_hash TEXT NOT NULL,remote_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');`);
  }
  connection(id) {
    const connection = this.store.db
      .prepare("SELECT * FROM calendar_connections WHERE owner=? AND id=?")
      .get(this.owner, id);
    requireThat(
      connection,
      "CALENDAR_CONNECTION",
      "Подключение не найдено. Открой календари заново.",
    );
    return connection;
  }
  connections() {
    return this.store.db
      .prepare(
        "SELECT * FROM calendar_connections WHERE owner=? AND status!='off' ORDER BY created_at",
      )
      .all(this.owner);
  }
  create(provider, credentials) {
    requireThat(
      ["google", "yandex"].includes(provider),
      "CALENDAR_CONNECTION",
      "Неверный сервис календаря.",
    );
    const old = this.connections().filter(
      (value) => value.provider === provider,
    );
    requireThat(
      old.every((value) => value.status === "choosing"),
      "CALENDAR_CONNECTION",
      "Сначала отключи текущее подключение этого сервиса.",
    );
    for (const row of old)
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET credentials=NULL,status='off' WHERE owner=? AND id=?",
        )
        .run(this.owner, row.id);
    const id = randomUUID().replaceAll("-", "").slice(0, 20);
    this.store.db
      .prepare(
        "INSERT INTO calendar_connections(id,owner,provider,label,credentials,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        this.owner,
        provider,
        provider === "google" ? "Google" : "Яндекс",
        credentials,
        this.clock(),
      );
    return id;
  }
  activate(id, calendar, { defaultCalendar = false, before = () => {} } = {}) {
    const connection = this.connection(id);
    requireThat(
      connection.status === "choosing" &&
        (!connection.calendar_id || connection.calendar_id === calendar?.id) &&
        calendar?.writable &&
        typeof calendar.id === "string",
      "CALENDAR_PERMISSION",
      "Выбери доступный календарь с правом записи.",
    );
    this.store.transaction(() => {
      before();
      if (defaultCalendar)
        this.store.db
          .prepare("UPDATE calendar_connections SET is_default=0 WHERE owner=?")
          .run(this.owner);
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET calendar_id=?,label=?,status='active',enabled_at=?,next_at=?,is_default=? WHERE owner=? AND id=?",
        )
        .run(
          calendar.id,
          String(calendar.label).slice(0, 160),
          connection.enabled_at ?? this.clock(),
          this.clock(),
          defaultCalendar ? 1 : 0,
          this.owner,
          id,
        );
    });
  }
  setDefault(id) {
    requireThat(
      this.enabled() && this.connection(id).status === "active",
      "CALENDAR_CONNECTION",
      "Подключение не активно.",
    );
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE calendar_connections SET is_default=0 WHERE owner=?")
        .run(this.owner);
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET is_default=1 WHERE owner=? AND id=?",
        )
        .run(this.owner, id);
    });
  }
  disconnect(id) {
    this.connection(id);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET status='off',credentials=NULL,is_default=0,lease_until=NULL,next_at=NULL WHERE owner=? AND id=?",
        )
        .run(this.owner, id);
      this.store.db
        .prepare(
          "UPDATE calendar_conflicts SET status='disconnected' WHERE owner=? AND connection_id=? AND status IN ('pending','resolving')",
        )
        .run(this.owner, id);
    });
  }
  pending() {
    return this.store.db
      .prepare(
        "SELECT * FROM calendar_conflicts WHERE owner=? AND status='pending'",
      )
      .all(this.owner);
  }
  expired(body) {
    return body.at
      ? Date.parse(body.at) + body.duration * 60000 <= Date.parse(this.clock())
      : body.end_day <=
          dayAt(this.clock(), this.store.user(this.owner).timezone);
  }
  link(connection, id) {
    return this.store.db
      .prepare(
        "SELECT * FROM calendar_links WHERE owner=? AND connection_id=? AND item_id=?",
      )
      .get(this.owner, connection, id);
  }
  clean(connection, item, remote) {
    const current = this.connection(connection.id);
    if (current.status !== "active") return;
    this.store.db
      .prepare(
        "UPDATE calendar_links SET remote_id=?,base_local=?,base_remote=?,remote_json=?,state='clean',last_checked=? WHERE owner=? AND connection_id=? AND item_id=?",
      )
      .run(
        remote.id,
        digest(canonical(item)),
        digest(remote.body),
        JSON.stringify(remote),
        this.clock(),
        this.owner,
        connection.id,
        item.id,
      );
    this.store.db
      .prepare(
        "UPDATE calendar_conflicts SET status='resolved' WHERE owner=? AND connection_id=? AND item_id=? AND status='resolving'",
      )
      .run(this.owner, connection.id, item.id);
  }
  conflict(connection, item, remote) {
    const local = canonical(item),
      remoteBody = remote?.body ?? { status: "cancelled" },
      old = this.store.db
        .prepare(
          "SELECT id FROM calendar_conflicts WHERE owner=? AND connection_id=? AND item_id=? AND status='pending'",
        )
        .get(this.owner, connection.id, item.id);
    const id = old?.id ?? randomUUID().replaceAll("-", "").slice(0, 20);
    this.store.db
      .prepare(
        "INSERT INTO calendar_conflicts(id,owner,connection_id,item_id,remote_id,local_json,remote_json,local_hash,remote_hash) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET local_json=excluded.local_json,remote_json=excluded.remote_json,local_hash=excluded.local_hash,remote_hash=excluded.remote_hash",
      )
      .run(
        id,
        this.owner,
        connection.id,
        item.id,
        remote?.id ?? this.link(connection.id, item.id).remote_id,
        JSON.stringify(local),
        JSON.stringify(remote),
        digest(local),
        digest(remoteBody),
      );
  }
  apply(connection, item, remote) {
    return this.store.transaction(() => {
      requireThat(
        this.enabled() && this.connection(connection.id).status === "active",
        "CALENDAR_CONNECTION",
        "Подключение уже отключено.",
      );
      const current = this.store.item(this.owner, item.id);
      requireThat(
        current?.version === item.version,
        "CALENDAR_LOCAL_CHANGED",
        "Дело изменилось во время синхронизации. Повторю сверку.",
      );
      const body = remote?.body ?? { status: "cancelled" };
      if (body.status === "cancelled") {
        if (current.status === "open")
          this.store.changeItem(
            this.owner,
            item.id,
            { status: "cancelled" },
            this.clock(),
          );
      } else {
        const patch = localPatch(body, this.store.user(this.owner).timezone);
        this.store.db
          .prepare(
            "UPDATE items SET title=?,day=?,at=?,duration=?,status=?,version=version+1 WHERE owner=? AND id=?",
          )
          .run(
            patch.title,
            patch.day,
            patch.at,
            patch.duration,
            this.expired(body) ? "elapsed" : "open",
            this.owner,
            item.id,
          );
        this.store.db
          .prepare(
            "INSERT INTO calendar_item_meta VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET all_day=excluded.all_day,end_day=excluded.end_day",
          )
          .run(item.id, connection.id, body.all_day, body.end_day, body.day);
        this.store.replaceReminder(
          this.owner,
          item.id,
          this.clock(),
          current.reminder_minutes,
        );
      }
      this.store.db
        .prepare("UPDATE users SET revision=revision+1 WHERE id=?")
        .run(this.owner);
      const next = this.store.item(this.owner, item.id);
      this.clean(
        connection,
        next,
        remote ?? {
          id: this.link(connection.id, item.id).remote_id,
          body: { status: "cancelled" },
        },
      );
      return next;
    });
  }
  import(connection, remote) {
    if (remote.body.status === "cancelled") return;
    this.store.transaction(() => {
      const id =
          "event-" +
          digest(this.owner + "|" + connection.id + "|" + remote.id).slice(
            0,
            24,
          ),
        existing = this.store.item(this.owner, id);
      if (!existing)
        this.store.putItem(
          {
            id,
            owner: this.owner,
            kind: "event",
            area: "Личное",
            project: null,
            source_key: "calendar:" + connection.id,
            ...localPatch(remote.body, this.store.user(this.owner).timezone),
          },
          this.clock(),
          this.store.user(this.owner).reminder_minutes,
        );
      if (!existing && this.expired(remote.body))
        this.store.changeItem(
          this.owner,
          id,
          { status: "elapsed" },
          this.clock(),
        );
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO calendar_links(connection_id,owner,remote_id,item_id,remote_json) VALUES (?,?,?,?,?)",
        )
        .run(connection.id, this.owner, remote.id, id, JSON.stringify(remote));
      this.store.db
        .prepare("INSERT OR IGNORE INTO calendar_item_meta VALUES (?,?,?,?,?)")
        .run(
          id,
          connection.id,
          remote.body.all_day,
          remote.body.end_day,
          remote.body.day,
        );
      this.clean(connection, this.store.item(this.owner, id), remote);
      this.store.db
        .prepare("UPDATE users SET revision=revision+1 WHERE id=?")
        .run(this.owner);
    });
  }
  async push(connection, adapter, item, remote, create = false) {
    requireThat(
      this.enabled() && this.connection(connection.id).status === "active",
      "CALENDAR_CONNECTION",
      "Подключение уже отключено.",
    );
    let written;
    if (create && canonical(item).status === "cancelled")
      written = { ...remote, body: { status: "cancelled" } };
    else
      written = await adapter.write(
        connection.calendar_id,
        remote,
        canonical(item),
        { create, now: this.clock() },
      );
    requireThat(
      written,
      "CALENDAR_HTTP",
      "Не получено подтверждение записи календаря.",
    );
    const after = this.store.item(this.owner, item.id);
    if (this.connection(connection.id).status !== "active") return;
    if (after?.version === item.version) this.clean(connection, after, written);
    else
      this.store.db
        .prepare(
          "UPDATE calendar_links SET base_local=?,base_remote=?,remote_json=?,state='clean' WHERE owner=? AND connection_id=? AND item_id=?",
        )
        .run(
          digest(canonical(item)),
          digest(written.body),
          JSON.stringify(written),
          this.owner,
          connection.id,
          item.id,
        );
  }
  sync(id, { force = false } = {}) {
    if (this.running.has(id)) return this.running.get(id);
    const operation = this.run(id, force).finally(() =>
      this.running.delete(id),
    );
    this.running.set(id, operation);
    return operation;
  }
  async run(id, force) {
    const connection = this.connection(id),
      now = this.clock();
    if (
      !this.enabled() ||
      connection.status !== "active" ||
      connection.lease_until > now ||
      (!force && connection.next_at > now)
    )
      return { skipped: true };
    this.store.db
      .prepare(
        "UPDATE calendar_connections SET lease_until=? WHERE owner=? AND id=?",
      )
      .run(new Date(Date.parse(now) + 120000).toISOString(), this.owner, id);
    let changes = 0;
    try {
      const adapter = await this.adapter(connection),
        remotes = await adapter.list(connection.calendar_id, syncRange(now));
      requireThat(
        Array.isArray(remotes) && remotes.length <= 8000,
        "CALENDAR_SIZE",
        "Календарь слишком большой для альфы.",
      );
      const remoteMap = new Map();
      for (const remote of remotes) {
        requireThat(
          !remoteMap.has(remote.id) &&
            (remote.etag || remote.body?.status === "cancelled"),
          "CALENDAR_SNAPSHOT",
          "Не получен полный непротиворечивый список событий.",
        );
        remoteMap.set(remote.id, remote);
      }
      requireThat(
        this.enabled() && this.connection(id).status === "active",
        "CALENDAR_CONNECTION",
        "Подключение уже отключено.",
      );
      const links = this.store.db
          .prepare(
            "SELECT * FROM calendar_links WHERE owner=? AND connection_id=?",
          )
          .all(this.owner, id),
        known = new Set(links.map((row) => row.remote_id));
      for (const remote of remotes)
        if (!known.has(remote.id)) {
          this.import(connection, remote);
          changes++;
        }
      for (const link of links) {
        const item = this.store.item(this.owner, link.item_id);
        if (!item) continue;
        const localHash = digest(canonical(item)),
          localChanged = localHash !== link.base_local;
        if (
          link.state === "clean" &&
          link.base_remote === digest({ status: "cancelled" }) &&
          localHash === link.base_local &&
          !remoteMap.has(link.remote_id)
        )
          continue;
        let remote = remoteMap.get(link.remote_id);
        const prior = JSON.parse(link.remote_json),
          range = syncRange(now),
          priorAt =
            prior.body?.at ??
            (prior.body?.day ? prior.body.day + "T00:00:00.000Z" : null);
        if (
          !remote &&
          !localChanged &&
          link.state === "clean" &&
          link.last_checked >
            new Date(Date.parse(now) - 86400000).toISOString() &&
          priorAt &&
          (priorAt < range.start || priorAt >= range.end)
        )
          continue;
        if (!remote)
          remote = await adapter.get(connection.calendar_id, link.remote_id);
        const remoteHash = digest(remote?.body ?? { status: "cancelled" }),
          remoteChanged = remoteHash !== link.base_remote;
        if (link.state === "creating" && !remote) {
          await this.push(
            connection,
            adapter,
            item,
            JSON.parse(link.remote_json),
            true,
          );
          changes++;
          continue;
        }
        if (
          localHash === remoteHash &&
          !localChanged &&
          remoteHash === link.base_remote &&
          prior.etag === remote?.etag
        ) {
          if (
            !link.last_checked ||
            link.last_checked <=
              new Date(Date.parse(now) - 86400000).toISOString()
          )
            this.store.db
              .prepare(
                "UPDATE calendar_links SET last_checked=? WHERE owner=? AND connection_id=? AND item_id=?",
              )
              .run(now, this.owner, id, item.id);
          continue;
        }
        if (localHash === remoteHash) {
          this.clean(
            connection,
            item,
            remote ?? { id: link.remote_id, body: { status: "cancelled" } },
          );
          continue;
        }
        if (localChanged && remoteChanged) {
          this.conflict(connection, item, remote);
          continue;
        }
        if (remoteChanged) {
          this.apply(connection, item, remote);
          changes++;
        } else if (localChanged) {
          try {
            if (
              remoteHash === digest({ status: "cancelled" }) &&
              canonical(item).status === "open"
            ) {
              const key = remoteKey(
                  this.owner,
                  id,
                  item.id + "|revive|" + item.version,
                ),
                target = adapter.draft
                  ? adapter.draft(connection.calendar_id, key)
                  : { id: key, resource: key };
              this.store.db
                .prepare(
                  "UPDATE calendar_links SET remote_id=?,remote_json=?,state='creating',base_local=NULL,base_remote=NULL WHERE owner=? AND connection_id=? AND item_id=?",
                )
                .run(
                  target.id,
                  JSON.stringify(target),
                  this.owner,
                  id,
                  item.id,
                );
              await this.push(connection, adapter, item, target, true);
            } else
              await this.push(
                connection,
                adapter,
                item,
                remote ?? JSON.parse(link.remote_json),
              );
            changes++;
          } catch (error) {
            if (error.code !== "CALENDAR_CONFLICT") throw error;
            this.conflict(
              connection,
              this.store.item(this.owner, item.id),
              await adapter.get(connection.calendar_id, link.remote_id),
            );
          }
        } else if (remote && JSON.parse(link.remote_json).etag !== remote.etag)
          this.store.db
            .prepare(
              "UPDATE calendar_links SET remote_json=? WHERE owner=? AND connection_id=? AND item_id=?",
            )
            .run(JSON.stringify(remote), this.owner, id, item.id);
      }
      if (this.connection(id).is_default) {
        const linked = new Set(
          this.store.db
            .prepare("SELECT item_id FROM calendar_links WHERE owner=?")
            .all(this.owner)
            .map((value) => value.item_id),
        );
        for (const item of this.store
          .items(this.owner)
          .filter(
            (value) =>
              !linked.has(value.id) &&
              !value.source_key &&
              ["event", "work"].includes(value.kind) &&
              value.at > now &&
              value.created_at >= connection.enabled_at,
          )
          .slice(0, 40)) {
          const key = remoteKey(this.owner, id, item.id),
            remote = adapter.draft
              ? adapter.draft(connection.calendar_id, key)
              : { id: key, resource: key };
          this.store.db
            .prepare(
              "INSERT OR IGNORE INTO calendar_links(connection_id,owner,remote_id,item_id,remote_json,state) VALUES (?,?,?,?,?,'creating')",
            )
            .run(id, this.owner, remote.id, item.id, JSON.stringify(remote));
          await this.push(connection, adapter, item, remote, true);
          changes++;
        }
      }
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET last_ok=?,last_error=NULL,next_at=?,lease_until=NULL WHERE owner=? AND id=? AND status='active'",
        )
        .run(
          this.clock(),
          new Date(Date.parse(this.clock()) + 300000).toISOString(),
          this.owner,
          id,
        );
      return {
        changes,
        conflicts: this.pending().filter((value) => value.connection_id === id)
          .length,
      };
    } catch (error) {
      const code = error instanceof BobError ? error.code : "CALENDAR_FAILED";
      this.store.db
        .prepare(
          "UPDATE calendar_connections SET last_error=?,next_at=?,lease_until=NULL WHERE owner=? AND id=? AND status='active'",
        )
        .run(
          code,
          new Date(
            Date.parse(this.clock()) +
              (code === "CALENDAR_BATCH" ? 60000 : 300000),
          ).toISOString(),
          this.owner,
          id,
        );
      if (error instanceof BobError) throw error;
      throw new BobError(
        "CALENDAR_FAILED",
        "Не удалось завершить синхронизацию. Повторю позже; сохранённые дела доступны.",
      );
    }
  }
  async tick() {
    for (const connection of this.connections()
      .filter(
        (value) =>
          value.status === "active" &&
          (!value.next_at || value.next_at <= this.clock()),
      )
      .slice(0, 1))
      try {
        await this.sync(connection.id);
      } catch {}
  }
  nextAt() {
    return this.store.db
      .prepare(
        "SELECT MIN(CASE WHEN lease_until>next_at THEN lease_until ELSE next_at END) AS at FROM calendar_connections WHERE owner=? AND status='active'",
      )
      .get(this.owner)?.at;
  }
  async resolve(id, choice) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM calendar_conflicts WHERE owner=? AND id=? AND status='pending'",
      )
      .get(this.owner, id);
    requireThat(
      row && ["local", "remote"].includes(choice),
      "CALENDAR_CONFLICT_GONE",
      "Открой актуальные конфликты календарей.",
    );
    const connection = this.connection(row.connection_id);
    requireThat(
      connection.status === "active",
      "CALENDAR_CONNECTION",
      "Подключение не активно.",
    );
    requireThat(
      !this.running.has(connection.id) &&
        !(connection.lease_until > this.clock()),
      "CALENDAR_BUSY",
      "Идёт синхронизация. Повтори выбор через несколько секунд.",
    );
    const adapter = await this.adapter(connection),
      item = this.store.item(this.owner, row.item_id),
      remote = await adapter.get(connection.calendar_id, row.remote_id);
    if (
      digest(canonical(item)) !== row.local_hash ||
      digest(remote?.body ?? { status: "cancelled" }) !== row.remote_hash
    ) {
      this.conflict(connection, item, remote);
      throw new BobError(
        "CALENDAR_CONFLICT_STALE",
        "После показа версии изменились. Открой конфликт заново.",
      );
    }
    this.store.db
      .prepare(
        "UPDATE calendar_conflicts SET status='resolving' WHERE owner=? AND id=?",
      )
      .run(this.owner, id);
    try {
      if (choice === "remote") this.apply(connection, item, remote);
      else {
        let target = remote,
          create = false;
        if (!remote || remote.body.status === "cancelled") {
          const key = remoteKey(
            this.owner,
            connection.id,
            item.id + "|restore|" + id,
          );
          target = adapter.draft
            ? adapter.draft(connection.calendar_id, key)
            : { id: key, resource: key };
          create = true;
          this.store.db
            .prepare(
              "UPDATE calendar_links SET remote_id=?,remote_json=?,state='creating',base_local=NULL,base_remote=NULL WHERE owner=? AND connection_id=? AND item_id=?",
            )
            .run(
              target.id,
              JSON.stringify(target),
              this.owner,
              connection.id,
              item.id,
            );
        }
        await this.push(connection, adapter, item, target, create);
      }
      this.store.db
        .prepare(
          "UPDATE calendar_conflicts SET status='resolved' WHERE owner=? AND id=?",
        )
        .run(this.owner, id);
    } catch (error) {
      this.store.db
        .prepare(
          "UPDATE calendar_conflicts SET status='pending' WHERE owner=? AND id=? AND status='resolving'",
        )
        .run(this.owner, id);
      throw error;
    }
  }
}
