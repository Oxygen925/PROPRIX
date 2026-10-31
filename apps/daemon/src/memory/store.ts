// 장기 메모리 저장·검색. 범위는 "shared"(공용) 또는 에이전트 id.
// 검색은 FTS5 두 색인(unicode61 접두·trigram 부분 문자열)과 짧은 한글 단어의 부분 일치를 RRF 로 합친다.
import type { Database } from "bun:sqlite";
import {
  type Agent,
  type Memory,
  type MemoryBulkRequest,
  type MemoryInput,
  type MemoryUse,
  SHARED_SCOPE,
} from "@proprix/shared";

interface MemoryRow {
  seq: number;
  id: string;
  scope: string;
  kind: Memory["kind"];
  content: string;
  content_en: string;
  importance: number;
  valid_until: number | null;
  superseded_by: string | null;
  source_room_id: string;
  source_message_id: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  scope: r.scope,
  kind: r.kind,
  content: r.content,
  contentEn: r.content_en,
  importance: r.importance,
  validUntil: r.valid_until,
  supersededBy: r.superseded_by,
  sourceRoomId: r.source_room_id,
  sourceMessageId: r.source_message_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
});

// 에이전트가 읽고 쓰는 범위. 격리 에이전트는 공용을 읽기만 한다
export function memoryScopes(agent: Agent): { read: string[]; shared: boolean } {
  return { read: [SHARED_SCOPE, agent.id], shared: !agent.memoryIsolated };
}

// 모델이 요청한 범위 → 실제 저장 범위
export function writeScope(agent: Agent, requested: "shared" | "agent"): string {
  return requested === "shared" && !agent.memoryIsolated ? SHARED_SCOPE : agent.id;
}

// 중복 판정용: 대소문자·공백·문장부호 무시
export const normalizeForDedupe = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const HANGUL = /\p{Script=Hangul}/u;
const RRF_K = 60;
const PER_SIGNAL = 50;

// 영어 불용어: 접두 검색에서 거의 모든 기억에 걸려 순위를 흐린다 (memory:eval 번역 변형의 무관 비율을 크게 올림)
const EN_STOPWORDS = new Set(
  (
    "a an the i me my mine we our you your he she it its they them their is am are was were be been being do does did " +
    "have has had to of in on at for from by with about as into than then so and or but if not no yes can could will " +
    "would should shall may might must what which who whom whose when where why how this that these those there here " +
    "any some all each more most very just also too again still ever anything something nothing really right ok okay"
  ).split(" "),
);

// 검색어 → 단어. 한 글자와 영어 불용어는 버리고 최대 12개
export function queryTerms(query: string): string[] {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => [...w].length >= 2 && !EN_STOPWORDS.has(w),
  );
  return [...new Set(words)].slice(0, 12);
}

// '하다' 활용의 끝 글자: "좋아하지"·"좋아한다"·"좋아해" 가 모두 "좋아" 로 모이게
const HADA = new Set(["하", "한", "할", "함", "해", "했"]);

// 검색어 한 단어 → 접두 검색에 쓸 형태들. 한글 3자 이상은 끝 한 글자(조사·어미)를 떼고,
// 그 끝이 '하다' 활용이면 한 글자 더 뗀다 (2자 미만으로는 줄이지 않음)
export function hangulStems(word: string): string[] {
  const out = [word];
  const s = [...word];
  if (!HANGUL.test(word) || s.length < 3) return out;
  s.pop();
  out.push(s.join(""));
  if (s.length >= 3 && HADA.has(s.at(-1) ?? "")) {
    s.pop();
    out.push(s.join(""));
  }
  return out;
}

const quote = (t: string) => `"${t.replaceAll('"', '""')}"`;

export type SearchSignal = "prefix" | "trigram" | "like2";
export const ALL_SIGNALS: readonly SearchSignal[] = ["prefix", "trigram", "like2"];

export interface SearchOptions {
  signals?: readonly SearchSignal[]; // 기본: 전부
  field?: "both" | "content" | "content_en"; // 기본: 둘 다
}

// Reciprocal Rank Fusion: 여러 순위 목록을 합친다 (앞쪽일수록 점수 큼)
export function rrf(lists: readonly (readonly string[])[], k = RRF_K): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export class MemoryStore {
  constructor(
    private readonly db: Database,
    private readonly onChange: () => void = () => {},
  ) {}

  get(id: string): Memory | null {
    const r = this.db.query<MemoryRow, { id: string }>("SELECT * FROM memories WHERE id = $id").get({ id });
    return r ? toMemory(r) : null;
  }

  // 관리 화면용 목록. history: 대체된 기억도 포함
  list(opt: { scope?: string; history?: boolean } = {}): Memory[] {
    const where = [opt.scope ? "scope = $scope" : "1", opt.history ? "1" : "superseded_by IS NULL"].join(" AND ");
    return this.db
      .query<MemoryRow, { scope: string }>(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC`)
      .all({ scope: opt.scope ?? "" })
      .map(toMemory);
  }

  create(input: MemoryInput, sourceRoomId = "", silent = false, sourceMessageId = ""): Memory {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO memories (id, scope, kind, content, content_en, importance, valid_until, source_room_id,
         source_message_id, created_at, updated_at)
         VALUES ($id, $scope, $kind, $content, $en, $importance, $valid, $room, $message, $now, $now)`,
      )
      .run({
        id,
        scope: input.scope,
        kind: input.kind,
        content: input.content,
        en: input.contentEn,
        importance: input.importance,
        valid: input.validUntil,
        room: sourceRoomId,
        message: sourceMessageId,
        now,
      });
    if (!silent) this.onChange();
    return this.get(id) as Memory;
  }

  // ---- 관리 화면 (P10e) ----

  // 범위·종류·중요도를 한꺼번에 바꾸거나 지운다 (한 트랜잭션, 알림 한 번). 바뀐 수
  bulk(req: Pick<MemoryBulkRequest, "ids" | "set" | "delete">): number {
    let n = 0;
    this.db.transaction(() => {
      for (const id of req.ids) {
        if (req.delete) {
          if (this.db.query("DELETE FROM memories WHERE id = $id").run({ id }).changes) n++; // 색인 트리거 변경은 세지 않는다
          continue;
        }
        const s = req.set ?? {};
        const changed = this.db
          .query(
            `UPDATE memories SET scope = COALESCE($scope, scope), kind = COALESCE($kind, kind),
             importance = COALESCE($importance, importance), updated_at = $now WHERE id = $id`,
          )
          .run({
            id,
            scope: s.scope ?? null,
            kind: s.kind ?? null,
            importance: s.importance ?? null,
            now: Date.now(),
          }).changes;
        if (changed) n++;
      }
    })();
    if (n) this.onChange();
    return n;
  }

  // 병합: 새 기억을 만들고 원본은 대체됨으로 남긴다 (이력). 출처는 원본이 모두 같은 방·메시지일 때만 잇는다
  merge(ids: string[], input: MemoryInput): Memory | null {
    const olds = ids.map((id) => this.get(id));
    if (olds.some((m) => m === null)) return null;
    const same = (f: (m: Memory) => string) => {
      const v = new Set((olds as Memory[]).map(f));
      return v.size === 1 ? ([...v][0] ?? "") : "";
    };
    let created: Memory | null = null;
    this.db.transaction(() => {
      created = this.create(
        input,
        same((m) => m.sourceRoomId),
        true,
        same((m) => m.sourceMessageId),
      );
      for (const id of ids) this.supersede(id, (created as Memory).id);
    })();
    this.onChange();
    return created;
  }

  // 이 기억을 참고로 넣은 답변 (최신순). LIKE 로 먼저 거르고 json_each 로 정확히 확인한다
  uses(id: string, limit: number): { total: number; items: MemoryUse[] } {
    const where = `m.memory_ids LIKE $like AND EXISTS (SELECT 1 FROM json_each(m.memory_ids) j WHERE j.value = $id)`;
    const params = { id, like: `%${id}%` };
    const total =
      this.db.query<{ n: number }, typeof params>(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(params)
        ?.n ?? 0;
    const items = this.db
      .query<
        { id: string; room_id: string; agent_id: string; created_at: number; excerpt: string; title: string | null },
        typeof params
      >(
        `SELECT m.id, m.room_id, m.agent_id, m.created_at, substr(m.content, 1, 200) AS excerpt, r.title
         FROM messages m LEFT JOIN rooms r ON r.id = m.room_id WHERE ${where} ORDER BY m.created_at DESC LIMIT ${limit}`,
      )
      .all(params)
      .map((r) => ({
        messageId: r.id,
        roomId: r.room_id,
        roomTitle: r.title ?? "",
        agentId: r.agent_id,
        createdAt: r.created_at,
        excerpt: r.excerpt,
      }));
    return { total, items };
  }

  // 답변마다 참고로 넣은 기억 id 묶음 (빈 것 제외) — 참고한 답변 수·함께 쓰인 기억
  injectedSets(): string[][] {
    return this.db
      .query<{ ids: string }, []>("SELECT memory_ids AS ids FROM messages WHERE memory_ids != '[]'")
      .all()
      .map((r) => {
        try {
          const v: unknown = JSON.parse(r.ids);
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        } catch {
          return [];
        }
      });
  }

  // 원문이 바뀌면 영어본은 비운다 (다시 정규화될 때까지 원문을 주입)
  update(id: string, input: MemoryInput): Memory | null {
    const cur = this.get(id);
    if (!cur) return null;
    const en = input.content !== cur.content && input.contentEn === cur.contentEn ? "" : input.contentEn;
    this.db
      .query(
        `UPDATE memories SET scope = $scope, kind = $kind, content = $content, content_en = $en, importance = $importance,
         valid_until = $valid, updated_at = $now WHERE id = $id`,
      )
      .run({
        id,
        scope: input.scope,
        kind: input.kind,
        content: input.content,
        en,
        importance: input.importance,
        valid: input.validUntil,
        now: Date.now(),
      });
    this.onChange();
    return this.get(id);
  }

  setEnglish(id: string, contentEn: string) {
    this.db.query("UPDATE memories SET content_en = $en WHERE id = $id").run({ id, en: contentEn });
  }

  touch(id: string, importance: number) {
    this.db
      .query("UPDATE memories SET importance = MAX(importance, $importance), updated_at = $now WHERE id = $id")
      .run({ id, importance, now: Date.now() });
  }

  supersede(oldId: string, newId: string) {
    this.db.query("UPDATE memories SET superseded_by = $new WHERE id = $old").run({ old: oldId, new: newId });
  }

  markUsed(ids: string[]) {
    const q = this.db.query("UPDATE memories SET last_used_at = $now WHERE id = $id");
    const now = Date.now();
    for (const id of ids) q.run({ id, now });
  }

  delete(id: string): boolean {
    const changes = this.db.query("DELETE FROM memories WHERE id = $id").run({ id }).changes;
    // 이 기억을 대체 대상으로 가리키던 이력은 다시 살아나지 않게 그대로 둔다
    if (changes) this.onChange();
    return changes > 0;
  }

  // 영어본이 없는 활성 기억 (정규화 대기)
  staleEnglish(limit: number): Memory[] {
    return this.db
      .query<MemoryRow, { limit: number }>(
        "SELECT * FROM memories WHERE content_en = '' AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT $limit",
      )
      .all({ limit })
      .map(toMemory);
  }

  // ---- 검색 ----

  private activeFilter(scopes: string[]) {
    const params: Record<string, string | number> = { now: Date.now() };
    const names = scopes.map((s, i) => {
      params[`s${i}`] = s;
      return `$s${i}`;
    });
    const sql = `m.scope IN (${names.join(", ") || "''"}) AND m.superseded_by IS NULL
      AND (m.valid_until IS NULL OR m.valid_until > $now)`;
    return { sql, params };
  }

  private ftsIds(table: "memories_fts" | "memories_tri", match: string, scopes: string[]): string[] {
    if (!match) return [];
    const f = this.activeFilter(scopes);
    try {
      return this.db
        .query<{ id: string }, Record<string, string | number>>(
          `SELECT m.id FROM ${table} f JOIN memories m ON m.seq = f.rowid
           WHERE ${table} MATCH $match AND ${f.sql} ORDER BY bm25(${table}) LIMIT ${PER_SIGNAL}`,
        )
        .all({ ...f.params, match })
        .map((r) => r.id);
    } catch (err) {
      console.warn(`[memory] ${table} 검색 오류`, err);
      return [];
    }
  }

  private likeIds(terms: string[], scopes: string[]): string[] {
    if (terms.length === 0) return [];
    const f = this.activeFilter(scopes);
    const params: Record<string, string | number> = { ...f.params };
    const ors = terms.map((t, i) => {
      params[`t${i}`] = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return `m.content LIKE $t${i} ESCAPE '\\'`;
    });
    return this.db
      .query<{ id: string }, Record<string, string | number>>(
        `SELECT m.id FROM memories m WHERE (${ors.join(" OR ")}) AND ${f.sql}
         ORDER BY m.importance DESC, m.updated_at DESC LIMIT ${PER_SIGNAL}`,
      )
      .all(params)
      .map((r) => r.id);
  }

  // 키워드 검색 (활성 기억만). 결과는 점수 순. opt 는 평가(memory:eval)용 변형 — 기본값이 운영 설정
  search(query: string, scopes: string[], limit: number, opt: SearchOptions = {}): Memory[] {
    return this.searchIds(query, scopes, limit, opt)
      .map((id) => this.get(id))
      .filter((m): m is Memory => m !== null);
  }

  searchIds(query: string, scopes: string[], limit: number, opt: SearchOptions = {}): string[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const signals = new Set(opt.signals ?? ALL_SIGNALS);
    const field = opt.field ?? "both";
    // FTS5 열 필터: 원문·영어본 중 하나만 볼 때
    const scoped = (expr: string) => (expr && field !== "both" ? `{${field}} : (${expr})` : expr);
    const lists: string[][] = [];
    if (signals.has("prefix")) {
      // unicode61 접두: "커피*" 는 "커피를" 에 맞는다. 한글은 조사·어미를 뗀 어간도 (hangulStems)
      const prefix = new Set<string>();
      for (const t of terms) for (const s of hangulStems(t)) prefix.add(s);
      lists.push(this.ftsIds("memories_fts", scoped([...prefix].map((t) => `${quote(t)}*`).join(" OR ")), scopes));
    }
    if (signals.has("trigram"))
      lists.push(
        this.ftsIds(
          "memories_tri",
          scoped(
            terms
              .filter((t) => [...t].length >= 3)
              .map(quote)
              .join(" OR "),
          ),
          scopes,
        ),
      );
    // trigram 은 3자 미만을 못 찾는다 → 2자 한글은 원문에서 부분 일치로
    if (signals.has("like2") && field !== "content_en")
      lists.push(
        this.likeIds(
          terms.filter((t) => HANGUL.test(t) && [...t].length === 2),
          scopes,
        ),
      );
    return rrf(lists).slice(0, limit);
  }

  // 활성 기억 id (대체·만료 제외) — 벡터 검색 후보
  activeIds(scopes: string[]): string[] {
    const f = this.activeFilter(scopes);
    return this.db
      .query<{ id: string }, Record<string, string | number>>(`SELECT m.id FROM memories m WHERE ${f.sql}`)
      .all(f.params)
      .map((r) => r.id);
  }

  // 중요도·최근 순 활성 기억 (검색어 없는 목록, 주입 빈자리 채우기)
  top(scopes: string[], limit: number): Memory[] {
    const f = this.activeFilter(scopes);
    return this.db
      .query<MemoryRow, Record<string, string | number>>(
        `SELECT m.* FROM memories m WHERE ${f.sql} ORDER BY m.importance DESC, m.updated_at DESC LIMIT ${limit}`,
      )
      .all(f.params)
      .map(toMemory);
  }

  // 이 방의 대화에서 나온 활성 기억 (토론·협업에 호출한 대화의 기억을 넘길 때)
  fromRoom(roomId: string, scopes: string[], limit: number): Memory[] {
    const f = this.activeFilter(scopes);
    return this.db
      .query<MemoryRow, Record<string, string | number>>(
        `SELECT m.* FROM memories m WHERE m.source_room_id = $room AND ${f.sql}
         ORDER BY m.importance DESC, m.updated_at DESC LIMIT ${limit}`,
      )
      .all({ ...f.params, room: roomId })
      .map(toMemory);
  }

  // 항상 넣는 핵심 기억: 중요도 4 이상
  core(scopes: string[], limit: number): Memory[] {
    const f = this.activeFilter(scopes);
    return this.db
      .query<MemoryRow, Record<string, string | number>>(
        `SELECT m.* FROM memories m WHERE m.importance >= 4 AND ${f.sql}
         ORDER BY m.importance DESC, m.updated_at DESC LIMIT ${limit}`,
      )
      .all(f.params)
      .map(toMemory);
  }

  // 같은 범위의 활성 기억 중 내용이 같은 것
  findDuplicate(scope: string, content: string, contentEn: string): Memory | null {
    const keys = [normalizeForDedupe(content), normalizeForDedupe(contentEn)].filter(Boolean);
    for (const m of this.list({ scope }))
      if (
        keys.includes(normalizeForDedupe(m.content)) ||
        (m.contentEn && keys.includes(normalizeForDedupe(m.contentEn)))
      )
        return m;
    return null;
  }
}
