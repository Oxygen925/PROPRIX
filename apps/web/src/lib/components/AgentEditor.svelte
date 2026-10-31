<script lang="ts">
	// 에이전트 편집기 (전체 화면): 기본 · 도구 · 체크인 · 기억
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import SiteAccounts from '#lib/components/SiteAccounts.svelte';
	import EditorShell from '#lib/manage/EditorShell.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { errorText, toast, toastError } from '#lib/ui/toast.svelte.js';
	import { type Agent, AgentInput, DEFAULT_AGENT_TOOLS, DEFAULT_CHECKIN } from '@proprix/shared';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { untrack } from 'svelte';

	let { agent, onclose, dirty = $bindable(false) }: { agent: Agent | null; onclose: () => void; dirty?: boolean } = $props();

	// 편집 중인 값: 처음 값만 복사한다 (대상이 바뀌면 부모가 {#key} 로 다시 만든다)
	let form = $state(
		untrack(() => ({
			personaId: agent?.personaId ?? app.personas[0]?.id ?? '',
			name: agent?.name ?? '',
			role: agent?.role ?? '',
			model: agent?.model ?? '',
			tools: [...(agent?.tools ?? DEFAULT_AGENT_TOOLS)],
			autoApproveWrites: agent?.autoApproveWrites ?? false,
			webSearch: agent?.webSearch ?? false,
			memoryIsolated: agent?.memoryIsolated ?? false,
			// 저장할 때 같이 보내야 체크인 설정이 지워지지 않는다
			checkin: structuredClone($state.snapshot(agent?.checkin ?? DEFAULT_CHECKIN)),
			reasoningEffort: agent?.reasoningEffort ?? '',
			skills: [...(agent?.skills ?? [])],
			mcpServers: [...(agent?.mcpServers ?? [])]
		}))
	);

	// 저장 안 한 변경: 목록에서 다른 항목을 고를 때 부모가 묻는다
	const saved = untrack(() => JSON.stringify(form));
	$effect(() => {
		dirty = JSON.stringify(form) !== saved;
	});

	const TOOL_GROUPS = [
		{ id: '', title: '기본', hint: '' },
		{
			id: 'workspace',
			title: '작업 폴더',
			hint: '채팅에 작업 폴더를 지정했을 때만 씁니다. 편집·삭제는 정확한 변경 내용을 보고 허용하며 되돌릴 수 있습니다. 기존 에이전트는 꺼져 있습니다.'
		},
		{
			id: 'shell',
			title: '명령 실행',
			hint: '채팅에서 명령 실행을 켰을 때만 씁니다. 매번 확인하며, 폴더 밖에도 영향을 줄 수 있습니다.'
		}
	] as const;

	const sections = [
		{ id: 'basic', label: '기본' },
		{ id: 'tools', label: '도구' },
		{ id: 'skills', label: 'Skill' },
		{ id: 'mcp', label: 'MCP' },
		{ id: 'accounts', label: '사이트 계정' },
		{ id: 'checkin', label: '체크인' },
		{ id: 'memory', label: '기억' }
	];

	const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
	function toggleDay(d: number, on: boolean) {
		form.checkin.days = on ? [...form.checkin.days, d].sort() : form.checkin.days.filter((x) => x !== d);
	}
	// 방해 금지 시간대 안의 체크인은 매일 건너뛴다
	const checkinQuiet = $derived.by(() => {
		const q = app.settings.proactive;
		const h = Number(form.checkin.time.split(':')[0]);
		if (!q.quietEnabled || Number.isNaN(h)) return false;
		return q.quietStart < q.quietEnd ? h >= q.quietStart && h < q.quietEnd : h >= q.quietStart || h < q.quietEnd;
	});

	const skillOn = (name: string) => form.skills.some((s) => s.toLowerCase() === name.toLowerCase());
	function toggleSkill(name: string, on: boolean) {
		form.skills = on ? [...form.skills, name] : form.skills.filter((s) => s.toLowerCase() !== name.toLowerCase());
	}

	function toggleTool(name: string, on: boolean) {
		form.tools = on ? [...form.tools, name] : form.tools.filter((t) => t !== name);
	}
	let error = $state('');
	let saving = $state(false);

	const persona = $derived(app.persona(form.personaId));
	// 저장된 모델이 지금 목록에 없어도 선택지로 보여 준다 (계정마다 모델이 다름)
	const modelOptions = $derived(
		form.model && !app.models.some((m) => m.slug === form.model)
			? [...app.models, { slug: form.model, displayName: `${form.model} (목록에 없음)`, efforts: [] }]
			: app.models
	);
	// 승인 카드에서 쌓인 '항상 허용' (저장과 따로 바로 해제)
	const rules = $derived(agent ? (app.agent(agent.id)?.autoApproveTools ?? []) : []);

	async function save() {
		const parsed = AgentInput.safeParse(form);
		if (!parsed.success) {
			error = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
			return;
		}
		saving = true;
		error = '';
		try {
			await app.saveAgent(agent?.id ?? null, parsed.data);
			toast(agent ? '저장했습니다' : '에이전트를 만들었습니다', 'success');
			onclose();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}

	async function revoke(tool: string) {
		if (!agent) return;
		try {
			await app.revokeTool(agent.id, tool);
		} catch (e) {
			toastError(e);
		}
	}
</script>

<EditorShell embedded title={agent ? `${agent.name} 편집` : '새 에이전트'} {sections} {saving} {error} {onclose} onsave={save}>
	<section id="sec-basic">
		<h2>기본</h2>
		<div class="row top">
			<Avatar emoji={persona?.emoji ?? '❔'} color={persona?.color ?? '#888888'} image={persona?.avatarImage ?? ''} size={2.5} />
			<label class="field grow"><span>이름</span><input bind:value={form.name} maxlength="40" /></label>
			<label class="field grow">
				<span>페르소나 <span class="hint">성격·말투·아바타</span></span>
				<select bind:value={form.personaId}>
					{#each app.personas as p (p.id)}
						<option value={p.id}>{p.emoji} {p.name}</option>
					{/each}
				</select>
			</label>
		</div>
		<label class="field">
			<span>역할 지시문 <span class="hint">이 에이전트가 맡는 일. 첫 줄이 18자 이하면 목록에 직무로 보입니다</span></span>
			<textarea bind:value={form.role} rows="6" maxlength="4000" placeholder="예: 사용자의 일정과 할 일을 챙긴다."></textarea>
		</label>
		<div class="row">
			<label class="field grow">
				<span>모델</span>
				<select bind:value={form.model}>
					<option value="">기본 모델 따름</option>
					{#each modelOptions as m (m.slug)}
						<option value={m.slug}>{m.displayName}</option>
					{/each}
				</select>
			</label>
			<label class="field grow">
				<span>추론 강도</span>
				<select bind:value={form.reasoningEffort}>
					<option value="">자동 (모델 기본값)</option>
					<option value="low">낮음</option>
					<option value="medium">보통</option>
					<option value="high">높음</option>
					<option value="xhigh">매우 높음</option>
				</select>
			</label>
		</div>
		<p class="hint">추론 강도는 이 에이전트의 모든 요청에 쓰입니다. 높을수록 느리고 사용량을 더 씁니다. 채팅 입력창에서도 바꿀 수 있습니다.</p>
	</section>

	<section id="sec-tools">
		<h2>도구</h2>
		{#each TOOL_GROUPS as g (g.id)}
			{@const list = app.tools.filter((t) => (t.requires ?? '') === g.id)}
			{#if list.length}
				<div class="group">
					<h3>{g.title}</h3>
					{#if g.hint}<p class="hint">{g.hint}</p>{/if}
					<div class="tools">
						{#each list as t (t.name)}
							<label class="check">
								<input type="checkbox" checked={form.tools.includes(t.name)} onchange={(e) => toggleTool(t.name, e.currentTarget.checked)} />
								<span
									>{t.title}
									<span class="hint">{t.alwaysConfirm ? '매번 확인' : t.kind === 'write' ? '쓰기 · 실행 전 확인' : '읽기'}</span></span
								>
							</label>
						{/each}
					</div>
				</div>
			{/if}
		{/each}
		<label class="check">
			<input type="checkbox" bind:checked={form.webSearch} />
			<span>웹 검색 <span class="hint">OpenAI 검색을 씁니다. 검색어가 밖으로 나가고 플랜 사용량을 더 씁니다.</span></span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={form.autoApproveWrites} />
			<span>모든 쓰기 도구 확인 없이 <span class="hint"
					>웹 검색·토론·명령 출력이 섞인 답에서는 그래도 확인합니다. 작업 폴더 파일을 읽은 답에서는 폴더 밖으로 이어지는 쓰기(기억·리마인더
					등)를 확인합니다.</span
				></span>
		</label>
		{#if rules.length}
			<div class="field">
				<span>항상 허용한 도구 <span class="hint">승인 카드에서 고른 것. 바로 해제됩니다</span></span>
				<ul class="rules">
					{#each rules as tool (tool)}
						<li>
							<span>{app.toolTitle(tool)}</span>
							<IconButton icon={IconX} label="{app.toolTitle(tool)} 항상 허용 해제" size="sm" onclick={() => revoke(tool)} />
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>

	<section id="sec-skills">
		<h2>Skill</h2>
		<p class="hint">
			켠 Skill 의 이름·설명을 이 에이전트가 알고, 필요할 때 본문을 불러 따릅니다. 스크립트는 채팅에서 명령 실행을 켰을 때만 매번 확인을 거쳐
			실행합니다. 입력창에서 /skill이름 으로 부르면 켜지 않았어도 그 답에만 씁니다.
		</p>
		{#if app.skills.length === 0}
			<p class="hint">설치한 Skill 이 없습니다. <a href="/extensions?tab=skills">확장 화면</a>에서 가져오세요.</p>
		{:else}
			<div class="tools">
				{#each app.skills as s (s.name)}
					<label class="check">
						<input type="checkbox" checked={skillOn(s.name)} onchange={(e) => toggleSkill(s.name, e.currentTarget.checked)} />
						<span
							>{s.name}
							<span class="hint">{s.description}{s.scripts.length ? ` · 스크립트 ${s.scripts.length}개` : ''}</span></span
						>
					</label>
				{/each}
			</div>
		{/if}
	</section>

	<section id="sec-mcp">
		<h2>MCP</h2>
		<p class="hint">
			켠 서버의 도구 중 확장 화면에서 켠 것만 씁니다. 결과는 바깥에서 온 데이터로 다루며, 신뢰 정책이 '확인'인 서버는 '모든 쓰기 도구 확인
			없이'를 켜도 매번 확인합니다 (승인 카드의 도구별 '항상 허용'만 적용).
		</p>
		{#if app.mcpServers.length === 0}
			<p class="hint">등록한 MCP 서버가 없습니다. <a href="/extensions?tab=mcp">확장 화면</a>에서 추가하세요.</p>
		{:else}
			<div class="tools">
				{#each app.mcpServers as s (s.id)}
					<label class="check">
						<input
							type="checkbox"
							checked={form.mcpServers.includes(s.id)}
							onchange={(e) =>
								(form.mcpServers = e.currentTarget.checked
									? [...form.mcpServers, s.id]
									: form.mcpServers.filter((x) => x !== s.id))}
						/>
						<span
							>{s.name}
							<span class="hint"
								>켠 도구 {s.tools.filter((t) => t.enabled).length}개 · {s.trust === 'ask' ? '매번 확인' : '읽기 도구는 바로'}{s.enabled
									? ''
									: ' · 꺼진 서버'}</span
							></span
						>
					</label>
				{/each}
			</div>
		{/if}
	</section>

	<section id="sec-accounts">
		<h2>사이트 계정</h2>
		{#if agent}
			<SiteAccounts agentId={agent.id} />
		{:else}
			<p class="hint">에이전트를 저장한 뒤에 추가할 수 있습니다.</p>
		{/if}
	</section>

	<section id="sec-checkin">
		<h2>정기 체크인</h2>
		<label class="check">
			<input type="checkbox" bind:checked={form.checkin.enabled} />
			<span>정한 시각에 먼저 말 걸기 <span class="hint">이 에이전트 혼자 있는 최근 채팅에. 그때 문구를 만들어 플랜 사용량을 씁니다.</span></span>
		</label>
		{#if form.checkin.enabled}
			<div class="row">
				<label class="field"><span>시각</span><input type="time" bind:value={form.checkin.time} /></label>
				<div class="field">
					<span>요일</span>
					<div class="row days">
						{#each DAY_NAMES as name, d (d)}
							<label class="day">
								<input type="checkbox" checked={form.checkin.days.includes(d)} onchange={(ev) => toggleDay(d, ev.currentTarget.checked)} />
								{name}
							</label>
						{/each}
					</div>
				</div>
			</div>
			{#if checkinQuiet}
				<p class="warn">
					이 시각은 방해 금지 시간대({app.settings.proactive.quietStart}시–{app.settings.proactive.quietEnd}시)라 매일 건너뜁니다.
				</p>
			{/if}
		{/if}
	</section>

	<section id="sec-memory">
		<h2>기억</h2>
		<label class="check">
			<input type="checkbox" bind:checked={form.memoryIsolated} />
			<span>기억 격리 <span class="hint">공용 기억은 읽기만 하고, 새 기억은 이 에이전트 전용으로 저장합니다.</span></span>
		</label>
	</section>
</EditorShell>

<style>
	.top {
		align-items: flex-end;
	}
	.grow {
		flex: 1;
		min-width: 12rem;
	}
	.group {
		display: grid;
		gap: var(--s-2);
	}
	.group h3 {
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.tools {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: var(--s-2) var(--s-4);
	}
	.rules {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.125rem;
	}
	.rules li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 24rem;
	}
	.days {
		gap: var(--s-1);
	}
	.day {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem var(--s-2);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-pill);
	}
	.warn {
		color: var(--c-waiting);
		font-size: var(--t-sm);
	}
</style>
