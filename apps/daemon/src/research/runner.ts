// 리서치 실행기 (P11b): 앱이 단계를 정해 진행한다 (사용자 결정 2026-10-30)
//   검색어 → 검색(web_search 만) → 페이지 읽기·요약 → 링크 따라가기(깊이·페이지 상한) → 글쓰기 → 저장(앱)
// 웹 내용은 도구 없는 요청에만 데이터(펜스)로 들어간다 — 페이지 속 지시가 쓰기·도구를 일으킬 수 없다.
// 저장은 모델 도구가 아니라 이 실행기가 직접 한다 (메모 또는 작업 폴더 파일, 되돌리기 가능).
// 복수 에이전트 (P12b): 한 번 실행 = 같은 batch 의 실행 여러 개. 에이전트는 동시에 돌고, LLM 직렬화와 읽기 동시성·도메인 간격은
// 전역으로 그대로 지킨다. 한 에이전트가 실패해도 나머지는 계속한다
// 리서치는 대화방 밖에서 돌아 웹 내용이 대화 이력·장기 기억에 들어가지 않는다
import {
  type Agent,
  type Research,
  type ResearchEvent,
  type ResearchMessage,
  type ResearchPage,
  type ResearchRun,
  researchRequests,
  type ServerEvent,
  type Settings,
} from "@proprix/shared";
import { type AiRequest, citationsOf } from "@proprix/siwc";
import type { AgentStore } from "../agents/store";
import type { StreamResult } from "../auth/account";
import { buildInstructions, fence } from "../context/instructions";
import type { LlmBackend } from "../context/llm-backend";
import { BUDGET_EXCEEDED, type LlmGate } from "../llm/gate";
import { pickModel } from "../llm/model";
import { localDate } from "../proactive/time";
import { type FileChangeStore, sha256, type Workspace } from "../tools/files";
import type { NoteStore } from "../tools/notes";
import type { PageResult, ReadContext } from "./browser";
import { domainMatches, unsafeLink } from "./policy";
import {
  answerInput,
  mergeArticlesInput,
  planQueriesPrompt,
  READ_PAGE_INSTRUCTIONS,
  readPageInput,
  SEARCH_INSTRUCTIONS,
  writeArticleInput,
} from "./prompts";
import type { ResearchStore } from "./store";

export interface PageSource {
  readonly available: boolean;
  read(url: string, signal?: AbortSignal, ctx?: ReadContext): Promise<PageResult>;
}

export interface ResearchDeps {
  store: ResearchStore;
  llm: LlmBackend;
  gate: LlmGate;
  reader: PageSource;
  agents: AgentStore;
  notes: NoteStore;
  changes: FileChangeStore | null;
  workspaceOf: (roomId: string) => Workspace | undefined;
  settings: () => Settings;
  lastModel: () => string;
  emit: (e: ServerEvent) => void;
  now?: () => number;
}

export type StartError = "not_found" | "running" | "no_browser" | "no_model" | "no_agent" | "budget" | "paused";
export type ConverseError = "not_found" | "running" | "no_model" | "no_agent" | "budget" | "paused" | "no_result";

const LINKS_SHOWN = 40;
const NOTE_BODY_MAX = 20_000;

// 모델 답에서 JSON 객체 하나 (```json 펜스·앞뒤 말 허용)
export function parseJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const inDomains = (url: string, domains: readonly string[]) => {
  if (domains.length === 0) return true;
  try {
    return domainMatches(new URL(url).hostname, domains); // 같은 판정: 도메인이거나 그 하위
  } catch {
    return false;
  }
};

// 파일 이름에 날짜를 붙인다 (반복 실행이 앞 결과를 덮지 않게): notes/review.md → notes/review-2026-10-30.md
// 복수 에이전트면 이름도 붙인다: notes/review-평론가-2026-10-30.md
export function datedPath(path: string, t: number, label = ""): string {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(path);
  const name = label ? `-${label.replace(/[\\/:*?"<>|\s]+/g, "_")}` : "";
  return `${m?.[1] ?? path}${name}-${localDate(t)}${m?.[2] ?? ".md"}`;
}

// 한 번 실행의 공유 상태: 아직 남은 글 수만큼 예산을 남겨 둔다
interface Batch {
  pendingWrites: number;
  multi: boolean;
  continuing: boolean; // 이어서 조사: 지난 글을 바탕으로 같은 글을 갱신
}

// 조사 한 번의 문맥
interface Collecting {
  r: Research;
  runId: string;
  agent: Agent;
  seenAs: string | undefined;
  batch: Batch;
  signal: AbortSignal;
  skipSeen: boolean;
}

interface ReadItem {
  url: string;
  depth: number;
  start?: boolean;
}

// 읽을 주소 목록: 같은 주소는 한 번만, 읽은 적 있거나 도메인 밖이면 넣지 않는다
class ReadQueue {
  readonly items: ReadItem[] = [];
  private readonly queued = new Set<string>();

  constructor(
    private readonly seen: ReadonlySet<string>,
    private readonly domains: readonly string[],
  ) {}

  push(url: string, depth: number, start = false): boolean {
    const u = url.split("#")[0] ?? url;
    // 시작 주소는 목록 페이지일 수 있어 반복 실행에서도 다시 읽는다
    if (this.queued.has(u) || (!start && this.seen.has(u)) || !inDomains(u, this.domains)) return false;
    this.queued.add(u);
    this.items.push({ url: u, depth, start });
    return true;
  }
}

class Stop extends Error {
  constructor(readonly reason: "budget" | "paused" | "cancelled") {
    super(reason);
  }
}

export class ResearchRunner {
  private readonly running = new Map<string, AbortController>(); // researchId → 중지
  private readonly asking = new Map<string, AbortController>(); // researchId → 답 쓰는 중 (P12d)
  private readonly active = new Set<Promise<void>>(); // 진행 중인 실행·답 (cancelAll 이 끝나길 기다린다)

  constructor(private readonly d: ResearchDeps) {}

  private get now() {
    return this.d.now ?? Date.now;
  }

  isRunning(researchId: string): boolean {
    return this.running.has(researchId);
  }

  private model(): string {
    return pickModel(this.d.settings(), () => this.d.lastModel());
  }

  /** 실행을 시작한다 (끝까지 기다리려면 done). skipSeen: 예전에 읽은 주소를 건너뛴다 (반복 예약) */
  start(
    researchId: string,
    opt: { skipSeen?: boolean; extra?: string; continue?: boolean } = {},
  ): { run: ResearchRun; done: Promise<void> } | StartError {
    const saved = this.d.store.get(researchId);
    if (!saved) return "not_found";
    // 추가 지시 (P12d): 이번 실행에만 덧붙인다
    const r = opt.extra ? { ...saved, instruction: [saved.instruction, opt.extra].filter(Boolean).join("\n") } : saved;
    if (this.running.has(researchId)) return "running";
    if (!this.d.reader.available) return "no_browser";
    if (!this.model()) return "no_model";
    const agents = r.agentIds.map((id) => this.d.agents.agent(id)).filter((a): a is Agent => !!a);
    if (agents.length === 0) return "no_agent";
    if (this.d.gate.status().paused) return "paused";
    const left = this.d.gate.remaining("research");
    // 최소한: 페이지 3개 안팎을 읽고 쓸 만큼 (전체 추정의 페이지 수를 3으로 본 값)
    if (left !== null && left < researchRequests({ queries: r.scope.queries, maxPages: 3 }, agents.length, r.mode))
      return "budget";
    const ctrl = new AbortController();
    this.running.set(researchId, ctrl);
    const batchId = crypto.randomUUID();
    const make = (agent: Agent, role: ResearchRun["role"]) => {
      const run = this.d.store.createRun(researchId, { batchId, agentId: agent.id, role });
      this.emitRun(run);
      return run;
    };
    const first = agents[0] as Agent;
    const multi = agents.length > 1;
    const merged = r.mode === "merged" && multi;
    const shared = r.mode === "shared" && multi;
    const collector = shared ? make(first, "collect") : null;
    const runs = agents.map((a) => ({ agent: a, run: make(a, shared ? "write" : "full") }));
    const merge = merged ? make(first, "merge") : null;
    const batch: Batch = { pendingWrites: agents.length + (merged ? 1 : 0), multi, continuing: !!opt.continue };
    const signal = ctrl.signal;
    const skipSeen = !!opt.skipSeen || !!opt.continue;
    const done = (async () => {
      if (collector) {
        await this.guard(collector.id, () => this.sharedRuns(r, collector, first, runs, batch, signal, skipSeen));
        return;
      }
      await Promise.all(
        runs.map(({ agent, run }) =>
          this.guard(run.id, async () => {
            if (batch.continuing) this.log(r, run.id, "query", "지난 글을 이어서 조사합니다");
            const c = await this.collect(r, run.id, agent, agent.id, batch, signal, skipSeen);
            await this.conclude(r, run.id, agent, c.pages, c.stopped, batch, signal, skipSeen);
          }),
        ),
      );
      if (merge)
        await this.guard(merge.id, () =>
          this.mergeArticles(
            r,
            merge.id,
            first,
            runs.map((x) => x.run.id),
            signal,
            batch.continuing,
          ),
        );
    })().finally(() => this.running.delete(researchId));
    this.track(done);
    return { run: collector ?? (runs[0] as { run: ResearchRun }).run, done };
  }

  // 한 실행의 예외가 나머지를 멈추지 않게
  private async guard(runId: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      console.error("[research] 실행 예외", err);
      this.finish(runId, { status: "failed", error: "internal" });
    }
  }

  // shared: 첫 에이전트가 한 번 모으고, 글은 에이전트마다
  private async sharedRuns(
    r: Research,
    collector: ResearchRun,
    first: Agent,
    runs: { agent: Agent; run: ResearchRun }[],
    batch: Batch,
    signal: AbortSignal,
    skipSeen: boolean,
  ) {
    const c = await this.collect(r, collector.id, first, undefined, batch, signal, skipSeen);
    const relevant = c.pages.some((p) => p.status === "ok" && p.relevant);
    this.finish(collector.id, {
      status:
        c.stopped?.reason === "cancelled"
          ? "cancelled"
          : c.stopped
            ? "partial"
            : !relevant && skipSeen
              ? "skipped"
              : "done",
      error: c.stopped?.reason ?? "",
    });
    await Promise.all(
      runs.map(({ agent, run }) =>
        this.guard(run.id, () => this.conclude(r, run.id, agent, c.pages, c.stopped, batch, signal, skipSeen)),
      ),
    );
  }

  // merged: 각자의 글을 도구 없는 요청에 데이터로 넣어 하나로 합친다
  private async mergeArticles(
    r: Research,
    runId: string,
    agent: Agent,
    sourceRuns: string[],
    signal: AbortSignal,
    continuing: boolean,
  ) {
    if (signal.aborted) return this.finish(runId, { status: "cancelled", error: "cancelled" });
    const saved = (x: ResearchRun | null) => !!x && !!x.result && !!(x.noteId || x.changeId);
    const articles = sourceRuns
      .map((id) => {
        const x = this.d.store.run(id);
        // 이어서 조사에서 새 것이 없던 에이전트는 지난 글로 합친다
        return saved(x) ? x : continuing && x ? this.d.store.latestArticle(r.id, x.agentId) : null;
      })
      .filter((x): x is ResearchRun => saved(x));
    if (articles.length < 2) return this.finish(runId, { status: "skipped", result: "합칠 글이 모자랍니다." });
    try {
      this.patch(runId, { stage: "write" });
      this.log(r, runId, "write", `합친 글 쓰는 중 (글 ${articles.length}개)`);
      const body = articles
        .map((a) =>
          fence("article", a.result, ` by="${(this.d.agents.agent(a.agentId)?.name ?? "").replace(/[<>"]/g, "")}"`),
        )
        .join("\n");
      const w = await this.ask(
        runId,
        {
          instructions: this.writerInstructions(agent),
          turns: [
            {
              role: "user",
              text: mergeArticlesInput(r, body),
            },
          ],
        },
        signal,
        agent.model || this.model(),
        0,
      );
      if (w.result.outcome !== "completed" || !w.text.trim())
        return this.finish(runId, { status: "failed", error: w.result.code || w.result.outcome });
      const prev = continuing ? this.d.store.latestArticle(r.id, agent.id, true) : null;
      this.saveResult(r, runId, agent, `${w.text.trim()}\n`, null, "합친 글", prev);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      if (err.reason === "cancelled") return this.finish(runId, { status: "cancelled", error: "cancelled" });
      this.log(r, runId, "error", `합친 글을 쓰지 못함 (${err.reason})`);
      this.finish(runId, { status: "partial", error: err.reason });
    }
  }

  private writerInstructions(agent: Agent): string {
    return buildInstructions({
      agentName: agent.name,
      role: agent.role,
      persona: this.d.agents.persona(agent.personaId)?.body ?? "",
      summary: "",
      hasTools: false,
      userInstructions: this.d.settings().instructions,
    });
  }

  cancel(researchId: string): boolean {
    const c = this.running.get(researchId) ?? this.asking.get(researchId);
    c?.abort();
    return !!c;
  }

  private track(done: Promise<void>) {
    this.active.add(done);
    void done.catch(() => {}).finally(() => this.active.delete(done));
  }

  // 모두 멈추고 결과 저장까지 기다린다 (로그아웃·종료 전). 브라우저가 응답하지 않아도 종료가 막히지 않게 시간 제한
  async cancelAll(waitMs = 5000) {
    for (const c of this.running.values()) c.abort();
    for (const c of this.asking.values()) c.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.active),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  // ---- 결과로 이어서 대화 (P12d) ----

  private emitMessage(message: ResearchMessage) {
    this.d.emit({ type: "research_message", message });
  }

  /** 질문을 기록하고 답을 쓰기 시작한다. 도구 없는 요청이고, 결과 글·요약은 데이터(펜스)로만 들어간다 */
  converse(
    researchId: string,
    text: string,
    agentId: string,
  ): { answer: ResearchMessage; done: Promise<void> } | ConverseError {
    const r = this.d.store.get(researchId);
    if (!r) return "not_found";
    if (this.running.has(researchId) || this.asking.has(researchId)) return "running";
    if (!this.model()) return "no_model";
    const agent = this.d.agents.agent(agentId);
    if (!agent || !r.agentIds.includes(agentId)) return "no_agent";
    if (this.d.gate.status().paused) return "paused";
    const left = this.d.gate.remaining("research");
    if (left !== null && left < 1) return "budget";
    const { articles, pages } = this.d.store.latestSources(researchId);
    if (articles.length === 0) return "no_result";
    const history = this.d.store
      .messages(researchId, 12)
      .filter((m) => m.kind !== "instruction" && m.status === "done")
      .map((m) => `${m.role === "user" ? "User" : (this.d.agents.agent(m.agentId)?.name ?? "Agent")}: ${m.text}`)
      .join("\n\n");
    this.emitMessage(
      this.d.store.addMessage({ researchId, role: "user", kind: "question", agentId, text, status: "done" }),
    );
    const answer = this.d.store.addMessage({
      researchId,
      role: "agent",
      kind: "answer",
      agentId,
      text: "",
      status: "streaming",
    });
    this.emitMessage(answer);
    const ctrl = new AbortController();
    this.asking.set(researchId, ctrl);
    const done = this.answer(r, agent, answer, text, articles, pages, history, ctrl.signal).finally(() =>
      this.asking.delete(researchId),
    );
    this.track(done);
    return { answer, done };
  }

  private async answer(
    r: Research,
    agent: Agent,
    answer: ResearchMessage,
    question: string,
    articles: ResearchRun[],
    pages: ResearchPage[],
    history: string,
    signal: AbortSignal,
  ) {
    let text = "";
    let last = 0;
    const put = (status: ResearchMessage["status"], t = text) => {
      this.d.store.updateMessage(answer.id, t, status);
      this.emitMessage({ ...answer, text: t, status });
    };
    const model = agent.model || this.model();
    try {
      const result = await this.d.gate.run("research", model, () =>
        this.d.llm.stream(
          {
            model,
            instructions: this.writerInstructions(agent),
            turns: [
              {
                role: "user",
                text: answerInput(r, articles, pages, history, question),
              },
            ],
          },
          {
            signal,
            onDelta: (t) => {
              text += t;
              const now = this.now();
              if (now - last > 200) {
                last = now;
                this.emitMessage({ ...answer, text, status: "streaming" });
              }
            },
          },
        ),
      );
      if (signal.aborted) return put(text ? "done" : "failed", text || "멈췄습니다.");
      if (result.outcome !== "completed" || !text.trim()) {
        const why = result.code === BUDGET_EXCEEDED ? "오늘 리서치 예산을 다 썼습니다." : "답을 받지 못했습니다.";
        return put("failed", text || why);
      }
      put("done");
    } catch (err) {
      console.error("[research] 대화 예외", err);
      put("failed", text || "답을 받지 못했습니다.");
    }
  }

  // ---- 진행 ----

  private emitRun(run: ResearchRun) {
    this.d.emit({ type: "research_run", run });
  }

  // 행동 로그: 저장하고 화면으로 바로 보낸다
  private log(r: { id: string }, runId: string, kind: ResearchEvent["kind"], text: string) {
    this.d.emit({ type: "research_event", researchId: r.id, event: this.d.store.addEvent(runId, kind, text) });
  }

  private patch(runId: string, p: Parameters<ResearchStore["updateRun"]>[1]): ResearchRun {
    const run = this.d.store.updateRun(runId, p);
    this.emitRun(run);
    return run;
  }

  private finish(runId: string, p: Parameters<ResearchStore["updateRun"]>[1]) {
    this.patch(runId, { stage: "", ...p, finishedAt: this.now() });
    this.d.emit({ type: "research" });
  }

  // 도구 없는 요청 (tools 를 주지 않는다). web 은 web_search 만 주는 검색 단계
  private async ask(
    runId: string,
    req: Omit<AiRequest, "model">,
    signal: AbortSignal,
    model = this.model(),
    reserve = 1, // 글쓰기용으로 남겨 둘 요청 수 (모은 것까지로 글을 쓸 수 있게)
  ): Promise<{ text: string; result: StreamResult }> {
    if (signal.aborted) throw new Stop("cancelled");
    const left = this.d.gate.remaining("research");
    if (left !== null && left <= reserve) throw new Stop("budget");
    let text = "";
    const result = await this.d.gate.run("research", model, () =>
      this.d.llm.stream({ ...req, model }, { signal, onDelta: (t) => (text += t) }),
    );
    const cur = this.d.store.run(runId);
    if (cur) this.patch(runId, { requests: cur.requests + 1 });
    if (signal.aborted) throw new Stop("cancelled");
    if (result.code === BUDGET_EXCEEDED) throw new Stop("budget");
    if (result.recovery === "usage_limit") throw new Stop("paused");
    return { text, result };
  }

  // 조사: 검색어 → 검색 → 읽기·요약 → 링크. seenAs 는 이미 읽은 주소를 판단할 에이전트 (shared 는 리서치 전체)
  private async collect(
    r: Research,
    runId: string,
    agent: Agent,
    seenAs: string | undefined,
    batch: Batch,
    signal: AbortSignal,
    skipSeen: boolean,
  ): Promise<{ pages: ResearchPage[]; stopped: Stop | null }> {
    const c: Collecting = { r, runId, agent, seenAs, batch, signal, skipSeen };
    const pages: ResearchPage[] = [];
    let stopped: Stop | null = null;
    try {
      const queries = await this.planQueries(c);
      const queue = await this.searchSources(c, queries);

      // 3. 읽기·요약, 링크 따라가기
      this.patch(runId, { stage: "read" });
      const maxTries = r.scope.maxPages * 2; // 막힌 페이지까지 셈 (네트워크 보호)
      let tries = 0;
      while (
        queue.items.length &&
        pages.filter((p) => p.status === "ok").length < r.scope.maxPages &&
        tries < maxTries
      ) {
        const item = queue.items.shift();
        if (!item) break;
        tries++;
        pages.push(await this.readPage(c, item, queue));
        this.patch(runId, { pages: pages.length });
      }
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      stopped = err;
    }

    return { pages, stopped };
  }

  // 1. 검색어
  private async planQueries({ r, runId, agent, seenAs, batch, signal }: Collecting): Promise<string[]> {
    const prior = batch.continuing ? this.d.store.latestArticle(r.id, agent.id) : null;
    this.patch(runId, { stage: "queries" });
    const researcher = seenAs && batch.multi ? `${agent.name}: ${agent.role}` : null;
    const prompt = planQueriesPrompt(r, researcher, prior?.result ?? null);
    const q = await this.ask(
      runId,
      { instructions: prompt.instructions, turns: [{ role: "user", text: prompt.text }] },
      signal,
      this.model(),
      batch.pendingWrites,
    );
    const parsed = parseJson<{ queries?: unknown }>(q.text)?.queries;
    const queries = (Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [])
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, r.scope.queries);
    if (queries.length === 0) queries.push(r.goal.slice(0, 200));
    this.log(r, runId, "query", `검색어 ${queries.length}개: ${queries.join(" · ")}`);
    return queries;
  }

  // 2. 검색 (web_search 만): 출처 주소를 모은다
  private async searchSources(
    { r, runId, seenAs, batch, signal, skipSeen }: Collecting,
    queries: string[],
  ): Promise<ReadQueue> {
    this.patch(runId, { stage: "search" });
    const queue = new ReadQueue(skipSeen ? this.d.store.seenUrls(r.id, seenAs) : new Set<string>(), r.scope.domains);
    for (const u of r.scope.startUrls) queue.push(u, 0, true);
    for (const query of queries) {
      const s = await this.ask(
        runId,
        {
          instructions: SEARCH_INSTRUCTIONS,
          turns: [{ role: "user", text: query }],
          tools: [{ type: "web_search" }],
        },
        signal,
        this.model(),
        batch.pendingWrites,
      );
      const found = citationsOf(s.result.items);
      for (const c of found) queue.push(c.url, 0);
      this.log(r, runId, "search", `검색 '${query}' → 출처 ${found.length}개`);
    }
    return queue;
  }

  // 페이지 하나를 읽고 요약해 기록한다. 따라갈 링크는 queue 에 넣는다
  private async readPage(
    { r, runId, agent, seenAs, batch, signal, skipSeen }: Collecting,
    item: ReadItem,
    queue: ReadQueue,
  ): Promise<ResearchPage> {
    if (signal.aborted) throw new Stop("cancelled");
    this.log(r, runId, "read", `읽는 중: ${item.url}`);
    let page: PageResult;
    try {
      page = await this.d.reader.read(item.url, signal, {
        agentId: agent.id,
        runKey: runId,
        onLogin: (text) => this.log(r, runId, "login", text),
      });
    } catch (err) {
      if (signal.aborted) throw new Stop("cancelled");
      const reason = err instanceof Error ? err.message : String(err);
      page = {
        url: item.url,
        finalUrl: item.url,
        status: "error",
        httpStatus: 0,
        reason,
        title: "",
        byline: "",
        published: "",
        text: "",
        links: [],
      };
    }
    if (signal.aborted) throw new Stop("cancelled");
    let summary = "";
    let quotes: string[] = [];
    let relevant = false;
    const contentHash = page.status === "ok" ? sha256(page.text) : "";
    // 반복 실행에서 시작 주소의 내용이 그대로면 요약하지 않고 출처로도 세지 않는다
    const unchanged =
      skipSeen && item.start && contentHash !== "" && this.d.store.lastHash(r.id, item.url, seenAs) === contentHash;
    if (unchanged) this.log(r, runId, "skip", `바뀐 것 없음: ${item.url}`);
    else if (page.status !== "ok") this.log(r, runId, "skip", `건너뜀 (${page.status}): ${item.url}`);
    if (page.status === "ok" && page.text.trim() && !unchanged) {
      // 로그인 상태에서는 로그아웃·탈퇴·결제처럼 보이는 링크를 따라가지 않는다
      const links = page.links
        .filter((l) => inDomains(l.url, r.scope.domains) && !(page.session && unsafeLink(l.url, l.text)))
        .slice(0, LINKS_SHOWN);
      const a = await this.ask(
        runId,
        {
          instructions: READ_PAGE_INSTRUCTIONS,
          turns: [{ role: "user", text: readPageInput(r.goal, page, links) }],
        },
        signal,
        this.model(),
        batch.pendingWrites,
      );
      const j = parseJson<{ relevant?: unknown; summary?: unknown; quotes?: unknown; follow?: unknown }>(a.text);
      relevant = j?.relevant === true;
      summary = typeof j?.summary === "string" ? j.summary.slice(0, 2000) : "";
      quotes = Array.isArray(j?.quotes)
        ? j.quotes
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.split(/\s+/).slice(0, 25).join(" "))
            .slice(0, 2)
        : [];
      if (relevant && item.depth < r.scope.depth && Array.isArray(j?.follow))
        for (const n of j.follow.slice(0, 3)) {
          const l = typeof n === "number" ? links[n - 1] : undefined;
          if (l && queue.push(l.url, item.depth + 1)) this.log(r, runId, "follow", `링크 따라감: ${l.url}`);
        }
      this.log(
        r,
        runId,
        relevant ? "read" : "skip",
        `${relevant ? "관련 있음" : "관련 없음"}: ${page.title || item.url}`,
      );
    }
    return this.d.store.addPage({
      runId,
      researchId: r.id,
      agentId: agent.id,
      url: item.url,
      title: page.title || item.url,
      depth: item.depth,
      status: page.status,
      relevant,
      summary,
      quotes,
      contentHash,
    });
  }

  // 글쓰기·저장: 모은 페이지로 이 에이전트의 글을 쓴다
  private async conclude(
    r: Research,
    runId: string,
    agent: Agent,
    pages: ResearchPage[],
    stopped: Stop | null,
    batch: Batch,
    signal: AbortSignal,
    skipSeen: boolean,
  ) {
    batch.pendingWrites = Math.max(0, batch.pendingWrites - 1);
    if (stopped?.reason === "cancelled" || signal.aborted)
      return this.finish(runId, { status: "cancelled", error: "cancelled" });
    if (stopped) this.log(r, runId, "error", `도중에 멈춤 (${stopped.reason}): 모은 것까지로 씁니다`);
    const fresh = pages.filter((p) => p.status === "ok" && p.relevant);
    const prev = batch.continuing ? this.d.store.latestArticle(r.id, agent.id) : null;
    // 이어서 조사: 지난 글의 출처까지 한 목록으로 번호를 매긴다
    const sources = prev
      ? [...fresh, ...this.d.store.relevantPages(r.id, agent.id).filter((p) => !fresh.some((n) => n.url === p.url))]
      : fresh;
    if (fresh.length === 0) {
      // 반복 실행에서 새로 읽은 것이 없으면 글을 쓰지 않는다 (예산 절약)
      return this.finish(runId, {
        status: stopped ? "partial" : skipSeen ? "skipped" : "done",
        error: stopped ? stopped.reason : "",
        result: skipSeen ? "새로 읽은 관련 페이지가 없습니다." : "관련 있는 페이지를 찾지 못했습니다.",
      });
    }

    // 4. 글쓰기: 에이전트의 역할·페르소나로, 도구 없이. 조사 단계가 글 수만큼 예산을 남겨 두어 모은 것까지로 쓴다
    // (그래도 남은 예산이 0 이면 시도하지 않고 partial)
    let result = "";
    try {
      this.patch(runId, { stage: "write" });
      this.log(r, runId, "write", `글 쓰는 중 (출처 ${sources.length}개)`);
      const list = sources
        .map(
          (p, i) =>
            `[${i + 1}] ${p.title} (${p.url})\n${p.summary}${p.quotes.length ? `\n인용: ${p.quotes.map((q) => `"${q}"`).join(" / ")}` : ""}`,
        )
        .join("\n\n");
      const w = await this.ask(
        runId,
        {
          instructions: this.writerInstructions(agent),
          turns: [
            {
              role: "user",
              text: writeArticleInput(r, list, prev?.result ?? null),
            },
          ],
        },
        signal,
        agent.model || this.model(),
        0,
      );
      if (w.result.outcome !== "completed" || !w.text.trim())
        return this.finish(runId, { status: "failed", error: w.result.code || w.result.outcome });
      result = `${w.text.trim()}\n\n---\n출처\n${sources.map((p, i) => `[${i + 1}] ${p.title} — ${p.url}`).join("\n")}\n`;
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      if (err.reason === "cancelled") return this.finish(runId, { status: "cancelled", error: "cancelled" });
      return this.finish(runId, { status: "partial", error: err.reason, result: "" });
    }

    this.saveResult(r, runId, agent, result, stopped, batch.multi ? agent.name : "", prev);
  }

  // 5. 저장 (앱이 직접): 메모 또는 작업 폴더 파일. 파일을 쓸 수 없으면 메모로. label: 복수 에이전트면 글 구분
  // prev: 이어서 조사면 그 글이 있던 메모·파일을 갱신한다 (없어졌으면 새로)
  private saveResult(
    r: Research,
    runId: string,
    agent: Agent,
    result: string,
    stopped: Stop | null,
    label: string,
    prev: ResearchRun | null = null,
  ) {
    this.patch(runId, { stage: "save", result });
    const at = this.now();
    const saved: { noteId?: string; changeId?: string; path?: string; error?: string } = {};
    if (r.output.target === "file") {
      const ws = this.d.workspaceOf(r.output.roomId);
      if (ws && this.d.changes) {
        const path = prev?.path || datedPath(r.output.path, at, label);
        try {
          const c = this.d.changes.save(ws, path, result, `research:${runId}`, r.output.roomId, true);
          if (c !== "exists") Object.assign(saved, { changeId: c.id, path });
        } catch (err) {
          saved.error = err instanceof Error ? err.message : String(err);
        }
      } else saved.error = "그 채팅에 작업 폴더가 없어 메모로 저장했습니다";
    }
    const updated =
      !saved.changeId && prev?.noteId
        ? this.d.notes.update(prev.noteId, { body: result.slice(0, NOTE_BODY_MAX) })
        : null;
    if (updated) saved.noteId = updated.id;
    else if (!saved.changeId) {
      const note = this.d.notes.create(
        {
          title: `${r.title}${label ? ` · ${label}` : ""} · ${localDate(at)}`.slice(0, 200),
          body: result.slice(0, NOTE_BODY_MAX),
        },
        agent.id,
      );
      saved.noteId = note.id;
    }
    this.log(
      r,
      runId,
      "save",
      saved.path ? `파일로 저장: ${saved.path}` : updated ? "메모를 새 내용으로 갱신" : "메모로 저장",
    );
    this.finish(runId, {
      status: stopped ? "partial" : "done",
      error: saved.error ?? (stopped ? stopped.reason : ""),
      noteId: saved.noteId ?? "",
      changeId: saved.changeId ?? "",
      path: saved.path ?? "",
      result,
    });
  }
}
