<script lang="ts">
	// 이 기억을 참고로 넣은 답변 (P10e). 답할 때 요청에 넣은 것 — 실제로 반영했는지는 알 수 없다
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { errorText } from '#lib/ui/toast.svelte.js';
	import type { MemoryUse } from '@proprix/shared';

	let { memoryId }: { memoryId: string } = $props();

	let data = $state<{ total: number; items: MemoryUse[] } | null>(null);
	let failed = $state('');

	$effect(() => {
		const id = memoryId;
		data = null;
		failed = '';
		app
			.memoryUses(id)
			.then((r) => {
				if (id === memoryId) data = r;
			})
			.catch((e) => (failed = errorText(e)));
	});

	const when = (t: number) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
</script>

{#if failed}
	<p class="muted">{failed}</p>
{:else if !data}
	<p class="muted">불러오는 중…</p>
{:else if data.total === 0}
	<p class="muted">이 기억을 참고한 답변이 아직 없습니다.</p>
{:else}
	<ul>
		{#each data.items as u (u.messageId)}
			<li>
				<a href="/rooms/{u.roomId}?m={u.messageId}">
					<Avatar agentId={u.agentId} size={1} />
					<span class="room">{u.roomTitle || '삭제한 채팅'}</span>
					<span class="excerpt">{u.excerpt.replace(/\s+/g, ' ')}</span>
					<time>{when(u.createdAt)}</time>
				</a>
			</li>
		{/each}
	</ul>
	{#if data.total > data.items.length}<p class="muted">최근 {data.items.length}개만 보입니다 (모두 {data.total}개).</p>{/if}
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	a {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: 0.25rem var(--s-2);
		border-radius: var(--r-2);
		color: var(--c-text-2);
		font-size: var(--t-sm);
		text-decoration: none;
		min-width: 0;
	}
	a:hover {
		background: var(--c-surface-3);
		color: var(--c-text);
	}
	.room {
		flex: none;
		max-width: 10rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--c-text);
	}
	.excerpt {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--c-text-3);
	}
	time {
		flex: none;
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.muted {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
</style>
