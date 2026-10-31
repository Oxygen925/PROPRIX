<script lang="ts">
	// 도구 호출 표시
	// - 확인 대기: 승인 카드 (무엇을 허용하는지 인자를 그대로 보여 주고 한 번 허용 · 항상 허용 · 거부)
	// - 위임: 접는 카드 (맡긴 일·하위 호출·결과. 하위가 확인을 기다리면 펼친다)
	// - 작업자 띄우기: 접는 카드 안에 작업자별 카드 (맡은 일·하위 호출·결과)
	// - 시각화 (show_visual): sandbox iframe 카드
	// - 그 밖: 한 줄 이벤트 (리마인더 예약·기억 저장 등). 눌러서 자세히
	// - 작업 폴더: 파일 변경은 정확한 diff 로 확인받고, 끝난 변경은 되돌릴 수 있다. 명령 실행은 늘 확인하고 한계를 보인다
	import { app } from '#lib/app.svelte.js';
	import ToolCallCard from '#lib/components/ToolCallCard.svelte';
	import Button from '#lib/ui/Button.svelte';
	import DiffView from '#lib/chat/DiffView.svelte';
	import { ApiFailure } from '#lib/api.js';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import { errorText, toast, toastError } from '#lib/ui/toast.svelte.js';
	import VisualCard from '#lib/chat/VisualCard.svelte';
	import { DELEGATE_TOOL, SHELL_LIMITS, type ToolCall, VISUAL_TOOL, WORKER_CALL, WORKERS_TOOL } from '@proprix/shared';
	import IconUsersGroup from '@tabler/icons-svelte-runes/icons/users-group';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconArrowBackUp from '@tabler/icons-svelte-runes/icons/arrow-back-up';
	import IconFile from '@tabler/icons-svelte-runes/icons/file';
	import IconTerminal from '@tabler/icons-svelte-runes/icons/terminal-2';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconArrowForwardUp from '@tabler/icons-svelte-runes/icons/arrow-forward-up';
	import IconBell from '@tabler/icons-svelte-runes/icons/bell';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconClock from '@tabler/icons-svelte-runes/icons/clock';
	import IconNotes from '@tabler/icons-svelte-runes/icons/notes';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconTool from '@tabler/icons-svelte-runes/icons/tool';

	let { call }: { call: ToolCall } = $props();
	let busy = $state(false);
	let error = $state('');

	const parsed = (raw: string): Record<string, unknown> => {
		try {
			const v: unknown = JSON.parse(raw);
			return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};
	const str = (o: Record<string, unknown>, key: string) => (typeof o[key] === 'string' ? (o[key] as string) : '');

	const args = $derived(parsed(call.args));
	const info = $derived(app.tools.find((t) => t.name === call.name));
	const isFile = $derived(call.name.startsWith('fs_'));
	const isShell = $derived(call.name === 'shell_run' || call.name === 'skill_run_script');
	// 파일 변경은 diff 로 (인자에는 몇 MB 내용이 들어 있을 수 있다)
	const isDiff = $derived(isFile && !!call.preview && call.name !== 'fs_delete');
	const change = $derived(app.fileChanges.find((c) => c.callId === call.id));

	// ---- 되돌리기 (그 뒤 또 바뀌었으면 덮어쓸지 묻는다) ----
	let conflict = $state(false);
	async function restore(force = false) {
		if (!change) return;
		busy = true;
		try {
			await app.restoreChange(change.id, force);
			conflict = false;
			toast(`${change.path} 을(를) 되돌렸습니다`, 'success');
		} catch (e) {
			if (e instanceof ApiFailure && e.status === 409 && e.message.includes('또 바뀌었음')) conflict = true;
			else toastError(e);
		} finally {
			busy = false;
		}
	}
	const prettyArgs = $derived(Object.keys(args).length ? JSON.stringify(args, null, 2) : call.args);
	const agentName = $derived(app.look(call.agentId).name);

	const statusLabel: Record<ToolCall['status'], string> = {
		pending: '확인 필요',
		running: '실행 중',
		done: '',
		failed: '실패',
		denied: '실행 안 함'
	};
	const reasonLabel: Record<string, string> = {
		deny: '거부함',
		timeout: '응답 시간 초과',
		cancelled: '중지됨',
		daemon_restarted: 'daemon 재시작',
		not_allowed: '허용되지 않은 도구',
		unattended: '예약 작업이라 거절',
		error: '오류'
	};
	const status = $derived(
		[statusLabel[call.status], call.reason ? (reasonLabel[call.reason] ?? call.reason) : ''].filter(Boolean).join(' · ')
	);

	const icon = $derived(
		isShell
			? IconTerminal
			: isFile
				? IconFile
				: call.name.startsWith('memory_')
			? IconBrain
			: call.name.startsWith('reminder_')
				? IconBell
				: call.name.startsWith('note_')
					? IconNotes
					: call.name === 'current_time'
						? IconClock
						: call.kind === 'read'
							? IconSearch
							: IconTool
	);
	// 한 줄 요약: 인자 중 사람이 읽을 만한 값
	const summary = $derived(
		['script', 'path', 'command', 'text', 'title', 'query', 'task', 'content', 'name']
			.map((k) => str(args, k))
			.find(Boolean)
			?.slice(0, 80) ?? ''
	);

	const delegation = $derived(
		call.name === DELEGATE_TOOL
			? {
					agent: str(args, 'agent'),
					task: str(args, 'task'),
					result: str(parsed(call.output), 'result') || str(parsed(call.output), 'error')
				}
			: null
	);
	const children = $derived(app.toolCalls.filter((c) => c.parentId === call.id));
	// 작업자 띄우기 · 작업자 하나
	const workersDone = $derived(children.filter((c) => c.status === 'done' || c.status === 'failed').length);
	const worker = $derived(
		call.name === WORKER_CALL
			? {
					title: str(args, 'title'),
					task: str(args, 'task'),
					tools: Array.isArray(args.tools) ? (args.tools as string[]) : [],
					result: str(parsed(call.output), 'result')
				}
			: null
	);
	let open = $state(false);
	// 하위 어디든(작업자 안의 호출 등) 확인을 기다리면 펼친다
	const pendingBelow = (id: string): boolean =>
		app.toolCalls.some((c) => c.parentId === id && (c.status === 'pending' || pendingBelow(c.id)));
	$effect(() => {
		if (pendingBelow(call.id)) open = true;
	});

	async function decide(approve: boolean, always = false) {
		busy = true;
		error = '';
		try {
			await app.decide(call.id, approve, always);
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

{#if call.status === 'pending'}
	<div class="approval" role="group" aria-label="확인 필요: {app.toolTitle(call.name)}">
		<div class="head">
			<IconAlertTriangle size="1rem" stroke={1.75} aria-hidden="true" />
			<strong>{app.toolTitle(call.name)}</strong>
			<span class="who">{agentName}의 요청 · 확인 필요</span>
			<code>{call.name}</code>
		</div>
		{#if isDiff}
			<p class="target">{str(args, 'path')}</p>
			<DiffView text={call.preview} />
		{:else if call.preview}
			<pre class="args">{call.preview}</pre>
		{:else}
			<pre class="args">{prettyArgs}</pre>
		{/if}
		{#if isShell}<p class="limits" role="note">{SHELL_LIMITS}</p>{/if}
		<div class="actions">
			<Button size="sm" variant="primary" disabled={busy} onclick={() => decide(true)}>
				{info?.alwaysConfirm ? '실행 허용' : '한 번 허용'}
			</Button>
			{#if !info?.alwaysConfirm}
				<Button
					size="sm"
					disabled={busy}
					onclick={() => decide(true, true)}
					title="{agentName}의 {app.toolTitle(call.name)}은(는) 앞으로 묻지 않음 (웹 검색·토론·명령 출력이 섞인 턴은 계속 확인, 파일 내용을 읽은 턴은 폴더 밖 쓰기만 확인)"
				>
					{agentName}에게 항상 허용
				</Button>
			{/if}
			<Button size="sm" variant="ghost" disabled={busy} onclick={() => decide(false)}>거부</Button>
		</div>
		{#if error}<p class="error">{error}</p>{/if}
	</div>
{:else if call.name === VISUAL_TOOL}
	<VisualCard {call} />
{:else if delegation}
	<details class="delegation {call.status}" bind:open>
		<summary>
			<IconArrowForwardUp size="0.95rem" stroke={1.75} aria-hidden="true" />
			<span class="label">{delegation.agent || '?'}에게 맡김</span>
			{#if delegation.task}<span class="sum">{delegation.task.slice(0, 80)}</span>{/if}
			{#if status}<span class="state">{status}</span>{/if}
		</summary>
		<p class="sub">맡긴 일</p>
		<pre class="args">{delegation.task}</pre>
		{#each children as child (child.id)}
			<ToolCallCard call={child} />
		{/each}
		{#if delegation.result}
			<p class="sub">{call.status === 'done' ? '결과' : '오류'}</p>
			<pre class="args">{delegation.result}</pre>
		{/if}
	</details>
{:else if call.name === WORKERS_TOOL}
	<details class="delegation {call.status}" bind:open>
		<summary>
			<IconUsersGroup size="0.95rem" stroke={1.75} aria-hidden="true" />
			<span class="label">작업자 {children.length}명</span>
			<span class="sum">{call.status === 'running' ? `${workersDone}/${children.length} 끝남` : children.map((c) => str(parsed(c.args), 'title')).join(' · ')}</span>
			{#if status}<span class="state">{status}</span>{/if}
		</summary>
		{#each children as child (child.id)}
			<ToolCallCard call={child} />
		{/each}
	</details>
{:else if worker}
	<details class="delegation {call.status}" bind:open>
		<summary>
			<IconUser size="0.95rem" stroke={1.75} aria-hidden="true" />
			<span class="label">{worker.title || '작업자'}</span>
			<span class="sum">{worker.task.slice(0, 80)}</span>
			{#if status}<span class="state">{status}</span>{/if}
		</summary>
		<p class="sub">맡은 일{worker.tools.length ? ` · 도구 ${worker.tools.map((t) => (t === 'web_search' ? '웹 검색' : app.toolTitle(t))).join(', ')}` : ' · 도구 없음'}</p>
		<pre class="args">{worker.task}</pre>
		{#each children as child (child.id)}
			<ToolCallCard call={child} />
		{/each}
		{#if worker.result}
			<p class="sub">결과</p>
			<pre class="args">{worker.result}</pre>
		{/if}
	</details>
{:else}
	{@const Icon = icon}
	<details class="event {call.status}">
		<summary>
			<Icon size="0.95rem" stroke={1.75} aria-hidden="true" />
			<span class="label">{app.toolTitle(call.name)}</span>
			{#if summary}<span class="sum">{summary}</span>{/if}
			{#if status}<span class="state">{status}</span>{/if}
		</summary>
		{#if isDiff}
			<DiffView text={call.preview} lines={20} />
		{:else if call.preview}
			<pre class="args">{call.preview}</pre>
		{:else}
			<p class="sub">인자</p>
			<pre class="args">{prettyArgs}</pre>
		{/if}
		{#if change}
			<div class="undo">
				{#if change.restoredAt}
					<span class="done">되돌림</span>
				{:else}
					<Button size="sm" variant="ghost" icon={IconArrowBackUp} disabled={busy} onclick={() => restore()}>되돌리기</Button>
				{/if}
			</div>
		{/if}
		{#if call.output}
			<p class="sub">결과</p>
			<pre class="args">{call.output}</pre>
		{/if}
	</details>
{/if}

<ConfirmDialog open={conflict} title="되돌리기" confirmLabel="덮어쓰고 되돌리기" disabled={busy} onconfirm={() => restore(true)} onclose={() => (conflict = false)}>
	<p>'{change?.path}' 은(는) 이 변경 뒤에 또 바뀌었습니다. 되돌리면 지금 내용을 덮어씁니다. 지금 내용은 복구 보관함에 남아 다시 되돌릴 수 있습니다.</p>
</ConfirmDialog>

<style>
	.target {
		margin-top: var(--s-2);
		font-family: var(--font-mono);
		font-size: var(--t-xs);
		color: var(--c-text-2);
	}
	.limits {
		margin-top: var(--s-2);
		color: var(--c-waiting);
		font-size: var(--t-xs);
	}
	.undo {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-1);
	}
	.undo .done {
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.approval,
	details.event,
	details.delegation {
		animation: appear var(--dur) var(--ease) both;
	}
	.approval {
		margin: var(--s-1) 0 var(--s-2);
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-waiting-line);
		border-radius: var(--r-3);
		background: var(--c-waiting-bg);
		font-size: var(--t-sm);
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
		color: var(--c-waiting);
	}
	.head .who {
		color: var(--c-text-3);
	}
	.head strong {
		color: var(--c-text);
		font-weight: var(--w-bold);
	}
	code {
		color: var(--c-text-4);
		font-size: var(--t-xs);
	}
	.args {
		margin: var(--s-2) 0 0;
		padding: var(--s-2);
		border-radius: var(--r-2);
		background: var(--c-bg);
		border: 1px solid var(--c-line);
		font-size: var(--t-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 12rem;
		overflow-y: auto;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		margin-top: var(--s-2);
	}
	.error {
		margin-top: var(--s-1);
		color: var(--c-danger);
	}
	/* 한 줄 이벤트·위임 */
	details {
		margin: 0.125rem 0;
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	details.delegation {
		margin: var(--s-1) 0 var(--s-2);
		padding: var(--s-1) var(--s-2);
		border: 1px solid var(--c-line);
		border-radius: var(--r-2);
	}
	summary {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		cursor: pointer;
		list-style: none;
		padding: 0.125rem 0;
		min-width: 0;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover {
		color: var(--c-text-2);
	}
	.label {
		color: var(--c-text-2);
		white-space: nowrap;
	}
	.sum {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.state {
		margin-left: auto;
		padding-left: var(--s-2);
		font-size: var(--t-xs);
		white-space: nowrap;
	}
	.running .state {
		color: var(--c-working);
	}
	.failed .state,
	.denied .state {
		color: var(--c-danger);
	}
	.sub {
		margin-top: var(--s-2);
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
</style>
