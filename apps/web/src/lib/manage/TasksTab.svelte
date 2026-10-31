<script lang="ts">
	// '활동' 화면의 예약 작업 탭 (P8): 정한 시각에 에이전트가 도구를 써서 일하고 고른 방에 보고한다.
	// 사용자가 없을 때 돌므로, 확인이 필요한 쓰기는 미리 허용한 도구만 (명령 실행·skill 스크립트는 안 됨)
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError, toastRun } from '#lib/ui/toast.svelte.js';
	import ScheduleEditor, { shortWhen as short } from '#lib/manage/ScheduleEditor.svelte';
	import type { Task, TaskRun, TaskSchedule } from '@proprix/shared';
	import IconCalendarRepeat from '@tabler/icons-svelte-runes/icons/calendar-repeat';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconHistory from '@tabler/icons-svelte-runes/icons/history';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlayerPlay from '@tabler/icons-svelte-runes/icons/player-play';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';

	const STATUS: Record<string, string> = { running: '실행 중', done: '완료', failed: '실패', skipped: '건너뜀', cancelled: '중지' };
	const REASON: Record<string, string> = {
		missed: '놓침 (PC 꺼짐·잠자기 등)',
		budget: '오늘 예산을 다 씀',
		busy: '그 채팅이 계속 응답 중',
		paused: '사용량 한도로 멈춤',
		timeout: '10분 제한 시간 초과',
		interrupted: '앱 종료로 중단',
		no_model: '모델이 정해지지 않음',
		not_found: '에이전트가 채팅에 없음'
	};
	const roomTitle = (id: string) => app.rooms.find((r) => r.id === id)?.title ?? '(삭제한 채팅)';

	// ---- 편집 (undefined: 닫힘, null: 새로) ----
	let editing = $state<Task | null | undefined>(undefined);
	let form = $state({
		title: '',
		prompt: '',
		agentId: '',
		roomId: '',
		allowedTools: [] as string[],
		enabled: true
	});
	let saving = $state(false);

	function open(t: Task | null) {
		editing = t;
		const agentId = t?.agentId ?? app.agents[0]?.id ?? '';
		form = {
			title: t?.title ?? '',
			prompt: t?.prompt ?? '',
			agentId,
			roomId: t?.roomId ?? roomsOf(agentId)[0]?.id ?? '',
			allowedTools: [...(t?.allowedTools ?? [])],
			enabled: t?.enabled ?? true
		};
	}

	// 그 에이전트가 있는 방 (라운지·보관 제외)
	const roomsOf = (agentId: string) =>
		app.rooms.filter((r) => r.kind === 'chat' && !r.archived && r.agentIds.includes(agentId));

	// 일정 입력 (ScheduleEditor 가 채운다)
	let schedule = $state<TaskSchedule>({ kind: 'daily', time: '09:00' });
	let scheduleErr = $state('');

	// 미리 허용할 수 있는 도구: 그 에이전트의 쓰기 도구 (명령 실행·skill 스크립트·예약 작업 도구 제외) + 켠 MCP 서버의 확인 필요 도구
	const agent = $derived(app.agent(form.agentId));
	const toolChoices = $derived.by(() => {
		const a = agent;
		if (!a) return [];
		const local = app.tools
			.filter((t) => t.kind === 'write' && a.tools.includes(t.name) && !t.name.startsWith('task_'))
			.map((t) => ({ name: t.name, title: t.title, blocked: t.alwaysConfirm ? '매번 확인하는 도구라 예약 작업에서 쓸 수 없습니다' : '' }));
		const mcp = app.mcpServers
			.filter((s) => s.enabled && a.mcpServers.includes(s.id))
			.flatMap((s) =>
				s.tools
					.filter((t) => t.enabled && !t.changed && !(s.trust === 'readonly-auto' && t.readOnly))
					.map((t) => ({ name: t.exposed, title: `${s.name} · ${t.title}`, blocked: '' }))
			);
		return [...local, ...mcp];
	});
	const toggleTool = (name: string, on: boolean) =>
		(form.allowedTools = on ? [...form.allowedTools, name] : form.allowedTools.filter((x) => x !== name));

	const canSave = $derived(!!form.title.trim() && !!form.prompt.trim() && !!form.agentId && !!form.roomId && !scheduleErr && !saving);

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			const t = await app.saveTask(editing?.id ?? null, {
				title: form.title.trim(),
				prompt: form.prompt.trim(),
				agentId: form.agentId,
				roomId: form.roomId,
				schedule,
				// 지금 고를 수 있는 것만 (에이전트를 바꿨으면 그쪽 도구로)
				allowedTools: form.allowedTools.filter((n) => toolChoices.some((c) => c.name === n && !c.blocked)),
				enabled: form.enabled
			});
			toast(`'${t.title}' 을(를) 저장했습니다`, 'success');
			editing = undefined;
		} catch (e) {
			toastError(e);
		} finally {
			saving = false;
		}
	}

	// ---- 목록 동작 ----
	async function toggle(t: Task) {
		try {
			await app.saveTask(t.id, { ...t, enabled: !t.enabled });
		} catch (e) {
			toastError(e);
		}
	}
	async function runNow(t: Task) {
		try {
			await app.runTaskNow(t.id);
			toast(`'${t.title}' 을(를) 실행합니다 — 결과는 '${roomTitle(t.roomId)}' 채팅에`, 'success');
		} catch (e) {
			toastError(e);
		}
	}
	let history = $state<{ task: Task; runs: TaskRun[] } | null>(null);
	async function openHistory(t: Task) {
		try {
			history = { task: t, runs: await app.taskRuns(t.id) };
		} catch (e) {
			toastError(e);
		}
	}
	let removing = $state<Task | null>(null);
	async function confirmRemove() {
		const t = removing;
		removing = null;
		if (t) await toastRun(() => app.deleteTask(t.id), `'${t.title}' 을(를) 삭제했습니다`);
	}

	const items = (t: Task): MenuItem[] => [
		{ label: '지금 실행', icon: IconPlayerPlay, disabled: t.lastStatus === 'running', onSelect: () => void runNow(t) },
		{ label: '실행 기록', icon: IconHistory, onSelect: () => void openHistory(t) },
		{ label: '편집', icon: IconPencil, onSelect: () => open(t) },
		{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = t) }
	];
	const lastText = (t: Task) => (t.lastStatus ? `마지막 ${STATUS[t.lastStatus] ?? t.lastStatus}${t.lastRunAt ? ` (${short(t.lastRunAt)})` : ''}` : '아직 실행 안 함');
</script>

<div class="page">
	<header>
		<span class="grow"></span>
		<Button variant="primary" icon={IconPlus} disabled={app.agents.length === 0} onclick={() => open(null)}>새 작업</Button>
	</header>
	<p class="hint">
		정한 시각에 에이전트가 도구를 써서 일하고, 고른 채팅에 결과를 남기며 알립니다. 사용자가 없을 때 돌므로 확인이 필요한 쓰기는 미리 허용한
		도구만 하고 나머지는 거절해 보고에 적습니다(웹 검색·MCP·명령 결과를 본 뒤에는 허용한 도구도 거절). 명령 실행·Skill 스크립트는 쓸 수
		없습니다. PC 가 꺼져 놓친 회차는 건너뛰고, 방해 금지 시간대에는 실행만 하고 알림은 끝난 뒤에 보냅니다. 채팅 중에 에이전트에게 부탁해
		만들 수도 있습니다 (확인 카드).
	</p>

	{#if app.tasks.length === 0}
		<EmptyState icon={IconCalendarRepeat} title="예약 작업이 없어요" body="매일 아침 정리처럼 반복할 일을 맡겨 보세요." />
	{/if}
	<ul class="rows">
		{#each app.tasks as t (t.id)}
			<li class:off={!t.enabled}>
				<button class="main" onclick={() => open(t)}>
					<Avatar agentId={t.agentId} size={1.6} />
					<span class="text">
						<span class="name">{t.title}{#if t.lastStatus === 'running'}<span class="tag">실행 중</span>{/if}</span>
						<span class="meta"
							>{t.scheduleText} · {app.look(t.agentId).name} → {roomTitle(t.roomId)} · {t.enabled && t.nextRunAt
								? `다음 ${short(t.nextRunAt)}`
								: '꺼짐'} · {lastText(t)}</span
						>
					</span>
				</button>
				<label class="switch" title={t.enabled ? '끄기' : '켜기'}>
					<input type="checkbox" checked={t.enabled} onchange={() => toggle(t)} aria-label="{t.title} 켜기" />
				</label>
				<Menu items={items(t)}>
					{#snippet trigger({ toggle: tg, props })}
						<IconButton icon={IconDots} label="{t.title} 메뉴" size="sm" onclick={tg} {...props} />
					{/snippet}
				</Menu>
			</li>
		{/each}
	</ul>
</div>

<Dialog open={editing !== undefined} title={editing ? '예약 작업 편집' : '새 예약 작업'} width={640} onclose={() => (editing = undefined)}>
	<form
		id="task-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="제목">
			<input bind:value={form.title} maxlength="80" />
		</Field>
		<div class="two">
			<Field label="에이전트">
				<select
					bind:value={form.agentId}
					onchange={() => {
						form.roomId = roomsOf(form.agentId)[0]?.id ?? '';
						form.allowedTools = [];
					}}
				>
					{#each app.agents as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
				</select>
			</Field>
			<Field label="결과를 남길 채팅" hint="작업 폴더·명령 실행 설정도 이 채팅의 것을 씁니다" error={form.agentId && roomsOf(form.agentId).length === 0 ? '이 에이전트가 있는 채팅이 없습니다' : ''}>
				<select bind:value={form.roomId}>
					{#each roomsOf(form.agentId) as r (r.id)}<option value={r.id}>{r.title}</option>{/each}
				</select>
			</Field>
		</div>
		<Field label="할 일" hint="에이전트가 실행할 때마다 따를 지시입니다">
			<textarea bind:value={form.prompt} rows="5" maxlength="8000"></textarea>
		</Field>

		<fieldset class="sched">
			<legend>일정</legend>
			<ScheduleEditor initial={editing?.schedule ?? null} bind:schedule bind:error={scheduleErr} />
		</fieldset>

		<fieldset class="sched">
			<legend>확인 없이 할 쓰기 도구</legend>
			<p class="hint">실행 중 이 도구들만 바로 쓰고, 그 밖의 쓰기는 거절해 보고에 적습니다. 읽기 도구는 고르지 않아도 씁니다.</p>
			{#if toolChoices.length === 0}
				<p class="hint">이 에이전트에게 고를 수 있는 쓰기 도구가 없습니다.</p>
			{:else}
				<div class="tools">
					{#each toolChoices as c (c.name)}
						<label class="check" class:blocked={!!c.blocked} title={c.blocked}>
							<input
								type="checkbox"
								disabled={!!c.blocked}
								checked={!c.blocked && form.allowedTools.includes(c.name)}
								onchange={(e) => toggleTool(c.name, e.currentTarget.checked)}
							/>
							<span>{c.title}{#if c.blocked}<span class="hint"> · 쓸 수 없음</span>{/if}</span>
						</label>
					{/each}
				</div>
			{/if}
		</fieldset>
		<label class="check"><input type="checkbox" bind:checked={form.enabled} /> 켜기</label>
	</form>
	{#snippet footer()}
		<Button onclick={() => (editing = undefined)}>취소</Button>
		<Button variant="primary" type="submit" form="task-form" disabled={!canSave}>저장</Button>
	{/snippet}
</Dialog>

<Dialog open={history !== null} title={history ? `'${history.task.title}' 실행 기록` : ''} width={600} onclose={() => (history = null)}>
	{#if history}
		{#if history.runs.length === 0}
			<p class="hint">아직 실행 기록이 없습니다.</p>
		{:else}
			<ul class="runs">
				{#each history.runs as r (r.id)}
					<li>
						<span class="st {r.status}">{STATUS[r.status] ?? r.status}</span>
						<span class="when">{short(r.startedAt)}{r.scheduledFor === null ? ' · 지금 실행' : ''}</span>
						<span class="detail"
							>{r.reason ? (REASON[r.reason] ?? r.reason) : ''}{r.requests ? ` · 요청 ${r.requests}회` : ''}{r.rejected
								? ` · 거절 ${r.rejected}건`
								: ''}</span
						>
						{#if r.messageId}
							<Button
								size="sm"
								variant="ghost"
								onclick={() => {
									const room = history?.task.roomId;
									history = null;
									void goto(`/rooms/${room}?m=${r.messageId}`);
								}}>결과 보기</Button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</Dialog>

<ConfirmDialog open={removing !== null} title="예약 작업 삭제" onconfirm={confirmRemove} onclose={() => (removing = null)}>
	<p>'{removing?.title}' 을(를) 삭제할까요? 실행 기록도 함께 삭제합니다. 이미 남긴 결과 메시지는 그대로입니다.</p>
</ConfirmDialog>

<style>
	/* '활동' 화면의 탭 안에 들어간다 (바깥 여백·스크롤은 그쪽에서) */
	.page {
		display: grid;
		align-content: start;
		gap: var(--s-4);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.grow {
		flex: 1;
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.125rem;
	}
	.rows li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding-right: var(--s-2);
		border-radius: var(--r-3);
	}
	.rows li:hover {
		background: var(--c-hover);
	}
	.rows li.off .text {
		opacity: 0.55;
	}
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2) var(--s-3);
		border: none;
		background: none;
		text-align: left;
	}
	.main:hover {
		background: none !important;
	}
	.text {
		display: grid;
		min-width: 0;
	}
	.name {
		font-weight: var(--w-bold);
	}
	.tag {
		margin-left: var(--s-2);
		font-size: var(--t-xs);
		font-weight: var(--w-regular);
		color: var(--c-working);
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.switch input {
		width: 1rem;
		height: 1rem;
	}
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-3);
	}
	.sched {
		display: grid;
		gap: var(--s-2);
		margin: 0;
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
	legend {
		padding: 0 var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.tools {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-1) var(--s-3);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
	.check.blocked {
		color: var(--c-text-4);
	}
	.runs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
		max-height: 60vh;
		overflow-y: auto;
		font-size: var(--t-sm);
	}
	.runs li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.st {
		flex: none;
		min-width: 3.5rem;
		font-weight: var(--w-bold);
	}
	.st.done {
		color: var(--c-success);
	}
	.st.failed {
		color: var(--c-danger);
	}
	.st.skipped,
	.st.cancelled {
		color: var(--c-text-3);
	}
	.when {
		color: var(--c-text-2);
	}
	.detail {
		flex: 1;
		color: var(--c-text-3);
	}
</style>
