// daemon 구성 요소 연결 (main 과 e2e 테스트가 같이 쓴다)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { commandKey } from "@proprix/shared";
import { endpointsForBase, productionEndpoints } from "@proprix/siwc";
import { CharacterStore } from "./agents/character";
import { AgentStore } from "./agents/store";
import { EventHub } from "./api/http";
import { createRoutes } from "./api/routes";
import { type DaemonServer, startServer } from "./api/server";
import { VisualFrames } from "./api/visual-frames";
import { SiwcAccount } from "./auth/account";
import type { SecretStore } from "./auth/secret-store";
import { createSecretStore } from "./auth/secret-store";
import { ChatService } from "./chat/chat";
import { DEFAULT_LOUNGE_OPTIONS, type LoungeOptions, LoungeScheduler } from "./chat/lounge";
import { CommandStore } from "./commands/store";
import type { DaemonConfig } from "./config";
import { DEFAULT_SUMMARY_OPTIONS, type SummaryOptions, SummaryService } from "./context/summary";
import { LlmGate } from "./llm/gate";
import { DEFAULT_MCP_OPTIONS, McpManager } from "./mcp/manager";
import { McpStore } from "./mcp/store";
import { Embedder } from "./memory/embedding";
import { DEFAULT_MEMORY_OPTIONS, type MemoryOptions, MemoryService } from "./memory/service";
import { MemoryStore } from "./memory/store";
import { type EmbedLoader, VectorIndex } from "./memory/vectors";
import { ReminderStore } from "./proactive/reminders";
import { DEFAULT_PROACTIVE_OPTIONS, type ProactiveOptions, ProactiveScheduler } from "./proactive/scheduler";
import { SiteAccountStore } from "./research/accounts";
import { PageReader } from "./research/browser";
import { BrowserInstaller } from "./research/install";
import { ResearchRunner } from "./research/runner";
import { ResearchScheduler } from "./research/scheduler";
import { ResearchStore } from "./research/store";
import { Runners } from "./skills/runners";
import { SkillService } from "./skills/service";
import { BackupService } from "./storage/backup";
import { openDb } from "./storage/db";
import { importDevData } from "./storage/import";
import { applyPendingRestore } from "./storage/restore";
import { SettingsStore } from "./storage/settings";
import { DEFAULT_TASK_OPTIONS, TaskScheduler } from "./tasks/scheduler";
import { TaskStore } from "./tasks/store";
import { TeamStore } from "./teams/store";
import { ThemeStore } from "./themes/store";
import { AuditService } from "./tools/audit";
import { ApprovalBroker, ToolCallStore } from "./tools/calls";
import { FileChangeStore } from "./tools/files";
import { NoteStore } from "./tools/notes";
import { ToolRegistry } from "./tools/registry";
import { UpdateChecker } from "./update/check";

export interface App {
  api: DaemonServer;
  account: SiwcAccount;
  stop(): Promise<void>;
}

export interface AppOptions {
  secretStore?: SecretStore;
  retryBaseMs?: number;
  summary?: Partial<SummaryOptions>;
  memory?: Partial<MemoryOptions>;
  lounge?: Partial<LoungeOptions>;
  embedLoader?: EmbedLoader; // 테스트: 가짜 임베딩
  proactive?: Partial<ProactiveOptions>;
}

export function createApp(config: DaemonConfig, opts: AppOptions = {}): App {
  mkdirSync(config.dataDir, { recursive: true });
  if (config.importDir) importDevData(config.importDir, config.dataDir);
  applyPendingRestore(config.dataDir);
  const db = openDb(join(config.dataDir, "proprix.sqlite"));
  const hub = new EventHub();
  const emit = hub.emit.bind(hub);
  const account = new SiwcAccount({
    endpoints: config.siwcBase ? endpointsForBase(config.siwcBase) : productionEndpoints(),
    authDir: join(config.dataDir, "auth"),
    callbackPort: config.callbackPort,
    store: opts.secretStore,
    retryBaseMs: opts.retryBaseMs,
  });
  const settings = new SettingsStore(db);
  const gate = new LlmGate(
    db,
    (status) => emit({ type: "llm", status }),
    2,
    () => settings.all().budgets,
  );
  gate.onUsageAlert = (alert) => emit({ type: "usage_alert", alert });
  const agents = new AgentStore(db);
  const characters = new CharacterStore(join(config.dataDir, "characters"));
  const themes = new ThemeStore(join(config.dataDir, "themes"));
  agents.characterVersion = (id) => characters.version(id);
  const summaries = new SummaryService(db, account, gate, emit, (id) => agents.agent(id)?.name ?? "assistant", {
    ...DEFAULT_SUMMARY_OPTIONS,
    ...opts.summary,
  });
  const notes = new NoteStore(db, () => emit({ type: "notes" }));
  const commands = new CommandStore(db, () => emit({ type: "commands" }));
  const teams = new TeamStore(
    db,
    (id) => agents.agent(id) !== null,
    () => emit({ type: "teams" }),
  );
  // Skill: <dataDir>/skills. 이름은 / 명령과 한 이름 공간. 실행기는 처음에 한 번 점검 (화면에서 다시)
  const skills = new SkillService(db, join(config.dataDir, "skills"), new Runners(), () => emit({ type: "skills" }));
  skills.takenElsewhere = (key) => commands.nameTaken(key);
  commands.otherOwners.push((key) => skills.has(key));
  skills.onRemove = (key) => {
    agents.removeSkill(key, commandKey);
    emit({ type: "agents" });
  };
  void skills.runners.check();
  // MCP: 필요할 때 연결, 10분 쓰지 않으면 끊는다. env·헤더는 DPAPI 로 봉해 둔다
  const taskStore = new TaskStore(db, Date.now, () => emit({ type: "tasks" }));
  const mcpStore = new McpStore(db, undefined, () => emit({ type: "mcp" }));
  const mcp = new McpManager(mcpStore, () => emit({ type: "mcp" }), {
    ...DEFAULT_MCP_OPTIONS,
    clientVersion: config.version,
  });
  const memory = new MemoryService(
    db,
    new MemoryStore(db, () => {
      emit({ type: "memories" });
      void vectors.schedule();
    }),
    account,
    gate,
    agents,
    () => settings.all().model,
    emit,
    { ...DEFAULT_MEMORY_OPTIONS, ...opts.memory },
  );
  const reminders = new ReminderStore(db, () => emit({ type: "reminders" }));
  // 리서치 브라우저 (P11a): 처음 쓸 때 설정에서 내려받는다. 프로필은 실행마다 임시 폴더
  const browserInstaller = new BrowserInstaller(join(config.dataDir, "browser"), (status) =>
    emit({ type: "research_browser", status }),
  );
  const browserProfiles = join(config.dataDir, "browser-profiles");
  mkdirSync(browserProfiles, { recursive: true });
  // 에이전트별 사이트 계정 (P12c): 비밀번호·쿠키는 auth/site 아래 암호화 파일
  const siteAccounts = new SiteAccountStore(
    db,
    join(config.dataDir, "auth", "site"),
    (account) => emit({ type: "site_account", account }),
    { allowHttp: process.env.PROPRIX_RESEARCH_ALLOW_PRIVATE === "1" },
  );
  siteAccounts.prune();
  const pageReader = new PageReader({
    accounts: siteAccounts,
    exePath: () => browserInstaller.exePath(),
    profileRoot: browserProfiles,
    denyDomains: () => settings.all().research.denyDomains,
    // 개발 시험 전용: 로컬 시험 사이트를 읽게 한다 (모의 서버 확인)
    allowPrivate: process.env.PROPRIX_RESEARCH_ALLOW_PRIVATE === "1",
  });
  // 작업 폴더 파일 변경의 원본 보관함 (되돌리기). 30일·방당 500MB 를 넘으면 오래된 것부터 지운다
  const changes = new FileChangeStore(db, join(config.dataDir, "snapshots"), Date.now, (roomId) =>
    emit({ type: "file_changes", roomId }),
  );
  changes.prune();
  const pruneTimer = setInterval(() => changes.prune(), 6 * 60 * 60 * 1000);
  const audit = new AuditService(db, changes, notes, reminders);
  const tools = {
    registry: new ToolRegistry(notes, memory, reminders, Date.now, changes, skills, mcp, taskStore),
    calls: new ToolCallStore(db),
    approvals: new ApprovalBroker(),
    memory,
  };
  memory.loungeExtract = () => settings.all().lounge.extractMemories;
  memory.autoExtract = () => settings.all().memory.autoExtract;
  const chat = new ChatService(db, account, gate, agents, summaries, tools, emit);
  chat.globalInstructions = () => settings.all().instructions;
  chat.protectedDirs = () => [config.dataDir];
  chat.skills = skills;
  chat.mcpServersOf = (a) => a.mcpServers.filter((id) => mcpStore.get(id)?.enabled === 1);
  // 예약 작업: 허용 도구는 그 에이전트가 쓰는 쓰기 도구만, 명령 실행·skill 스크립트·task_* 는 안 됨
  taskStore.checks = {
    agentInRoom: (agentId, roomId) => chat.room(roomId)?.agentIds.includes(agentId) ?? false,
    toolError: (agentId, tool) => {
      const agent = agents.agent(agentId);
      if (!agent) return "없는 에이전트";
      const r = tools.registry;
      const info = r.get(tool);
      if (!info) return `없는 도구입니다: ${tool}`;
      if (r.alwaysConfirm(tool)) return `${info.title}: 명령 실행·Skill 스크립트는 예약 작업에서 허용할 수 없습니다`;
      if (tool.startsWith("task_")) return `${info.title}: 예약 작업 도구는 고를 수 없습니다`;
      if (info.kind !== "write") return `${info.title}: 읽기 도구는 고르지 않아도 됩니다`;
      const server = r.isMcpTool(tool) ? mcp.serverOf(tool) : null;
      if (!agent.tools.includes(tool) && !(server && agent.mcpServers.includes(server)))
        return `${info.title}: 이 에이전트가 쓰지 않는 도구입니다`;
      return "";
    },
  };
  const lounge = new LoungeScheduler(chat, () => settings.all(), { ...DEFAULT_LOUNGE_OPTIONS, ...opts.lounge });
  // 로컬 임베딩: 설정에서 켠 모델을 불러온다 (처음이면 내려받음). 실패하면 키워드 검색만
  const vectors = new VectorIndex(
    db,
    opts.embedLoader ?? ((m) => Embedder.load(m, join(config.dataDir, "models"))),
    (status) => emit({ type: "embedding", status }),
  );
  memory.vectors = vectors;
  void vectors.configure(settings.all().memory.embedding);
  const proactive = new ProactiveScheduler(db, chat, agents, reminders, gate, () => settings.all(), {
    ...DEFAULT_PROACTIVE_OPTIONS,
    ...opts.proactive,
  });
  const backup = new BackupService(db, join(config.dataDir, "backups"), () => settings.all().backup, Date.now, [
    join(config.dataDir, "characters"),
    join(config.dataDir, "themes"),
  ]);
  memory.resumePending();
  lounge.start();
  proactive.start();
  // 리서치 (P11b): 대화방 밖에서 단계별로 돌고, 결과는 앱이 메모·작업 폴더 파일로 저장한다
  const researchStore = new ResearchStore(
    db,
    (id) => agents.agent(id) !== null,
    () => emit({ type: "research" }),
  );
  researchStore.closeStale();
  const researchRunner = new ResearchRunner({
    store: researchStore,
    llm: account,
    gate,
    reader: pageReader,
    agents,
    notes,
    changes,
    workspaceOf: (roomId) => chat.workspaceOf(roomId),
    settings: () => settings.all(),
    lastModel: () => chat.lastModel(),
    emit,
  });
  const researchScheduler = new ResearchScheduler(researchStore, researchRunner, emit);
  researchScheduler.start();
  const taskScheduler = new TaskScheduler(taskStore, chat, gate, () => settings.all(), DEFAULT_TASK_OPTIONS);
  taskScheduler.start();
  backup.start();
  const visualFrames = new VisualFrames();
  const api = startServer(
    config,
    createRoutes({
      dataDir: config.dataDir,
      visualFrames,
      updates: new UpdateChecker(config.version),
      characters,
      themes,
      audit,
      research: {
        installer: browserInstaller,
        reader: pageReader,
        store: researchStore,
        runner: researchRunner,
        accounts: siteAccounts,
      },
      teams,
      changes,
      backup,
      account,
      gate,
      chat,
      agents,
      summaries,
      settings,
      notes,
      commands,
      skills,
      mcp,
      tasks: taskStore,
      taskScheduler,
      memory,
      tools: tools.registry,
      hub,
      lounge,
      vectors,
      reminders,
    }),
    hub,
    createSecretStore(join(config.dataDir, "auth", "web-sessions.bin")),
    visualFrames,
  );
  return {
    api,
    account,
    async stop() {
      account.cancelSignIn();
      memory.stop();
      vectors.stop();
      lounge.stop();
      proactive.stop();
      taskScheduler.stop();
      researchScheduler.stop();
      backup.stop();
      clearInterval(pruneTimer);
      await chat.cancelAll();
      await mcp.closeAll(); // stdio 서버 프로세스 트리까지
      browserInstaller.cancel();
      await researchRunner.cancelAll();
      await pageReader.close();
      await api.stop();
      try {
        db.close(true); // 문장을 모두 정리하고 바로 닫는다 (파일 잠금 해제)
      } catch (err) {
        console.warn("[db] 즉시 닫기 실패 — 남은 문장이 정리되면 닫힘", err);
        db.close();
      }
    },
  };
}
