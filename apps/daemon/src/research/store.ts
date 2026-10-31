// 리서치 작업·실행·읽은 페이지 저장 (P11b). 페이지 원문은 저장하지 않는다 (요약·짧은 인용·주소·제목만)
import type { Database } from "bun:sqlite";
import {
  nextRun,
  type Research,
  type ResearchEvent,
  ResearchInput,
  type ResearchMessage,
  type ResearchPage,
  type ResearchRun,
  type ResearchRunDetail,
  type ResearchTimeline,
  scheduleError,
} from "@proprix/shared";
import { domainMatches } from "./policy";

interface ResearchRow {
  id: string;
  title: string;
  goal: string;
  instruction: string;
  agent_id: string;
  agent_ids: string;
  mode: string;
  scope: string;
  output: string;
  schedule: string | null;
  next_run_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  research_id: string;
  batch_id: string;
  agent_id: string;
  role: ResearchRun["role"];
  status: ResearchRun["status"];
  stage: ResearchRun["stage"];
  pages: number;
  requests: number;
  error: string;
  result: string;
  note_id: string;
  change_id: string;
  path: string;
  started_at: number;
  finished_at: number | null;
}

interface PageRow {
  id: string;
  run_id: string;
  research_id: string;
  url: string;
  title: string;
  depth: number;
  status: ResearchPage["status"];
  relevant: number;
  summary: string;
  quotes: string;
  fetched_at: number;
}

const json = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toRun = (r: RunRow): ResearchRun => ({
  id: r.id,
  researchId: r.research_id,
  batchId: r.batch_id,
  agentId: r.agent_id,
  role: r.role,
  status: r.status,
  stage: r.stage,
  pages: r.pages,
  requests: r.requests,
  error: r.error,
  result: r.result,
  noteId: r.note_id,
  changeId: r.change_id,
  path: r.path,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toPage = (r: PageRow): ResearchPage => ({
  id: r.id,
  runId: r.run_id,
  url: r.url,
  title: r.title,
  depth: r.depth,
  status: r.status,
  relevant: r.relevant === 1,
  summary: r.summary,
  quotes: json<string[]>(r.quotes, []),
  fetchedAt: r.fetched_at,
});

const MAX_EVENTS = 300;

// 저장된 에이전트 목록 (비었으면 대표 에이전트)
const legacyAgents = (r: ResearchRow): string[] => {
  const ids = json<string[]>(r.agent_ids, []);
  return ids.length ? ids : [r.agent_id];
};

export type ResearchError = { error: "invalid" | "not_found"; message: string };
type Parsed = ReturnType<typeof ResearchInput.parse>;

export class ResearchStore {
  constructor(
    private readonly db: Database,
    private readonly agentExists: (id: string) => boolean,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  private toResearch(r: ResearchRow): Research {
    const last = this.db
      .query<RunRow, { id: string }>(
        "SELECT * FROM research_runs WHERE research_id = $id ORDER BY status = 'running' DESC, started_at DESC, rowid DESC LIMIT 1",
      )
      .get({ id: r.id });
    const parsed = ResearchInput.safeParse({
      title: r.title,
      goal: r.goal,
      instruction: r.instruction,
      agentIds: legacyAgents(r),
      mode: r.mode,
      scope: json(r.scope, {}),
      output: json(r.output, { target: "note" }),
      schedule: json(r.schedule, null),
      enabled: r.enabled === 1,
    });
    const p = parsed.success
      ? parsed.data
      : ResearchInput.parse({ title: r.title, goal: r.goal || "?", agentIds: legacyAgents(r) });
    return {
      ...p,
      id: r.id,
      nextRunAt: r.next_run_at,
      lastRun: last ? toRun(last) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): Research[] {
    return this.db
      .query<ResearchRow, []>("SELECT * FROM research ORDER BY updated_at DESC")
      .all()
      .map((r) => this.toResearch(r));
  }

  get(id: string): Research | null {
    const r = this.db.query<ResearchRow, { id: string }>("SELECT * FROM research WHERE id = $id").get({ id });
    return r ? this.toResearch(r) : null;
  }

  // 검사 후 저장할 값 (다음 예약 시각 포함)
  private check(raw: unknown, prev?: Research): (Parsed & { next: number | null }) | ResearchError {
    const p = ResearchInput.safeParse(raw);
    if (!p.success) return { error: "invalid", message: p.error.issues[0]?.message ?? "형식 오류" };
    const t = p.data;
    t.agentIds = [...new Set(t.agentIds)];
    if (!t.agentIds.every((a) => this.agentExists(a))) return { error: "invalid", message: "없는 에이전트" };
    const now = this.now();
    if (t.schedule?.kind === "interval") {
      const old =
        prev?.schedule?.kind === "interval" && prev.schedule.hours === t.schedule.hours
          ? prev.schedule.anchor
          : undefined;
      t.schedule = { ...t.schedule, anchor: old ?? now };
    }
    if (t.schedule) {
      const bad = scheduleError(t.schedule, now);
      if (bad) return { error: "invalid", message: bad };
    }
    t.scope.domains = [...new Set(t.scope.domains)];
    t.scope.startUrls = [...new Set(t.scope.startUrls)];
    if (t.scope.domains.length) {
      const outside = t.scope.startUrls.find((u) => {
        try {
          return !domainMatches(new URL(u).hostname, t.scope.domains); // 같은 판정: 도메인이거나 그 하위
        } catch {
          return true;
        }
      });
      if (outside) return { error: "invalid", message: `시작 주소가 허용 도메인 밖입니다: ${outside}` };
    }
    return { ...t, next: t.schedule && t.enabled ? nextRun(t.schedule, now) : null };
  }

  create(raw: unknown): Research | ResearchError {
    const t = this.check(raw);
    if ("error" in t) return t;
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .query(
        `INSERT INTO research (id, title, goal, instruction, agent_id, agent_ids, mode, scope, output, schedule, next_run_at, enabled,
         created_at, updated_at)
         VALUES ($id, $title, $goal, $instruction, $agent, $agents, $mode, $scope, $output, $schedule, $next, $enabled, $now, $now)`,
      )
      .run({ id, ...params(t), now });
    this.onChange();
    return this.get(id) as Research;
  }

  update(id: string, raw: unknown): Research | ResearchError {
    const prev = this.get(id);
    if (!prev) return { error: "not_found", message: "없는 리서치" };
    const t = this.check(raw, prev);
    if ("error" in t) return t;
    this.db
      .query(
        `UPDATE research SET title = $title, goal = $goal, instruction = $instruction, agent_id = $agent, agent_ids = $agents, mode = $mode, scope = $scope,
         output = $output, schedule = $schedule, next_run_at = $next, enabled = $enabled, updated_at = $now WHERE id = $id`,
      )
      .run({ id, ...params(t), now: this.now() });
    this.onChange();
    return this.get(id) as Research;
  }

  delete(id: string): boolean {
    const n = this.db.query("DELETE FROM research WHERE id = $id").run({ id }).changes;
    if (n) this.onChange();
    return n > 0;
  }

  /** 예약 회차를 다음으로 넘긴다 (P11c) */
  advance(id: string, after: number) {
    const r = this.get(id);
    if (!r) return;
    this.db
      .query("UPDATE research SET next_run_at = $next WHERE id = $id")
      .run({ id, next: r.schedule && r.enabled ? nextRun(r.schedule, after) : null });
  }

  /** 예약 시각이 된 리서치 (P11c) */
  due(now: number): Research[] {
    return this.db
      .query<ResearchRow, { now: number }>(
        "SELECT * FROM research WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $now ORDER BY next_run_at",
      )
      .all({ now })
      .map((r) => this.toResearch(r));
  }

  // ---- 실행 ----

  createRun(
    researchId: string,
    m: { batchId?: string; agentId?: string; role?: ResearchRun["role"] } = {},
  ): ResearchRun {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO research_runs (id, research_id, batch_id, agent_id, role, status, started_at)
         VALUES ($id, $research, $batch, $agent, $role, 'running', $now)`,
      )
      .run({
        id,
        research: researchId,
        batch: m.batchId ?? id,
        agent: m.agentId ?? "",
        role: m.role ?? "full",
        now: this.now(),
      });
    return this.run(id) as ResearchRun;
  }

  /** 예약 회차를 건너뛴 기록 (P11c): 끝난 'skipped' 실행, error 에 까닭 */
  skipRun(researchId: string, reason: string): ResearchRun {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .query(
        `INSERT INTO research_runs (id, research_id, batch_id, agent_id, status, error, started_at, finished_at)
         VALUES ($id, $research, $id, (SELECT agent_id FROM research WHERE id = $research), 'skipped', $reason, $now, $now)`,
      )
      .run({ id, research: researchId, reason, now });
    return this.run(id) as ResearchRun;
  }

  run(id: string): ResearchRun | null {
    const r = this.db.query<RunRow, { id: string }>("SELECT * FROM research_runs WHERE id = $id").get({ id });
    return r ? toRun(r) : null;
  }

  updateRun(id: string, patch: Partial<Omit<ResearchRun, "id" | "researchId" | "startedAt">>): ResearchRun {
    const cur = this.run(id);
    if (!cur) throw new Error(`no run ${id}`);
    const n = { ...cur, ...patch };
    this.db
      .query(
        `UPDATE research_runs SET status = $status, stage = $stage, pages = $pages, requests = $requests, error = $error,
         result = $result, note_id = $note, change_id = $change, path = $path, finished_at = $finished WHERE id = $id`,
      )
      .run({
        id,
        status: n.status,
        stage: n.stage,
        pages: n.pages,
        requests: n.requests,
        error: n.error,
        result: n.result,
        note: n.noteId,
        change: n.changeId,
        path: n.path,
        finished: n.finishedAt,
      });
    return n;
  }

  runs(researchId: string, limit = 60): ResearchRun[] {
    return this.db
      .query<RunRow, { id: string }>(
        `SELECT * FROM research_runs WHERE research_id = $id ORDER BY started_at DESC, rowid DESC LIMIT ${limit}`,
      )
      .all({ id: researchId })
      .map(toRun);
  }

  detail(runId: string): ResearchRunDetail | null {
    const run = this.run(runId);
    if (!run) return null;
    const pages = this.db
      .query<PageRow, { id: string }>("SELECT * FROM research_pages WHERE run_id = $id ORDER BY fetched_at, rowid")
      .all({ id: runId })
      .map(toPage);
    return { ...run, pages, events: this.events(runId) };
  }

  // ---- 대화 (P12d) ----

  addMessage(m: Omit<ResearchMessage, "id" | "at"> & { at?: number }): ResearchMessage {
    const msg: ResearchMessage = { ...m, id: crypto.randomUUID(), at: m.at ?? this.now() };
    this.db
      .query(
        `INSERT INTO research_messages (id, research_id, role, kind, agent_id, text, status, at)
         VALUES ($id, $research, $role, $kind, $agent, $text, $status, $at)`,
      )
      .run({
        id: msg.id,
        research: msg.researchId,
        role: msg.role,
        kind: msg.kind,
        agent: msg.agentId,
        text: msg.text,
        status: msg.status,
        at: msg.at,
      });
    return msg;
  }

  updateMessage(id: string, text: string, status: ResearchMessage["status"]) {
    this.db
      .query("UPDATE research_messages SET text = $text, status = $status WHERE id = $id")
      .run({ id, text, status });
  }

  messages(researchId: string, limit = 200): ResearchMessage[] {
    return this.db
      .query<
        {
          id: string;
          research_id: string;
          role: ResearchMessage["role"];
          kind: ResearchMessage["kind"];
          agent_id: string;
          text: string;
          status: ResearchMessage["status"];
          at: number;
        },
        { id: string }
      >(`SELECT * FROM research_messages WHERE research_id = $id ORDER BY at DESC, rowid DESC LIMIT ${limit}`)
      .all({ id: researchId })
      .reverse()
      .map((m) => ({
        id: m.id,
        researchId: m.research_id,
        role: m.role,
        kind: m.kind,
        agentId: m.agent_id,
        text: m.text,
        status: m.status,
        at: m.at,
      }));
  }

  /** 화면에 그릴 흐름: 최근 실행들, 그 행동 로그, 대화 */
  timeline(researchId: string): ResearchTimeline {
    const runs = this.runs(researchId);
    return { runs, events: runs.flatMap((r) => this.events(r.id)), messages: this.messages(researchId) };
  }

  /** 대화의 바탕: 가장 최근 묶음에서 글이 나온 실행들과 지금까지의 관련 페이지 요약 (원문은 저장하지 않으므로 없다) */
  latestSources(researchId: string): { articles: ResearchRun[]; pages: ResearchPage[] } {
    const latest = this.runs(researchId, 60).find((r) => r.result && (r.noteId || r.changeId));
    if (!latest) return { articles: [], pages: [] };
    const batch = this.runs(researchId, 60).filter((r) => r.batchId === latest.batchId);
    return {
      articles: batch.filter((r) => r.result && (r.noteId || r.changeId)),
      pages: this.relevantPages(researchId),
    };
  }

  /** 이어서 조사의 바탕: 이 에이전트의 가장 최근 글 (합친 글은 합친 글끼리) */
  latestArticle(researchId: string, agentId: string, merge = false): ResearchRun | null {
    return (
      this.runs(researchId, 60).find(
        (r) => r.agentId === agentId && (r.role === "merge") === merge && !!r.result && !!(r.noteId || r.changeId),
      ) ?? null
    );
  }

  /** 지금까지 읽은 관련 페이지 (주소마다 최신 하나, 최신순). agentId 를 주면 그 에이전트가 읽은 것만 */
  relevantPages(researchId: string, agentId?: string, limit = 40): ResearchPage[] {
    const rows = this.db
      .query<PageRow, { id: string; agent: string }>(
        `SELECT * FROM research_pages WHERE research_id = $id AND relevant = 1 AND ($agent = '' OR agent_id = $agent)
         ORDER BY rowid DESC`,
      )
      .all({ id: researchId, agent: agentId ?? "" });
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      })
      .slice(0, limit)
      .map(toPage);
  }

  // ---- 행동 로그 (P12a) ----

  addEvent(runId: string, kind: ResearchEvent["kind"], text: string): ResearchEvent {
    const e: ResearchEvent = { id: crypto.randomUUID(), runId, at: this.now(), kind, text: text.slice(0, 500) };
    this.db
      .query("INSERT INTO research_events (id, run_id, at, kind, text) VALUES ($id, $run, $at, $kind, $text)")
      .run({ id: e.id, run: runId, at: e.at, kind, text: e.text });
    this.db
      .query(
        `DELETE FROM research_events WHERE run_id = $run AND rowid NOT IN
         (SELECT rowid FROM research_events WHERE run_id = $run ORDER BY rowid DESC LIMIT ${MAX_EVENTS})`,
      )
      .run({ run: runId });
    return e;
  }

  events(runId: string): ResearchEvent[] {
    return this.db
      .query<{ id: string; run_id: string; at: number; kind: ResearchEvent["kind"]; text: string }, { id: string }>(
        "SELECT * FROM research_events WHERE run_id = $id ORDER BY rowid",
      )
      .all({ id: runId })
      .map((e) => ({ id: e.id, runId: e.run_id, at: e.at, kind: e.kind, text: e.text }));
  }

  addPage(
    p: Omit<ResearchPage, "id" | "fetchedAt"> & { researchId: string; agentId?: string; contentHash?: string },
  ): ResearchPage {
    const id = crypto.randomUUID();
    const fetchedAt = this.now();
    this.db
      .query(
        `INSERT INTO research_pages (id, run_id, research_id, agent_id, url, title, depth, status, relevant, summary, quotes, content_hash, fetched_at)
         VALUES ($id, $run, $research, $agent, $url, $title, $depth, $status, $relevant, $summary, $quotes, $hash, $at)`,
      )
      .run({
        id,
        run: p.runId,
        research: p.researchId,
        agent: p.agentId ?? "",
        url: p.url,
        title: p.title,
        depth: p.depth,
        status: p.status,
        relevant: p.relevant ? 1 : 0,
        summary: p.summary,
        quotes: JSON.stringify(p.quotes),
        hash: p.contentHash ?? "",
        at: fetchedAt,
      });
    const { researchId: _r, agentId: _a, contentHash: _h, ...page } = p;
    return { ...page, id, fetchedAt };
  }

  /** 이 리서치에서 예전에 읽은 주소 (반복 실행이 건너뛴다). agentId 를 주면 그 에이전트가 읽은 것만 */
  seenUrls(researchId: string, agentId?: string): Set<string> {
    return new Set(
      this.db
        .query<{ url: string }, { id: string; agent: string }>(
          "SELECT DISTINCT url FROM research_pages WHERE research_id = $id AND ($agent = '' OR agent_id = $agent)",
        )
        .all({ id: researchId, agent: agentId ?? "" })
        .map((r) => r.url),
    );
  }

  /** 이 주소를 지난번에 읽었을 때의 내용 해시 (시작 주소 재방문) */
  lastHash(researchId: string, url: string, agentId?: string): string {
    return (
      this.db
        .query<{ h: string }, { id: string; url: string; agent: string }>(
          `SELECT content_hash h FROM research_pages WHERE research_id = $id AND url = $url AND content_hash != ''
           AND ($agent = '' OR agent_id = $agent) ORDER BY rowid DESC LIMIT 1`,
        )
        .get({ id: researchId, url, agent: agentId ?? "" })?.h ?? ""
    );
  }

  // 이전 실행에서 끝나지 못한 것 (daemon 이 꺼짐)
  closeStale() {
    this.db
      .query(
        "UPDATE research_runs SET status = 'failed', error = 'daemon_restarted', finished_at = $now WHERE status = 'running'",
      )
      .run({ now: this.now() });
  }
}

const params = (t: Parsed & { next: number | null }) => ({
  title: t.title,
  goal: t.goal,
  instruction: t.instruction,
  agent: t.agentIds[0] ?? "",
  agents: JSON.stringify(t.agentIds),
  mode: t.mode,
  scope: JSON.stringify(t.scope),
  output: JSON.stringify(t.output),
  schedule: t.schedule ? JSON.stringify(t.schedule) : null,
  next: t.next,
  enabled: t.enabled ? 1 : 0,
});
