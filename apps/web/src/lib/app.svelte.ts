// 앱 상태 + daemon WebSocket 이벤트 반영
import {
	AccountInfo,
	Agent,
	type AgentInput,
	HealthResponse,
	LlmStatus,
	Message,
	ModelInfo,
	Persona,
	type PersonaInput,
	PreviewResponse,
	Room,
	RoomSummary,
	ServerEvent,
	SessionResponse,
	Settings,
	SignInStart,
	SignOutResult,
	SendMessageResponse,
	type SignInResult,
	Note,
	type NoteInput,
	ToolCall,
	ToolInfo,
	ExtractResult,
	Memory,
	type MemoryInput,
	MemoryGraph,
	MemoryUses,
	type MemoryBulkRequest,
	BrowserStatus,
	Research,
	type ResearchEvent,
	ResearchMessage,
	ResearchTimeline,
	SiteAccount,
	type SiteAccountInput,
	ResearchRun,
	ResearchRunDetail,
	type ResearchInput,
	SHARED_SCOPE,
	SETTINGS_DEFAULTS,
	type SettingsPatch,
	UsageToday,
	UsageHistory,
	type UsageAlert,
	type BudgetFeature,
	LoungeStatus,
	LoungeSession,
	EmbeddingStatus,
	Reminder,
	AgentStatus,
	ThemeBundle,
	ThemeInfo,
	Debate,
	type StartDebateRequest,
	type AttachmentInput,
	AttachmentContent,
	FileChange,
	AuditPage,
	type ToolGroup,
	SnapshotUsage,
	type WorkspaceRules,
	API_PREFIX,
	BackupInfo,
	UpdateInfo,
	VisualFrameResponse,
	SearchResponse,
	type AgentEffort,
	Command,
	Team,
	type TeamInput,
	MIN_TEAM_AGENTS,
	SkillInfo,
	SkillDetail,
	SkillStage,
	RunnerStatus,
	type SkillImportRequest,
	McpServerInfo,
	type McpServerInput,
	Task,
	type TaskInput,
	TaskRun
} from '@proprix/shared';
import { z } from 'zod';
import { goto } from '$app/navigation';
import { apiFile, api, ApiFailure } from './api.js';
import { applyTheme, DEFAULT_THEME, savedTheme } from './theme.js';
import { download } from './download.js';
import { FEATURE_LABEL } from './labels.js';
import { toast } from './ui/toast.svelte.js';
import { getEndpoint, inApp, loadEndpoint, nativeNotify, openExternal } from './native.js';

export type Connection = 'loading' | 'offline' | 'unauthenticated' | 'ready';

function signInErrorText(e: unknown): string {
	const msg = e instanceof ApiFailure ? e.message : String(e);
	return msg.includes('port_in_use')
		? '로그인 콜백 포트(1455)를 다른 프로그램(Codex CLI 등)이 쓰고 있습니다. 그 프로그램을 종료한 뒤 다시 시도하세요.'
		: msg;
}

export const RELEASES_URL = 'https://github.com/Oxygen925/PROPRIX/releases/latest';
const UPDATE_DISMISSED_KEY = 'proprix.update-dismissed';
const UPDATE_CHECK_MS = 6 * 60 * 60_000;
export const PRIVACY_URL = 'https://github.com/Oxygen925/PROPRIX/blob/main/PRIVACY.md';
const PRIVACY_KEY = 'proprix.privacy';
const PRIVACY_VERSION = '2026-11-01'; // 안내 내용이 크게 바뀌면 올려 다시 보여 준다

class AppState {
	connection = $state<Connection>('loading');
	version = $state('');
	account = $state<AccountInfo | null>(null);
	models = $state<ModelInfo[]>([]);
	modelsError = $state('');
	settings = $state<Settings>(structuredClone(SETTINGS_DEFAULTS));
	llm = $state<LlmStatus>({ paused: false, pausedCode: '', active: 0, queued: 0 });
	rooms = $state<Room[]>([]);
	roomId = $state('');
	loadedRoomId = $state(''); // 메시지까지 다 불러온 방 (방을 바꾸는 동안엔 앞 방)
	messages = $state<Message[]>([]);
	summary = $state<RoomSummary | null>(null); // 현재 방의 롤링 요약
	personas = $state<Persona[]>([]);
	agents = $state<Agent[]>([]);
	tools = $state<ToolInfo[]>([]); // 도구 목록 (이름·제목·읽기/쓰기)
	toolCalls = $state<ToolCall[]>([]); // 현재 방의 도구 호출
	pendingCalls = $state<ToolCall[]>([]); // 모든 방에서 확인을 기다리는 호출 (홈 '확인 필요')
	fileChanges = $state<FileChange[]>([]); // 현재 방의 작업 폴더 파일 변경 (되돌리기)
	debates = $state<Debate[]>([]); // 현재 방의 토론·협업
	notes = $state<Note[]>([]);
	commands = $state<Command[]>([]); // 사용자 정의 / 명령
	teams = $state<Team[]>([]); // 팀 프리셋 (P10d)
	teamPicker = $state(false); // /team (이름 없이) 팀 고르기 대화상자
	skills = $state<SkillInfo[]>([]);
	mcpServers = $state<McpServerInfo[]>([]);
	tasks = $state<Task[]>([]);
	taskMessages = $state<Record<string, { taskId: string; title: string }>>({}); // 현재 방의 예약 작업 결과 메시지 → 작업
	subchatDraft = $state<{ roomId: string; messageId?: string } | null>(null); // 서브 채팅 만들기 대화상자
	browser = $state<BrowserStatus | null>(null); // 리서치 브라우저 설치 상태 (P11a)
	researches = $state<Research[]>([]); // 리서치 작업 (P11b)
	researchLive = $state<Record<string, ResearchRun[]>>({}); // 리서치마다 진행 중·막 끝난 실행 묶음 (이벤트, P12b)
	researchEvents = $state<Record<string, ResearchEvent[]>>({}); // 실행마다 실시간으로 받은 행동 로그 (P12a)
	researchMessages = $state<Record<string, ResearchMessage[]>>({}); // 리서치마다 실시간으로 받은 대화 (P12d)
	siteAccountChanged = $state<SiteAccount | null>(null); // 마지막으로 바뀐 사이트 계정 (P12c)
	usageAlerts = $state(0); // 예산 알림 수 (사용량 화면이 다시 읽는다)
	auditVersion = $state(0); // 메모·리마인더·파일 변경이 생기면 오른다 (감사 화면이 다시 읽는다)
	artifactDraft = $state<{ messageId: string; kind: 'note' | 'file' } | null>(null); // 토론 맺는 말 저장 대화상자
	// 입력창의 / 명령이 헤더가 가진 대화상자를 연다 (헤더가 받아서 비운다)
	roomDialog = $state<'' | 'workspace' | 'summary' | 'debate'>('');
	debateDraft = $state<{ mode: 'debate' | 'collab'; topic: string } | null>(null); // /debate·/collab 이 채운 값
	notesLoaded = false;
	memories = $state<Memory[]>([]);
	memoriesLoaded = false;
	signingIn = $state(false);
	signInError = $state('');
	statuses = $state<Record<string, AgentStatus>>({}); // 에이전트 id → 지금 상태
	panelOpen = $state(readPanelOpen()); // 오른쪽 에이전트 패널
	scale = $state<DisplayScale>(readScale()); // 화면 크기 (기기별)
	theme = $state(savedTheme()); // 켠 테마 id (기기별)
	themes = $state<ThemeInfo[]>([]); // 올린 테마
	railLabels = $state(readRailLabels()); // 레일에 이름 표시 (기기별)
	characterMotion = $state(readCharacterMotion()); // 캐릭터 움직임 (기기별)
	agentOrder = $state<string[]>(readAgentOrder()); // 사이드바에서 끌어 정한 순서 (비면 최근 활동 순)
	wsConnected = $state(false);

	private ws: WebSocket | null = null;
	private everConnected = false;
	private readonly earlyDeltas = new Map<string, string>(); // 전송 응답보다 먼저 온 델타
	private retry: ReturnType<typeof setTimeout> | undefined;

	// 응답 연쇄 진행 중 (라우터가 화자를 고르는 동안처럼 받는 메시지가 없을 때도)
	get streaming(): boolean {
		return (this.room?.running ?? false) || this.messages.some((m) => m.status === 'streaming');
	}

	get model(): string {
		const chosen = this.settings.model;
		return this.models.some((m) => m.slug === chosen) ? chosen : (this.models[0]?.slug ?? '');
	}

	get room(): Room | undefined {
		return this.rooms.find((r) => r.id === this.roomId);
	}

	get roomAgents(): Agent[] {
		return (this.room?.agentIds ?? []).flatMap((id) => this.agent(id) ?? []);
	}

	agent(id: string): Agent | undefined {
		return this.agents.find((a) => a.id === id);
	}

	persona(id: string): Persona | undefined {
		return this.personas.find((p) => p.id === id);
	}

	// 에이전트의 표시 정보 (이모지·색·이미지는 페르소나 것)
	look(agentId: string): { name: string; emoji: string; color: string; image: string; personaId: string; character: string | null } {
		const a = this.agent(agentId);
		const p = a ? this.persona(a.personaId) : undefined;
		return {
			name: a?.name ?? '알 수 없음',
			emoji: p?.emoji ?? '❔',
			color: p?.color ?? '#888888',
			image: p?.avatarImage ?? '',
			personaId: p?.id ?? '',
			character: p?.character ?? null
		};
	}

	async init() {
		try {
			// 앱: 셸이 daemon 준비를 기다린 뒤 주소·토큰을 준다
			if (inApp) await loadEndpoint();
			this.version = (await api(HealthResponse, '/health')).version;
		} catch {
			this.connection = 'offline';
			return;
		}
		try {
			await api(SessionResponse, '/session');
		} catch (e) {
			this.connection = e instanceof ApiFailure && e.status === 401 ? 'unauthenticated' : 'offline';
			return;
		}
		this.connect();
		try {
			[this.account, this.settings, this.llm, this.rooms] = await Promise.all([
				api(AccountInfo, '/account'),
				api(Settings, '/settings'),
				api(LlmStatus, '/llm'),
				api(z.array(Room), '/rooms')
			]);
		} catch (e) {
			console.warn('[init]', e);
			this.connection = 'offline';
			return;
		}
		// 나머지 목록은 하나가 실패해도 화면을 막지 않는다
		const rest = await Promise.allSettled([
			this.loadAgents(),
			api(z.array(ToolInfo), '/tools').then((t) => (this.tools = t)),
			this.loadStatuses(),
			this.loadThemes(),
			this.loadPendingCalls(),
			this.loadCommands(),
			this.loadTeams(),
			this.loadSkills(),
			this.loadMcp(),
			this.loadTasks(),
			this.loadResearch(),
			this.loadBrowser()
		]);
		for (const r of rest) if (r.status === 'rejected') console.warn('[init]', r.reason);
		// 설정을 받은 뒤에 화면을 연다: 먼저 열면 설정 화면의 초안이 기본값으로 굳어 저장 때 지침이 지워진다
		this.connection = 'ready';
		void this.reportRestore().catch((e) => console.warn('[init]', e));
		if (this.account.signedIn && !this.privacyAccepted) this.privacy = 'update';
		void this.checkUpdate();
		this.updateTimer ??= setInterval(() => void this.checkUpdate(), UPDATE_CHECK_MS);
		if (this.account.signedIn) await this.loadModels();
	}

	dispose() {
		clearTimeout(this.retry);
		this.ws?.close();
		this.ws = null;
	}

	private connect() {
		// 소켓은 하나만: 화면을 다시 올리는 사이 init 이 겹치면 이벤트를 두 번 받아 답 글자가 겹쳐 보인다
		const previous = this.ws;
		this.ws = null;
		previous?.close();
		clearTimeout(this.retry);
		// 앱은 WebSocket 에 헤더를 붙일 수 없어 토큰을 쿼리로
		const ep = getEndpoint();
		const ws = new WebSocket(
			ep
				? `${ep.url.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(ep.token)}`
				: `${location.origin.replace(/^http/, 'ws')}/api/ws`
		);
		this.ws = ws;
		ws.onopen = () => {
			// 다시 연결됐으면 끊긴 동안 놓친 이벤트(응답 연쇄 끝 등)를 메우려고 방 목록·현재 방을 다시 불러온다
			if (this.wsConnected === false && this.everConnected) void this.resync();
			this.everConnected = true;
			this.wsConnected = true;
		};
		ws.onclose = () => {
			if (this.ws !== ws) return; // 바꾼 뒤의 이전 소켓은 연결 상태를 건드리지 않는다
			this.wsConnected = false;
			this.retry = setTimeout(() => this.connect(), 2000);
		};
		ws.onmessage = (e) => {
			if (this.ws !== ws) return; // 닫는 중인 이전 소켓
			const ev = ServerEvent.safeParse(JSON.parse(String(e.data)));
			if (ev.success) this.onEvent(ev.data);
		};
	}

	private onEvent(ev: ServerEvent) {
		switch (ev.type) {
			case 'account':
				this.account = ev.account;
				if (ev.signIn) this.onSignInDone(ev.signIn);
				if (!ev.account.signedIn) this.models = [];
				break;
			case 'llm':
				this.llm = ev.status;
				break;
			case 'research_browser':
				this.browser = ev.status;
				break;
			case 'research':
				void this.loadResearch();
				break;
			case 'research_run':
				this.onResearchRun(ev.run);
				break;
			case 'research_event':
				this.researchEvents[ev.event.runId] = [...(this.researchEvents[ev.event.runId] ?? []), ev.event].slice(-300);
				break;
			case 'research_message': {
				const cur = this.researchMessages[ev.message.researchId] ?? [];
				this.researchMessages[ev.message.researchId] = cur.some((m) => m.id === ev.message.id)
					? cur.map((m) => (m.id === ev.message.id ? ev.message : m))
					: [...cur, ev.message];
				break;
			}
			case 'site_account':
				this.onSiteAccount(ev.account);
				break;
			case 'usage_alert':
				this.onUsageAlert(ev.alert);
				break;
			case 'delta': {
				if (ev.roomId !== this.roomId) break;
				const m = this.messages.find((x) => x.id === ev.messageId);
				if (m) m.content += ev.text;
				else this.earlyDeltas.set(ev.messageId, (this.earlyDeltas.get(ev.messageId) ?? '') + ev.text);
				break;
			}
			case 'message': {
				// 선제 메시지 완료: 지금 보는 방이 아니거나 창이 숨겨져 있으면 알림 (다른 방 이벤트라 아래에서 걸러지기 전에)
				if (ev.message.proactive && ev.message.status === 'complete') this.onProactive(ev.message);
				if (ev.message.roomId !== this.roomId) break;
				this.upsert(ev.message);
				if (ev.message.recovery === 're_sign_in') void this.refreshAccount();
				break;
			}
			case 'messages_removed': {
				if (ev.roomId !== this.roomId) break;
				const gone = new Set(ev.ids);
				this.messages = this.messages.filter((m) => !gone.has(m.id));
				this.toolCalls = this.toolCalls.filter((c) => !gone.has(c.messageId));
				break;
			}
			case 'debate': {
				if (ev.debate.roomId !== this.roomId) break;
				const i = this.debates.findIndex((d) => d.id === ev.debate.id);
				if (i >= 0) this.debates[i] = ev.debate;
				else this.debates.push(ev.debate);
				break;
			}
			case 'turn': {
				const r = this.rooms.find((x) => x.id === ev.roomId);
				if (r) r.running = ev.running;
				break;
			}
			case 'summary':
				if (ev.summary.roomId === this.roomId) this.summary = ev.summary;
				break;
			case 'tool': {
				this.pendingCalls = [
					...this.pendingCalls.filter((c) => c.id !== ev.call.id),
					...(ev.call.status === 'pending' ? [ev.call] : [])
				];
				if (ev.call.roomId !== this.roomId) break;
				const i = this.toolCalls.findIndex((c) => c.id === ev.call.id);
				if (i >= 0) this.toolCalls[i] = ev.call;
				else this.toolCalls.push(ev.call);
				break;
			}
			case 'notes':
				if (this.notesLoaded) void this.loadNotes();
				this.auditVersion++;
				break;
			case 'commands':
				void this.loadCommands();
				break;
			case 'teams':
				void this.loadTeams();
				break;
			case 'skills':
				void this.loadSkills();
				break;
			case 'mcp':
				void this.loadMcp();
				break;
			case 'tasks':
				void this.loadTasks();
				if (this.roomId) void this.loadTaskMessages();
				break;
			case 'embedding':
				this.embedding = ev.status;
				break;
			case 'reminders':
				if (this.remindersLoaded) void this.loadReminders();
				this.auditVersion++;
				break;
			case 'agent_status':
				this.statuses = { ...this.statuses, [ev.status.agentId]: ev.status };
				break;
			case 'rooms':
				void this.reloadRooms();
				break;
			case 'agents':
				void this.loadAgents();
				break;
			case 'file_changes':
				if (ev.roomId === this.roomId) void this.loadFileChanges();
				this.auditVersion++;
				break;
			case 'lounge':
				if (this.lounge) {
					const i = this.lounge.recent.findIndex((x) => x.id === ev.session.id);
					if (i >= 0) this.lounge.recent[i] = ev.session;
					else this.lounge.recent.unshift(ev.session);
				}
				break;
			case 'memories':
				if (this.memoriesLoaded) void this.loadMemories();
				break;
		}
	}

	// 같은 id 는 교체, 새 메시지는 createdAt 순서 자리에 넣는다
	// (짧은 응답은 WS 완료 이벤트가 전송 HTTP 응답보다 먼저 올 수 있다)
	private upsert(m: Message) {
		const i = this.messages.findIndex((x) => x.id === m.id);
		if (i >= 0) {
			// 이미 완료 상태를 받았으면 늦게 온 전송 응답(streaming)으로 되돌리지 않는다
			if (m.status === 'streaming' && this.messages[i]?.status !== 'streaming') return;
			this.messages[i] = m;
			return;
		}
		const early = this.earlyDeltas.get(m.id);
		this.earlyDeltas.delete(m.id);
		if (early && m.status === 'streaming') m = { ...m, content: m.content + early };
		const at = this.messages.findIndex((x) => x.createdAt > m.createdAt);
		if (at < 0) this.messages.push(m);
		else this.messages.splice(at, 0, m);
	}

	private async refreshAccount() {
		this.account = await api(AccountInfo, '/account');
	}

	async loadModels() {
		this.modelsError = '';
		try {
			this.models = await api(z.array(ModelInfo), '/models');
		} catch (e) {
			this.modelsError = e instanceof ApiFailure ? (e.detail?.code ?? e.message) : String(e);
			if (e instanceof ApiFailure && e.detail?.recovery === 're_sign_in') await this.refreshAccount();
		}
	}

	async setModel(slug: string) {
		this.settings = await api(Settings, '/settings', { method: 'PATCH', body: { model: slug } });
	}

	// ---- 로그인 ----

	// 클릭 핸들러 안에서 호출: 팝업 차단을 피하려고 창을 먼저 열고 인가 URL 로 보낸다
	async signIn() {
		this.signInError = '';
		if (inApp) {
			// 앱: 로그인은 시스템 브라우저에서 (콜백은 daemon 의 loopback 포트로)
			try {
				const { authorizeUrl } = await api(SignInStart, '/account/signin', { method: 'POST' });
				this.signingIn = true;
				await openExternal(authorizeUrl);
			} catch (e) {
				this.signInError = signInErrorText(e);
			}
			return;
		}
		const win = window.open('about:blank', '_blank');
		try {
			const { authorizeUrl } = await api(SignInStart, '/account/signin', { method: 'POST' });
			this.signingIn = true;
			if (win) {
				win.opener = null;
				win.location.href = authorizeUrl;
			} else {
				location.assign(authorizeUrl);
			}
		} catch (e) {
			win?.close();
			this.signInError = signInErrorText(e);
		}
	}

	async cancelSignIn() {
		await api(z.unknown(), '/account/signin/cancel', { method: 'POST' });
	}

	private onSignInDone(r: SignInResult) {
		this.signingIn = false;
		if (r.ok) {
			void this.loadModels();
			return;
		}
		const messages: Record<string, string> = {
			cancelled: '',
			timeout: '로그인 시간이 초과되었습니다.',
			access_denied: '로그인이 거부되었습니다.',
			account_mismatch: '이전에 연결한 계정과 다른 ChatGPT 계정입니다.',
			id_token_invalid: 'ID 토큰 검증에 실패했습니다.'
		};
		this.signInError = messages[r.code] ?? `로그인 실패: ${r.code}`;
	}

	// 새 버전 알림: 닫으면 그 버전은 다시 띄우지 않는다
	update = $state<string | null>(null);
	private updateTimer: ReturnType<typeof setInterval> | undefined;

	async checkUpdate() {
		try {
			const { latest } = await api(UpdateInfo, '/update');
			let dismissed: string | null = null;
			try {
				dismissed = localStorage.getItem(UPDATE_DISMISSED_KEY);
			} catch {
				// 저장소를 못 읽으면 그대로 보여 준다
			}
			this.update = latest === dismissed ? null : latest;
		} catch (e) {
			console.warn('[update]', e);
		}
	}

	dismissUpdate() {
		try {
			if (this.update) localStorage.setItem(UPDATE_DISMISSED_KEY, this.update);
		} catch {
			// 저장하지 못하면 다음에 다시 보여 준다
		}
		this.update = null;
	}

	// 개인정보 안내: 처음 로그인하기 전에 보여 준다. 이미 로그인한 채 업데이트한 사용자에게는 한 번 알린다
	privacy = $state<'signin' | 'update' | 'view' | null>(null);

	private get privacyAccepted(): boolean {
		try {
			return localStorage.getItem(PRIVACY_KEY) === PRIVACY_VERSION;
		} catch {
			return false;
		}
	}

	private markPrivacyAccepted() {
		try {
			localStorage.setItem(PRIVACY_KEY, PRIVACY_VERSION);
		} catch {
			// 저장하지 못하면 다음에 다시 보여 준다
		}
	}

	beginSignIn() {
		if (this.privacyAccepted) return this.signIn();
		this.privacy = 'signin';
	}

	async acceptPrivacy(autoExtract: boolean) {
		await this.saveExtractConsent(autoExtract);
		this.markPrivacyAccepted();
		this.privacy = null;
		return this.signIn();
	}

	async closePrivacy(autoExtract?: boolean) {
		if (this.privacy === 'update') {
			await this.saveExtractConsent(!!autoExtract);
			this.markPrivacyAccepted();
		}
		this.privacy = null;
	}

	private async saveExtractConsent(autoExtract: boolean) {
		if (this.settings.memory.autoExtract !== autoExtract) await this.patchSettings({ memory: { autoExtract } });
	}

	/** 시각화 문서를 daemon 에 맡기고 iframe 에 넣을 주소를 받는다 */
	async visualFrame(doc: string): Promise<string> {
		const { id } = await api(VisualFrameResponse, '/visual-frames', { method: 'POST', body: { doc } });
		return `${getEndpoint()?.url ?? ''}${API_PREFIX}/visual-frame/${id}`;
	}

	async markWelcomeShown() {
		await api(z.unknown(), '/account/welcome-shown', { method: 'POST' });
	}

	async signOut(forceLocal = false) {
		const r = await api(SignOutResult, '/account/signout', { method: 'POST', body: { forceLocal } });
		if (r.code === 'revoke_failed') {
			if (confirm('원격 연결 해제를 확인하지 못했습니다. 이 PC 에서만 로그아웃할까요?')) await this.signOut(true);
		} else if (r.code === 'revoke_unconfirmed') {
			toast('이 PC 에서만 로그아웃했습니다. 원격 해제는 확인되지 않았으니 ChatGPT 설정에서 앱 연결을 해제하세요.');
		}
	}

	async resumeLlm() {
		this.llm = await api(LlmStatus, '/llm/resume', { method: 'POST' });
	}

	// ---- 채팅 ----

	async openRoom(id: string) {
		this.roomId = id;
		this.unread = this.unread.filter((r) => r !== id);
		const loaded = await Promise.all([
			api(z.array(Message), `/rooms/${id}/messages`),
			api(RoomSummary.nullable(), `/rooms/${id}/summary`),
			api(z.array(ToolCall), `/rooms/${id}/tool-calls`),
			api(z.array(Debate), `/rooms/${id}/debates`),
			api(z.array(FileChange), `/rooms/${id}/file-changes`)
		]);
		if (this.roomId !== id) return; // 기다리는 사이 다른 방으로 옮겼다
		[this.messages, this.summary, this.toolCalls, this.debates, this.fileChanges] = loaded;
		void this.loadTaskMessages();
		this.loadedRoomId = id;
	}

	private async resync() {
		try {
			this.rooms = await api(z.array(Room), '/rooms');
			if (this.roomId) await this.openRoom(this.roomId);
		} catch {
			// 다음 재연결에서 다시
		}
	}

	// ---- 도구·메모 ----

	toolTitle(name: string): string {
		const local = this.tools.find((t) => t.name === name)?.title;
		if (local) return local;
		// MCP: 서버 · 도구 제목
		for (const s of this.mcpServers) {
			const t = s.tools.find((x) => x.exposed === name);
			if (t) return `${s.name} · ${t.title}`;
		}
		return name;
	}

	/** always: 허용하면서 이 호출을 한 에이전트의 이 도구를 '항상 허용'에 더한다 */
	async decide(callId: string, approve: boolean, always = false) {
		await api(z.unknown(), `/tool-calls/${callId}/decision`, { method: 'POST', body: { approve, always } });
	}

	/** 에이전트 추론 강도만 바꾼다 (입력창 슬라이더). 나머지 설정은 그대로 */
	async setEffort(agentId: string, effort: AgentEffort) {
		const a = this.agent(agentId);
		if (!a) return;
		await this.saveAgent(agentId, { ...a, reasoningEffort: effort });
	}

	/** 에이전트 지정 모델만 바꾼다 ('' = 전역 기본 모델 따름) */
	async setAgentModel(agentId: string, model: string) {
		const a = this.agent(agentId);
		if (!a) return;
		await this.saveAgent(agentId, { ...a, model });
	}

	async revokeTool(agentId: string, tool: string) {
		const a = await api(Agent, `/agents/${agentId}/revoke-tool`, { method: 'POST', body: { tool } });
		this.agents = this.agents.map((x) => (x.id === a.id ? a : x));
	}

	async loadNotes() {
		this.notes = await api(z.array(Note), '/notes');
		this.notesLoaded = true;
	}

	async saveNote(id: string | null, input: NoteInput): Promise<Note> {
		const note = await api(Note, id ? `/notes/${id}` : '/notes', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadNotes();
		return note;
	}

	async deleteNote(id: string) {
		await api(z.unknown(), `/notes/${id}`, { method: 'DELETE' });
		await this.loadNotes();
	}

	// ---- 팀 프리셋 (P10d): 기존 에이전트 묶음(참가자·순서·연쇄 상한) ----

	async loadTeams() {
		this.teams = await api(z.array(Team), '/teams');
	}

	async saveTeam(id: string | null, input: TeamInput): Promise<Team> {
		const t = await api(Team, id ? `/teams/${id}` : '/teams', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadTeams();
		return t;
	}

	async deleteTeam(id: string) {
		await api(z.unknown(), `/teams/${id}`, { method: 'DELETE' });
		await this.loadTeams();
	}

	/** 그 팀 구성으로 새 대화를 열고 이동한다 */
	async openTeam(t: Team) {
		if (t.agentIds.length < MIN_TEAM_AGENTS) throw new Error(`'${t.name}' 팀은 참여자가 부족합니다. 에이전트 화면의 팀 탭에서 편집하세요`);
		const room = await this.newRoom(t.agentIds, t.name, t.chainLimit);
		await goto(`/rooms/${room.id}`);
	}

	// ---- / 명령 ----

	async loadCommands() {
		this.commands = await api(z.array(Command), '/commands');
	}

	async saveCommand(id: string | null, input: { name: string; description: string; template: string }): Promise<Command> {
		const c = await api(Command, id ? `/commands/${id}` : '/commands', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadCommands();
		return c;
	}

	async deleteCommand(id: string) {
		await api(z.unknown(), `/commands/${id}`, { method: 'DELETE' });
		await this.loadCommands();
	}

	// ---- Skill ----

	async loadSkills() {
		this.skills = await api(z.array(SkillInfo), '/skills');
	}

	skillDetail(name: string) {
		return api(SkillDetail, `/skills/${encodeURIComponent(name)}`);
	}

	runners(refresh = false) {
		return api(z.array(RunnerStatus), `/skills/runners${refresh ? '?refresh=1' : ''}`);
	}

	/** 가져오기 검증·미리보기 (설치는 commitSkill) */
	stageSkill(req: SkillImportRequest) {
		return api(SkillStage, '/skills/import', { method: 'POST', body: req });
	}

	async commitSkill(id: string): Promise<SkillInfo> {
		const s = await api(SkillInfo, `/skills/import/${id}/commit`, { method: 'POST' });
		await this.loadSkills();
		return s;
	}

	discardSkill(id: string) {
		return api(z.unknown(), `/skills/import/${id}`, { method: 'DELETE' }).catch(() => {});
	}

	async deleteSkill(name: string) {
		await api(z.unknown(), `/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
		await Promise.all([this.loadSkills(), this.loadAgents()]);
	}

	// ---- MCP ----

	private mcpSeq = 0;
	async loadMcp() {
		const seq = ++this.mcpSeq; // 이벤트가 몰려도 마지막 응답만 쓴다
		const list = await api(z.array(McpServerInfo), '/mcp/servers');
		if (seq === this.mcpSeq) this.mcpServers = list;
	}

	async saveMcp(id: string | null, input: McpServerInput): Promise<McpServerInfo> {
		const s = await api(McpServerInfo, id ? `/mcp/servers/${id}` : '/mcp/servers', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadMcp();
		return s;
	}

	async deleteMcp(id: string) {
		await api(z.unknown(), `/mcp/servers/${id}`, { method: 'DELETE' });
		await Promise.all([this.loadMcp(), this.loadAgents()]);
	}

	async refreshMcp(id: string) {
		await api(McpServerInfo, `/mcp/servers/${id}/refresh`, { method: 'POST' });
		await this.loadMcp();
	}

	async toggleMcpTool(id: string, tool: string, enabled: boolean) {
		await api(McpServerInfo, `/mcp/servers/${id}/tools/${encodeURIComponent(tool)}`, { method: 'PUT', body: { enabled } });
		await this.loadMcp();
	}

	mcpLog(id: string) {
		return api(z.array(z.string()), `/mcp/servers/${id}/log`);
	}

	// ---- 반복 예약 작업 ----

	async loadTasks() {
		this.tasks = await api(z.array(Task), '/tasks');
	}

	async loadTaskMessages() {
		const id = this.roomId;
		if (!id) return;
		const list = await api(z.array(z.object({ messageId: z.string(), taskId: z.string(), title: z.string() })), `/rooms/${id}/task-messages`);
		if (id === this.roomId) this.taskMessages = Object.fromEntries(list.map((x) => [x.messageId, { taskId: x.taskId, title: x.title }]));
	}

	async saveTask(id: string | null, input: TaskInput): Promise<Task> {
		const t = await api(Task, id ? `/tasks/${id}` : '/tasks', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadTasks();
		return t;
	}

	async deleteTask(id: string) {
		await api(z.unknown(), `/tasks/${id}`, { method: 'DELETE' });
		await this.loadTasks();
	}

	async runTaskNow(id: string) {
		await api(z.unknown(), `/tasks/${id}/run`, { method: 'POST' });
		await this.loadTasks();
	}

	taskRuns(id: string) {
		return api(z.array(TaskRun), `/tasks/${id}/runs`);
	}

	lounge = $state<z.infer<typeof LoungeStatus> | null>(null);
	usage = $state<z.infer<typeof UsageToday> | null>(null);
	embedding = $state<EmbeddingStatus | null>(null);
	reminders = $state<Reminder[]>([]);
	backups = $state<z.infer<typeof BackupInfo> | null>(null);
	remindersLoaded = false;
	unread = $state<string[]>([]); // 선제 메시지가 왔지만 아직 열지 않은 방

	private onProactive(m: Message) {
		// 탭이 숨겨졌거나 창에 포커스가 없으면(다른 프로그램을 쓰는 중) 자리를 비운 것으로 본다
		const away = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
		if (m.roomId !== this.roomId && !this.unread.includes(m.roomId)) this.unread = [...this.unread, m.roomId];
		if (m.roomId === this.roomId && !away) return;
		const icon = { reminder: '⏰', checkin: '👋', nudge: '👋', task: '🗓', '': '' }[m.proactive];
		// 예약 작업은 방해 금지 시간대에도 실행하고, 알림만 끝난 뒤에 (사용자 결정 2026-10-29)
		if (m.proactive === 'task') {
			const wait = quietLeftMs(this.settings.proactive);
			if (wait > 0) {
				setTimeout(() => this.notify(m, icon), wait);
				return;
			}
		}
		this.notify(m, icon);
	}

	private notify(m: Message, icon: string) {
		// 예약 작업 제목: 결과 메시지 기록은 실행이 끝난 뒤에 생기므로, 그 방·에이전트에서 실행 중인 작업으로 찾는다
		const task =
			this.taskMessages[m.id] ??
			this.tasks.find((t) => t.roomId === m.roomId && t.agentId === m.agentId && t.lastStatus === 'running');
		const title = m.proactive === 'task' ? `${icon} ${task?.title ?? '예약 작업'}` : `${icon} ${this.look(m.agentId).name}`;
		if (inApp) {
			// 앱: 창이 트레이로 숨겨져 있어도 네이티브 알림, 클릭하면 창을 보이고 그 방으로
			void nativeNotify(title, m.content.slice(0, 200), m.roomId, (room) =>
				this.openFromNotification(room)
			).catch((err) => console.warn('[notify]', err));
			return;
		}
		if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
		const n = new Notification(title, { body: m.content.slice(0, 200), tag: m.id });
		n.onclick = () => {
			window.focus();
			this.openFromNotification(m.roomId);
			n.close();
		};
	}

	// 설정·에이전트 화면에 있어도 그 방으로. '/' 로 시작하면 그 화면으로 (예산 알림 → 사용량)
	private openFromNotification(target: string) {
		void goto(target.startsWith('/') ? target : `/rooms/${target}`);
	}

	// 일일 예산 80%·100%: 토스트와 시스템 알림 (사용자 결정 2026-10-29)
	private onUsageAlert(a: UsageAlert) {
		const label = FEATURE_LABEL[a.feature as BudgetFeature]?.title ?? a.feature;
		const text =
			a.level === 100
				? `오늘 ${label} 예산(${a.limit}회)을 다 썼습니다. 자정까지 이 기능은 요청하지 않습니다.`
				: `오늘 ${label} 예산의 80%를 썼습니다 (${a.used}/${a.limit}회).`;
		toast(text, a.level === 100 ? 'error' : 'info');
		this.usageAlerts++;
		const target = '/activity?tab=usage';
		if (inApp) {
			void nativeNotify('PROPRIX 사용량', text, target, (t) => this.openFromNotification(t)).catch((err) =>
				console.warn('[notify]', err)
			);
			return;
		}
		if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
		const n = new Notification('PROPRIX 사용량', { body: text, tag: `usage-${a.feature}-${a.level}` });
		n.onclick = () => {
			window.focus();
			this.openFromNotification(target);
			n.close();
		};
	}

	// 권한·운영체제 알림 설정을 확인하는 시험 알림
	async testNotification(): Promise<boolean> {
		if (inApp) {
			return nativeNotify('PROPRIX 시험 알림', '선제 메시지가 오면 이렇게 알려 드립니다.', this.roomId, (room) =>
				this.openFromNotification(room)
			).catch((err) => {
				console.warn('[notify]', err);
				return false;
			});
		}
		if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
		new Notification('PROPRIX 시험 알림', { body: '선제 메시지가 오면 이렇게 알려 드립니다.', tag: 'proprix-test' });
		return true;
	}

	async requestNotifications(): Promise<NotificationPermission> {
		if (typeof Notification === 'undefined') return 'denied';
		return Notification.requestPermission();
	}

	async loadReminders() {
		this.remindersLoaded = true;
		this.reminders = await api(z.array(Reminder), '/reminders');
	}

	async cancelReminder(id: string) {
		await api(z.unknown(), `/reminders/${id}`, { method: 'DELETE' });
		await this.loadReminders();
	}

	async reloadRooms() {
		this.rooms = await api(z.array(Room), '/rooms');
	}

	// ---- 리서치 (P11b) ----

	async loadResearch() {
		this.researches = await api(z.array(Research), '/research');
	}

	async saveResearch(id: string | null, input: ResearchInput): Promise<Research> {
		const r = await api(Research, id ? `/research/${id}` : '/research', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadResearch();
		return r;
	}

	async deleteResearch(id: string) {
		await api(z.unknown(), `/research/${id}`, { method: 'DELETE' });
		await this.loadResearch();
	}

	async runResearch(id: string, extra = '', continuing = false) {
		await api(ResearchRun, `/research/${id}/run`, { method: 'POST', body: { extra, continue: continuing } });
	}

	exportResearch(id: string) {
		const title = this.researches.find((r) => r.id === id)?.title ?? '리서치';
		return download(`/research/${id}/export`, `${title}.md`);
	}

	researchTimeline(id: string) {
		return api(ResearchTimeline, `/research/${id}/timeline`);
	}

	async askResearch(id: string, text: string, agentId: string) {
		await api(ResearchMessage, `/research/${id}/ask`, { method: 'POST', body: { text, agentId } });
	}

	researchRunning(id: string): boolean {
		const live = this.researchLive[id];
		if (live) return live.some((r) => r.status === 'running');
		return this.researches.find((r) => r.id === id)?.lastRun?.status === 'running';
	}

	async cancelResearch(id: string) {
		await api(z.unknown(), `/research/${id}/cancel`, { method: 'POST' });
	}

	researchRun(runId: string) {
		return api(ResearchRunDetail, `/research/runs/${runId}`);
	}

	// 진행 이벤트: 묶음이 끝나면 토스트와 시스템 알림 (결과는 리서치 화면에서)
	private onResearchRun(run: ResearchRun) {
		const cur = this.researchLive[run.researchId];
		const same = cur?.[0]?.batchId === run.batchId ? cur : [];
		const wasRunning = same.some((r) => r.status === 'running');
		const next = same.some((r) => r.id === run.id) ? same.map((r) => (r.id === run.id ? run : r)) : [...same, run];
		this.researchLive = { ...this.researchLive, [run.researchId]: next };
		if (!wasRunning || next.some((r) => r.status === 'running')) return;
		this.onResearchDone(run.researchId, next);
	}

	// 묶음 전체가 끝났을 때 한 번만 알린다
	private onResearchDone(researchId: string, runs: ResearchRun[]) {
		const has = (s: ResearchRun['status']) => runs.some((r) => r.status === s);
		const run = {
			researchId,
			status: has('cancelled')
				? ('cancelled' as const)
				: runs.every((r) => r.status === 'failed')
					? ('failed' as const)
					: has('partial') || has('failed')
						? ('partial' as const)
						: runs.every((r) => r.status === 'skipped')
							? ('skipped' as const)
							: ('done' as const),
			pages: runs.reduce((n, r) => n + r.pages, 0),
			error: runs.find((r) => r.error)?.error ?? ''
		};
		const title = this.researches.find((r) => r.id === run.researchId)?.title ?? '리서치';
		const text =
			run.status === 'done' || run.status === 'partial'
				? `'${title}' 리서치를 마쳤습니다 (페이지 ${run.pages}개${run.status === 'partial' ? ', 예산·한도로 일부만' : ''})`
				: run.status === 'skipped'
					? `'${title}': 새로 읽은 관련 페이지가 없습니다`
					: run.status === 'cancelled'
						? `'${title}' 리서치를 멈췄습니다`
						: `'${title}' 리서치가 실패했습니다 (${run.error})`;
		toast(text, run.status === 'failed' ? 'error' : 'info');
		const target = `/research/${run.researchId}`;
		if (inApp && run.status !== 'cancelled')
			void nativeNotify('PROPRIX 리서치', text, target, (t) => this.openFromNotification(t)).catch(() => {});
	}

	// ---- 사이트 계정 (P12c) ----

	siteAccounts(agentId: string) {
		return api(z.array(SiteAccount), `/agents/${agentId}/site-accounts`);
	}

	saveSiteAccount(agentId: string, id: string | null, input: SiteAccountInput) {
		return api(SiteAccount, id ? `/site-accounts/${id}` : `/agents/${agentId}/site-accounts`, {
			method: id ? 'PUT' : 'POST',
			body: input
		});
	}

	deleteSiteAccount(id: string) {
		return api(z.unknown(), `/site-accounts/${id}`, { method: 'DELETE' });
	}

	testSiteAccount(id: string) {
		return api(z.object({ outcome: z.string(), account: SiteAccount.nullable() }), `/site-accounts/${id}/test`, { method: 'POST' });
	}

	// 자동 로그인이 멈추면 알린다 (무인 실행에서도 알 수 있게)
	private onSiteAccount(a: SiteAccount) {
		const prev = this.siteAccountChanged;
		this.siteAccountChanged = a;
		if ((a.status !== 'failed' && a.status !== 'needs_attention') || (prev?.id === a.id && prev.status === a.status)) return;
		const text = `${a.domain}: 자동 로그인을 멈췄습니다 (${this.look(a.agentId).name}). 에이전트 편집기에서 확인하세요`;
		toast(text, 'error');
		if (inApp) void nativeNotify('PROPRIX 리서치', text, '/agents', (t) => this.openFromNotification(t)).catch(() => {});
	}

	// ---- 리서치 브라우저 (P11a) ----

	async loadBrowser() {
		this.browser = await api(BrowserStatus, '/research/browser');
	}

	async browserAction(action: 'install' | 'cancel' | 'remove') {
		this.browser =
			action === 'remove'
				? await api(BrowserStatus, '/research/browser', { method: 'DELETE' })
				: await api(BrowserStatus, `/research/browser/${action}`, { method: 'POST' });
	}

	async loadUsage() {
		this.usage = await api(UsageToday, '/usage');
	}

	// 사용량 히트맵: 최근 days 일의 날짜·기능별 요청 수
	async loadUsageHistory(days: number): Promise<UsageHistory> {
		return api(UsageHistory, `/usage/history?days=${days}`);
	}

	async loadLounge() {
		[this.lounge, this.usage, this.embedding] = await Promise.all([
			api(LoungeStatus, '/lounge'),
			api(UsageToday, '/usage'),
			api(EmbeddingStatus, '/memory/embedding')
		]);
	}

	async patchSettings(patch: z.infer<typeof SettingsPatch>) {
		this.settings = await api(Settings, '/settings', { method: 'PATCH', body: patch });
	}

	async runLoungeNow() {
		await api(LoungeSession, '/lounge/run', { method: 'POST', body: { model: this.model } });
		await this.loadLounge();
	}

	// ---- 장기 메모리 ----

	// 관리 화면·'참고한 기억' 표시용: 이력(대체된 기억)까지 모두 불러둔다 (개인 규모)
	async loadMemories() {
		this.memories = await api(z.array(Memory), '/memories?history=1');
		this.memoriesLoaded = true;
	}

	memory(id: string): Memory | undefined {
		return this.memories.find((m) => m.id === id);
	}

	scopeLabel(scope: string): string {
		return scope === SHARED_SCOPE ? '공용' : `${this.look(scope).name} 전용`;
	}

	async saveMemory(id: string | null, input: MemoryInput) {
		await api(Memory, id ? `/memories/${id}` : '/memories', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadMemories();
	}

	async deleteMemory(id: string) {
		await api(z.unknown(), `/memories/${id}`, { method: 'DELETE' });
		await this.loadMemories();
	}

	// ---- 기억 관리 (P10e) ----

	/** 기억마다 참고로 넣은 답변 수 */
	memoryUseCounts(): Promise<Record<string, number>> {
		return api(z.record(z.string(), z.number()), '/memories/use-counts');
	}

	/** 이 기억을 참고로 넣은 답변 (최신 50개) */
	memoryUses(id: string) {
		return api(MemoryUses, `/memories/${id}/uses`);
	}

	async bulkMemories(req: Omit<MemoryBulkRequest, 'delete'> & { delete?: boolean }): Promise<number> {
		const r = await api(z.object({ count: z.number() }), '/memories/bulk', { method: 'POST', body: req });
		await this.loadMemories();
		return r.count;
	}

	/** 새 기억을 만들고 원본은 대체됨으로 */
	async mergeMemories(ids: string[], memory: MemoryInput): Promise<Memory> {
		const m = await api(Memory, '/memories/merge', { method: 'POST', body: { ids, memory } });
		await this.loadMemories();
		return m;
	}

	memoryGraph() {
		return api(MemoryGraph, '/memories/graph');
	}

	async extractMemories(): Promise<string> {
		const r = await api(ExtractResult, `/rooms/${this.roomId}/extract-memories`, { method: 'POST' });
		if (r.skipped === 'nothing_new') return '새로 추출할 채팅이 없습니다.';
		if (r.skipped === 'lounge') return '라운지 채팅은 기억을 추출하지 않습니다 (설정에서 켤 수 있습니다).';
		if (r.skipped === 'subchat') return '서브 채팅은 기억을 저장하지 않습니다.';
		if (r.skipped) return `추출하지 못했습니다 (${r.skipped}).`;
		return `기억 ${r.saved}개 저장${r.superseded ? `, ${r.superseded}개 대체` : ''}`;
	}

	// 새 방을 만든다 (여는 것은 호출한 쪽이 /rooms/{id} 로 이동)
	async newRoom(agentIds?: string[], title?: string, chainLimit?: number): Promise<Room> {
		const one = agentIds?.length === 1 ? this.agent(agentIds[0] ?? '') : undefined;
		const room = await api(Room, '/rooms', {
			method: 'POST',
			body: agentIds?.length
				? { title: title ?? (one ? `새 채팅 (${one.name})` : '그룹챗'), agentIds, ...(chainLimit ? { chainLimit } : {}) }
				: {}
		});
		this.rooms = [room, ...this.rooms];
		return room;
	}

	async updateRoom(
		patch: {
			agentIds?: string[];
			chainLimit?: number;
			title?: string;
			pinned?: boolean;
			archived?: boolean;
			workspace?: string;
			workspaceRules?: WorkspaceRules;
			shellEnabled?: boolean;
		},
		id = this.roomId
	) {
		const room = await api(Room, `/rooms/${id}`, { method: 'PATCH', body: patch });
		this.rooms = this.rooms.map((r) => (r.id === room.id ? room : r));
	}

	async deleteRoom(id: string) {
		await api(z.unknown(), `/rooms/${id}`, { method: 'DELETE' });
		this.rooms = this.rooms.filter((r) => r.id !== id);
		if (this.roomId === id) this.roomId = '';
	}

	// ---- 방 묶음 (사이드바) ----

	// 목록 순서: 고정한 방 먼저, 그다음 최근 순. 보관한 방은 빼고 (보관함에서 따로)
	private listed(rooms: Room[]): Room[] {
		return rooms
			.filter((r) => !r.archived && !this.nested(r))
			.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.updatedAt - x.updatedAt);
	}

	// 그 에이전트 혼자 있는 일반 방 (최근 순)
	soloRooms(agentId: string): Room[] {
		return this.listed(this.rooms.filter((r) => r.kind === 'chat' && r.agentIds.length === 1 && r.agentIds[0] === agentId));
	}

	get groupRooms(): Room[] {
		return this.listed(this.rooms.filter((r) => r.kind === 'chat' && r.agentIds.length > 1));
	}

	// 부모가 있는 서브 채팅은 부모 밑에 (부모가 지워졌으면 제자리에)
	private nested(r: Room): boolean {
		return !!r.parentRoomId && this.rooms.some((x) => x.id === r.parentRoomId);
	}

	subchatsOf(parentId: string): Room[] {
		return this.rooms
			.filter((r) => r.parentRoomId === parentId && !r.archived)
			.sort((x, y) => y.updatedAt - x.updatedAt);
	}

	async createSubchat(roomId: string, body: { messageId?: string; agentIds?: string[]; title?: string }): Promise<Room> {
		const room = await api(Room, `/rooms/${roomId}/subchat`, { method: 'POST', body });
		if (!this.rooms.some((r) => r.id === room.id)) this.rooms = [room, ...this.rooms];
		return room;
	}

	async roomReference(id: string): Promise<string> {
		return (await api(z.object({ reference: z.string() }), `/rooms/${id}/reference`)).reference;
	}

	get archivedRooms(): Room[] {
		return this.rooms.filter((r) => r.archived).sort((x, y) => y.updatedAt - x.updatedAt);
	}

	get loungeRoom(): Room | undefined {
		return this.rooms.find((r) => r.kind === 'lounge');
	}

	// 사이드바 에이전트 순서: 최근 활동(상태·방) 순
	get agentsByActivity(): Agent[] {
		const last = (a: Agent) => Math.max(this.statuses[a.id]?.at ?? 0, this.soloRooms(a.id)[0]?.updatedAt ?? 0, a.createdAt);
		return [...this.agents].sort((x, y) => last(y) - last(x));
	}

	// 사이드바·홈 순서: 사용자가 정한 순서, 그 뒤에 아직 자리를 안 정한 (새) 에이전트를 최근 활동 순으로
	get orderedAgents(): Agent[] {
		const byActivity = this.agentsByActivity;
		if (this.agentOrder.length === 0) return byActivity;
		const rank = new Map(this.agentOrder.map((id, i) => [id, i]));
		const placed = byActivity.filter((a) => rank.has(a.id));
		placed.sort((x, y) => (rank.get(x.id) ?? 0) - (rank.get(y.id) ?? 0));
		return [...placed, ...byActivity.filter((a) => !rank.has(a.id))];
	}

	/** id 를 지금 순서의 to 번째 자리로 옮긴다 (to 는 id 를 뺀 목록 기준) */
	moveAgent(id: string, to: number) {
		const ids = this.orderedAgents.map((a) => a.id).filter((x) => x !== id);
		ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
		this.agentOrder = ids;
		try {
			localStorage.setItem('proprix.agentOrder', JSON.stringify(ids));
		} catch {
			// 저장소를 못 쓰면 이번 실행에만
		}
	}

	async loadStatuses() {
		const list = await api(z.array(AgentStatus), '/agents/status');
		this.statuses = Object.fromEntries(list.map((s) => [s.agentId, s]));
	}

	setScale(scale: DisplayScale) {
		this.scale = scale;
		if (scale === 'normal') delete document.documentElement.dataset.scale;
		else document.documentElement.dataset.scale = scale;
		try {
			localStorage.setItem('proprix.scale', scale);
		} catch {
			// 저장 못 해도 이번 실행에는 적용된다
		}
	}

	setCharacterMotion(on: boolean) {
		this.characterMotion = on;
		try {
			localStorage.setItem('proprix.characterMotion', on ? '1' : '0');
		} catch {
			// 저장 못 해도 이번 실행에는 적용된다
		}
	}

	// 테마가 바꾼 화면 이름 (없으면 기본 이름)
	label(key: string, fallback: string): string {
		return this.themes.find((t) => t.id === this.theme)?.labels[key] ?? fallback;
	}

	// 테마 (docs/theme-pack.md): 앱에는 기본 테마만 있고 다른 테마는 zip 으로 올린다
	async loadThemes() {
		this.themes = await api(z.array(ThemeInfo), '/themes');
		if (this.theme === DEFAULT_THEME) return;
		// 지워졌으면 기본으로, 있으면 글꼴까지 받아 적용한다
		if (this.themes.some((t) => t.id === this.theme)) await this.setTheme(this.theme);
		else await this.setTheme(DEFAULT_THEME);
	}

	async setTheme(id: string) {
		const bundle = id === DEFAULT_THEME ? null : await api(ThemeBundle, `/themes/${id}`);
		applyTheme(bundle);
		this.theme = bundle?.id ?? DEFAULT_THEME;
	}

	async uploadTheme(file: File) {
		const t = await apiFile(ThemeInfo, '/themes', file);
		this.themes = await api(z.array(ThemeInfo), '/themes');
		await this.setTheme(t.id);
	}

	async removeTheme(id: string) {
		await api(z.object({ ok: z.boolean() }), `/themes/${id}`, { method: 'DELETE' });
		if (this.theme === id) await this.setTheme(DEFAULT_THEME);
		this.themes = await api(z.array(ThemeInfo), '/themes');
	}

	setRailLabels(on: boolean) {
		this.railLabels = on;
		if (on) document.documentElement.dataset.rail = 'labels';
		else delete document.documentElement.dataset.rail;
		try {
			localStorage.setItem('proprix.railLabels', on ? '1' : '0');
		} catch {
			// 저장 못 해도 이번 실행에는 적용된다
		}
	}

	// 창 폭에 맞춘 자동 접기: 저장한 선택은 건드리지 않는다
	fitPanel(room: boolean) {
		this.panelOpen = room ? readPanelOpen() : false;
	}

	togglePanel(open = !this.panelOpen) {
		this.panelOpen = open;
		try {
			localStorage.setItem('proprix.panel', open ? '1' : '0');
		} catch {
			// 저장소를 못 쓰면 이번 실행에만
		}
	}

	// ---- 페르소나·에이전트 ----

	async loadAgents() {
		[this.personas, this.agents] = await Promise.all([
			api(z.array(Persona), '/personas'),
			api(z.array(Agent), '/agents')
		]);
	}

	async savePersona(id: string | null, input: PersonaInput): Promise<Persona> {
		const p = await api(Persona, id ? `/personas/${id}` : '/personas', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadAgents();
		return p;
	}

	async deletePersona(id: string) {
		await api(z.unknown(), `/personas/${id}`, { method: 'DELETE' });
		await this.loadAgents();
	}

	// 표정 묶음 (docs/character-pack.md): 편집기의 저장과 따로 바로 적용된다
	async uploadCharacter(personaId: string, file: File) {
		await apiFile(Persona, `/personas/${personaId}/character`, file);
		await this.loadAgents();
	}

	async removeCharacter(personaId: string) {
		await api(Persona, `/personas/${personaId}/character`, { method: 'DELETE' });
		await this.loadAgents();
	}

	async importPersona(file: File): Promise<Persona> {
		const text = await file.text();
		const body = file.name.toLowerCase().endsWith('.json')
			? { format: 'json', data: JSON.parse(text) as unknown }
			: { format: 'markdown', text };
		const p = await api(Persona, '/personas/import', { method: 'POST', body });
		await this.loadAgents();
		return p;
	}

	async saveAgent(id: string | null, input: AgentInput): Promise<Agent> {
		const a = await api(Agent, id ? `/agents/${id}` : '/agents', { method: id ? 'PUT' : 'POST', body: input });
		await this.loadAgents();
		return a;
	}

	async deleteAgent(id: string) {
		await api(z.unknown(), `/agents/${id}`, { method: 'DELETE' });
		await this.loadAgents();
	}

	preview(persona: PersonaInput, name: string, role: string, text: string, model: string) {
		return api(PreviewResponse, '/agents/preview', {
			method: 'POST',
			body: { persona, name, role, text, model }
		});
	}

	async send(text: string, attachments: AttachmentInput[] = []) {
		await this.sendTo(this.roomId, text, attachments);
	}

	/** 방을 정해 보낸다 (홈 '빠른 시작'처럼 아직 열지 않은 방). 응답 메시지는 화자가 정해지면 WS 로 온다 */
	async sendTo(roomId: string, text: string, attachments: AttachmentInput[] = []) {
		const r = await api(SendMessageResponse, `/rooms/${roomId}/messages`, {
			method: 'POST',
			body: { text, model: this.model, attachments }
		});
		if (roomId === this.roomId) this.upsert(r.user);
	}

	// ---- 검색 ----

	async search(p: { q: string; room?: string; agent?: string; from?: number; to?: number; limit?: number }) {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') q.set(k, String(v));
		return api(SearchResponse, `/search?${q}`);
	}

	// ---- 작업 폴더 ----

	async loadFileChanges() {
		if (this.roomId) this.fileChanges = await api(z.array(FileChange), `/rooms/${this.roomId}/file-changes`);
	}

	// ---- 도구 실행 감사 로그 (P10b) ----

	async loadAudit(q: { room?: string; group?: ToolGroup | ''; status?: string; before?: string }): Promise<AuditPage> {
		const p = new URLSearchParams({ limit: '50' });
		for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
		return api(AuditPage, `/tool-calls?${p}`);
	}

	/** 도구가 만든 메모를 지우거나 리마인더를 취소한다 */
	async undoToolCall(id: string) {
		await api(z.unknown(), `/tool-calls/${id}/undo`, { method: 'POST' });
	}

	/** 작업 폴더에 직접 저장 (토론 산출물). 같은 이름이 있으면 ApiFailure(409) — 확인 뒤 overwrite */
	async saveFile(input: { path: string; content: string; messageId: string; overwrite: boolean }) {
		const c = await api(FileChange, `/rooms/${this.roomId}/files`, { method: 'POST', body: input });
		await this.loadFileChanges();
		return c;
	}

	/** 원본으로 되돌린다. 그 뒤 파일이 또 바뀌었으면 ApiFailure(409) — 확인 뒤 force */
	async restoreChange(id: string, force = false) {
		await api(z.unknown(), `/file-changes/${id}/restore`, { method: 'POST', body: { force } });
		await this.loadFileChanges();
	}

	snapshotUsage() {
		return api(SnapshotUsage, '/snapshots');
	}

	clearSnapshots() {
		return api(SnapshotUsage, '/snapshots', { method: 'DELETE' });
	}

	attachmentContent(id: string) {
		return api(AttachmentContent, `/attachments/${id}`);
	}

	exportRoom(id: string) {
		const title = this.rooms.find((r) => r.id === id)?.title ?? '채팅';
		return download(`/rooms/${id}/export`, `${title}.md`);
	}

	async loadBackups() {
		this.backups = await api(BackupInfo, '/backup');
	}

	async backupNow() {
		this.backups = await api(BackupInfo, '/backup', { method: 'POST' });
	}

	/** 다음 시작 때 이 백업으로 복구하도록 표시한다 */
	async requestRestore(name: string) {
		this.backups = await api(BackupInfo, '/backup/restore', { method: 'POST', body: { name } });
	}

	async cancelRestore() {
		this.backups = await api(BackupInfo, '/backup/restore', { method: 'DELETE' });
	}

	// 지난 시작에서 적용한 복구의 결과를 한 번 알린다
	private async reportRestore() {
		const { result } = (await api(BackupInfo, '/backup')).restore;
		if (!result) return;
		if (result.ok) toast('백업을 복구했습니다', 'success');
		else toast(`백업을 복구하지 못했습니다: ${result.error}. 지금 데이터는 그대로입니다.`, 'error');
		this.backups = await api(BackupInfo, '/backup/restore-result', { method: 'DELETE' });
	}

	async loadPendingCalls() {
		this.pendingCalls = await api(z.array(ToolCall), '/tool-calls/pending');
	}

	/** 수정해서 다시 보내기 (text) · 답 다시 받기 (text 없음). 그 뒤 대화는 daemon 이 지우고 이벤트로 알려 준다 */
	async rewind(messageId: string, text?: string) {
		const r = await api(SendMessageResponse, `/rooms/${this.roomId}/messages/${messageId}/rewind`, {
			method: 'POST',
			body: { text, model: this.model }
		});
		this.upsert(r.user);
	}

	debate(id: string): Debate | undefined {
		return this.debates.find((d) => d.id === id);
	}

	async startDebate(input: Omit<StartDebateRequest, 'model'>) {
		const d = await api(Debate, `/rooms/${this.roomId}/debates`, {
			method: 'POST',
			body: { ...input, model: this.model }
		});
		if (!this.debates.some((x) => x.id === d.id)) this.debates.push(d);
	}

	async cancel() {
		await api(z.unknown(), `/rooms/${this.roomId}/cancel`, { method: 'POST' });
	}
}

/** 방해 금지 시간대가 끝날 때까지 남은 시간 (시간대 밖이면 0). 로컬 시각, 자정을 넘을 수 있음 */
function quietLeftMs(p: Settings['proactive'], now = Date.now()): number {
	if (!p.quietEnabled) return 0;
	const d = new Date(now);
	const h = d.getHours();
	const inQuiet = p.quietStart < p.quietEnd ? h >= p.quietStart && h < p.quietEnd : h >= p.quietStart || h < p.quietEnd;
	if (!inQuiet) return 0;
	const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), p.quietEnd, 0, 0, 0);
	if (end.getTime() <= now) end.setDate(end.getDate() + 1);
	return end.getTime() - now;
}

function readAgentOrder(): string[] {
	try {
		const v: unknown = JSON.parse(localStorage.getItem('proprix.agentOrder') ?? '[]');
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

export type DisplayScale = 'small' | 'normal' | 'large';

function readScale(): DisplayScale {
	try {
		const s = localStorage.getItem('proprix.scale');
		return s === 'small' || s === 'large' ? s : 'normal';
	} catch {
		return 'normal';
	}
}

function readCharacterMotion(): boolean {
	try {
		return localStorage.getItem('proprix.characterMotion') !== '0';
	} catch {
		return true;
	}
}

function readRailLabels(): boolean {
	try {
		return localStorage.getItem('proprix.railLabels') === '1';
	} catch {
		return false;
	}
}

function readPanelOpen(): boolean {
	try {
		return localStorage.getItem('proprix.panel') !== '0';
	} catch {
		return true;
	}
}

export const app = new AppState();

export function describeFailure(m: Message): string {
	switch (m.recovery) {
		case 'usage_limit':
			return 'ChatGPT 플랜 사용량 한도에 도달했습니다.';
		case 're_sign_in':
			return '다시 로그인이 필요합니다.';
		case 'not_eligible':
			return m.errorCode === 'plan_usage_disabled'
				? 'ChatGPT 플랜 사용 권한이 없습니다. 다시 로그인해 권한을 허용하세요.'
				: '이 계정은 ChatGPT 플랜 사용 대상이 아닙니다.';
		case 'none':
			if (m.errorCode === 'daily_budget_exceeded')
				return '오늘 이 기능의 일일 예산을 다 썼습니다 (설정에서 바꿀 수 있음).';
			break;
		case 'restricted':
			return '정책 또는 지역 제한으로 요청이 거부되었습니다.';
		case 'network':
			return m.errorCode === 'first_token_timeout' ? '응답이 너무 오래 걸려 중단했습니다.' : '네트워크 오류로 끊겼습니다.';
		case 'retry_backoff':
			return '서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도하세요.';
		case 'fix_request':
			return `지원하지 않는 요청입니다 (${m.errorCode}).`;
	}
	if (m.errorCode === 'cancelled') return '중지됨';
	if (m.errorCode === 'daemon_restarted') return 'daemon 재시작으로 중단됨';
	return m.errorCode ? `오류: ${m.errorCode}` : '';
}
