<script lang="ts">
	// 도구 실행 감사 로그 (P10b): 모든 방의 쓰기 도구 실행을 최신순으로. 파일 변경은 되돌리고,
	// 도구가 만든 메모는 지우고 리마인더는 취소한다. 메모 수정·삭제, MCP, 명령은 기록만 (사용자 결정 2026-10-29)
	import { ApiFailure } from '#lib/api.js';
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { fullTime } from '#lib/chat/time.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { type AuditEntry, cutLine, type FileChange, summarizeArgs, TOOL_GROUPS, type ToolGroup } from '@proprix/shared';
	import IconListCheck from '@tabler/icons-svelte-runes/icons/list-check';
	import { untrack } from 'svelte';

	const GROUP_LABEL: Record<ToolGroup, string> = {
		file: '파일',
		note: '메모',
		reminder: '리마인더',
		mcp: 'MCP',
		command: '명령',
		other: '기타'
	};
	const STATUS: Record<AuditEntry['status'], { label: string; tone: 'neutral' | 'working' | 'waiting' | 'done' | 'danger' }> = {
		done: { label: '완료', tone: 'done' },
		failed: { label: '실패', tone: 'danger' },
		denied: { label: '거절', tone: 'neutral' },
		pending: { label: '확인 대기', tone: 'waiting' },
		running: { label: '실행 중', tone: 'working' }
	};

	let room = $state('');
	let group = $state<ToolGroup | ''>('');
	let status = $state('');
	let items = $state<AuditEntry[]>([]);
	let next = $state<string | null>(null);
	let loading = $state(false);
	let busy = $state(false);

	const rooms = $derived(app.rooms.filter((r) => r.kind === 'chat'));

	// 필터·변경 이벤트가 바뀌면 처음부터 다시 읽는다 (이어 받은 만큼은 버린다)
	$effect(() => {
		const q = { room, group, status };
		void app.auditVersion;
		untrack(() => void reload(q));
	});

	async function reload(q = { room, group, status }) {
		loading = true;
		try {
			const page = await app.loadAudit(q);
			items = page.items;
			next = page.next;
		} catch (e) {
			toastError(e);
		} finally {
			loading = false;
		}
	}

	async function more() {
		if (!next) return;
		loading = true;
		try {
			const page = await app.loadAudit({ room, group, status, before: next });
			items = [...items, ...page.items];
			next = page.next;
		} catch (e) {
			toastError(e);
		} finally {
			loading = false;
		}
	}

	// ---- 되돌리기 ----
	let conflict = $state<FileChange | null>(null); // 그 뒤 또 바뀐 파일: 덮어쓸지 묻는다
	let confirming = $state<AuditEntry | null>(null); // 메모 지우기·리마인더 취소 확인

	async function restore(c: FileChange, force = false) {
		busy = true;
		try {
			await app.restoreChange(c.id, force);
			conflict = null;
			toast(`${c.path} 을(를) 되돌렸습니다`, 'success');
			await reload();
		} catch (e) {
			if (!force && e instanceof ApiFailure && e.status === 409 && /또 바뀌었음/.test(e.message)) conflict = c;
			else toastError(e);
		} finally {
			busy = false;
		}
	}

	async function undo(e: AuditEntry) {
		busy = true;
		try {
			await app.undoToolCall(e.id);
			toast(e.undo?.kind === 'note' ? '메모를 삭제했습니다' : '리마인더를 취소했습니다', 'success');
			confirming = null;
			await reload();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	const result = (e: AuditEntry) => cutLine(e.status === 'done' ? e.output : e.reason || e.output, 140);
	const undoneLabel = (e: AuditEntry) =>
		e.undoneAt ? '되돌림' : e.undo?.kind === 'note' ? '메모가 남아 있지 않음' : '보냈거나 취소됨';
</script>

<div class="filters">
	<select bind:value={room} aria-label="채팅">
		<option value="">모든 채팅</option>
		{#each rooms as r (r.id)}<option value={r.id}>{r.title}</option>{/each}
	</select>
	<select bind:value={group} aria-label="도구 종류">
		<option value="">모든 도구</option>
		{#each TOOL_GROUPS as g (g)}<option value={g}>{GROUP_LABEL[g]}</option>{/each}
	</select>
	<select bind:value={status} aria-label="상태">
		<option value="">모든 상태</option>
		{#each Object.entries(STATUS) as [k, v] (k)}<option value={k}>{v.label}</option>{/each}
	</select>
</div>
<p class="hint">
	모든 채팅의 쓰기 도구 실행입니다. 파일 변경은 원본으로 되돌리고, 에이전트가 만든 메모는 삭제하고 리마인더는 취소할 수 있습니다.
	메모 편집·삭제, MCP, 명령 실행은 기록만 보입니다. 채팅을 삭제하면 그 기록도 삭제됩니다.
</p>

{#if !loading && items.length === 0}
	<EmptyState icon={IconListCheck} title="쓰기 도구를 실행한 기록이 없어요" body="에이전트가 파일·메모·리마인더 등을 바꾸면 여기에 모입니다." />
{/if}

<ul class="log">
	{#each items as e (e.id)}
		<li>
			<div class="top">
				<Avatar agentId={e.agentId} size={1.1} />
				<strong>{app.toolTitle(e.name)}</strong>
				<Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
				<span class="grow"></span>
				<a class="room" href="/rooms/{e.roomId}?m={e.messageId}" title="그 메시지로 이동">{e.roomTitle || '채팅'}</a>
				<time datetime={new Date(e.createdAt).toISOString()} title={fullTime(e.createdAt)}>
					{new Date(e.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
				</time>
			</div>
			<p class="args"><span class="who">{app.look(e.agentId).name}</span> · {e.name}({summarizeArgs(e.args)})</p>
			{#if result(e)}<p class="result">{result(e)}</p>{/if}

			{#if e.changes.length}
				<ul class="changes">
					{#each e.changes as c (c.id)}
						<li>
							<code>{c.path}</code>
							<span class="op">{c.op === 'delete' ? '삭제' : c.op === 'edit' ? '편집' : '씀'}</span>
							<span class="grow"></span>
							{#if c.restoredAt}
								<span class="muted">되돌림</span>
							{:else}
								<Button size="sm" disabled={busy} onclick={() => restore(c)}>되돌리기</Button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if e.undo}
				<div class="undo">
					<span class="target">{e.undo.kind === 'note' ? '메모' : '리마인더'}{e.undo.label ? `: ${e.undo.label}` : ''}</span>
					<span class="grow"></span>
					{#if e.undo.available}
						<Button size="sm" disabled={busy} onclick={() => (confirming = e)}>
							{e.undo.kind === 'note' ? '메모 삭제' : '리마인더 취소'}
						</Button>
					{:else}
						<span class="muted">{undoneLabel(e)}</span>
					{/if}
				</div>
			{/if}
		</li>
	{/each}
</ul>

{#if next}
	<div class="more"><Button disabled={loading} onclick={more}>더 보기</Button></div>
{/if}

<ConfirmDialog open={conflict !== null} title="되돌리기" confirmLabel="덮어쓰고 되돌리기" disabled={busy} onconfirm={() => conflict && restore(conflict, true)} onclose={() => (conflict = null)}>
	<p>'{conflict?.path}' 은(는) 이 변경 뒤에 또 바뀌었습니다. 되돌리면 지금 내용을 덮어씁니다. 지금 내용은 복구 보관함에 남아 다시 되돌릴 수 있습니다.</p>
</ConfirmDialog>

<ConfirmDialog
	open={confirming !== null}
	title={confirming?.undo?.kind === 'note' ? '메모 삭제' : '리마인더 취소'}
	confirmLabel={confirming?.undo?.kind === 'note' ? '삭제' : '취소하기'}
	cancelLabel="닫기"
	disabled={busy}
	onconfirm={() => confirming && undo(confirming)}
	onclose={() => (confirming = null)}
>
	{#if confirming?.undo?.kind === 'note'}
		<p>에이전트가 만든 메모 '{confirming.undo.label}' 을(를) 삭제합니다. 그 뒤에 편집한 내용도 함께 삭제되며 되돌릴 수 없습니다.</p>
	{:else}
		<p>예약된 리마인더 '{confirming?.undo?.label}' 을(를) 취소합니다.</p>
	{/if}
</ConfirmDialog>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-2);
	}
	.log > li {
		display: grid;
		gap: var(--s-1);
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
	}
	.top,
	.changes li,
	.undo {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.grow {
		flex: 1;
	}
	.room {
		font-size: var(--t-sm);
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	time,
	.muted,
	.op {
		font-size: var(--t-xs);
		color: var(--c-text-3);
		white-space: nowrap;
	}
	.args,
	.result {
		font-size: var(--t-sm);
		color: var(--c-text-2);
		overflow-wrap: anywhere;
	}
	.args {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
	.who {
		font-family: var(--font);
		color: var(--c-text-3);
	}
	.result {
		color: var(--c-text-3);
	}
	.changes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
	}
	.changes code {
		font-size: var(--t-xs);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.target {
		font-size: var(--t-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.more {
		display: flex;
		justify-content: center;
	}
</style>
