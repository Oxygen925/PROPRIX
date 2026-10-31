<script lang="ts">
	// Ctrl+K: 에이전트·방·화면 빠른 전환. 위·아래로 고르고 Enter
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import { openAgent } from '#lib/chat/room-actions.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	interface Item {
		key: string;
		label: string;
		sub: string;
		agentId?: string;
		go: () => Promise<unknown>;
	}

	let query = $state('');
	let index = $state(0);

	$effect(() => {
		if (open) {
			query = '';
			index = 0;
		}
	});

	const items = $derived.by((): Item[] => {
		const pages: Item[] = [
			{ key: 'p:/', label: '오늘', sub: '화면', go: () => goto('/') },
			{ key: 'p:/workroom', label: '작업실', sub: '화면', go: () => goto('/workroom') },
			{ key: 'p:/memories', label: '기억', sub: '화면', go: () => goto('/memories') },
			{ key: 'p:/notes', label: '메모', sub: '화면', go: () => goto('/memories?tab=notes') },
			{ key: 'p:/activity', label: '활동 (도구 실행·사용량)', sub: '화면', go: () => goto('/activity') },
			{ key: 'p:/tasks', label: '예약 작업', sub: '화면', go: () => goto('/activity?tab=tasks') },
			{ key: 'p:/agents', label: '에이전트·페르소나', sub: '화면', go: () => goto('/agents') },
			{ key: 'p:/settings', label: '설정', sub: '화면', go: () => goto('/settings') }
		];
		const agents: Item[] = app.agentsByActivity.map((a) => ({
			key: `a:${a.id}`,
			label: a.name,
			sub: '에이전트',
			agentId: a.id,
			go: () => openAgent(a.id)
		}));
		const rooms: Item[] = [...app.rooms]
			.sort((x, y) => y.updatedAt - x.updatedAt)
			.map((r) => ({
				key: `r:${r.id}`,
				label: r.kind === 'lounge' ? '라운지' : r.title,
				sub: r.agentIds.map((id) => app.agent(id)?.name ?? '').join(', '),
				agentId: r.agentIds[0],
				go: () => goto(`/rooms/${r.id}`)
			}));
		const q = query.trim().toLowerCase();
		const all = [...agents, ...rooms, ...pages];
		return (q ? all.filter((i) => `${i.label} ${i.sub}`.toLowerCase().includes(q)) : all).slice(0, 12);
	});

	async function choose(i: Item | undefined) {
		if (!i) return;
		onclose();
		await i.go();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			index = Math.min(index + 1, items.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			index = Math.max(index - 1, 0);
		} else if (e.key === 'Enter' && !e.isComposing) {
			e.preventDefault();
			void choose(items[index]);
		}
	}
</script>

<Dialog {open} title="이동" {onclose} width={480}>
	<input
		class="q"
		bind:value={query}
		oninput={() => (index = 0)}
		onkeydown={onKey}
		placeholder="에이전트, 채팅, 화면 검색"
		aria-label="검색"
		aria-controls="qs-list"
	/>
	<ul id="qs-list" role="listbox" aria-label="결과">
		{#each items as item, i (item.key)}
			<li role="option" aria-selected={i === index}>
				<button class:sel={i === index} onclick={() => choose(item)} onmouseenter={() => (index = i)} tabindex="-1">
					{#if item.agentId}<Avatar agentId={item.agentId} size={1.4} />{:else}<span class="ph"></span>{/if}
					<span class="label">{item.label}</span>
					<span class="sub">{item.sub}</span>
				</button>
			</li>
		{:else}
			<li class="none">찾는 항목이 없습니다</li>
		{/each}
	</ul>
</Dialog>

<style>
	.q {
		width: 100%;
		height: 2.375rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 1px;
		max-height: 21.25rem;
		overflow-y: auto;
	}
	button {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.4375rem 0.5rem;
		border-radius: var(--r-2);
		background: none;
		border: none;
		text-align: left;
		color: var(--c-text-2);
	}
	button.sel {
		background: var(--c-hover);
		color: var(--c-text);
	}
	.ph {
		width: 1.4rem;
	}
	.label {
		flex-shrink: 0;
	}
	.sub {
		margin-left: auto;
		font-size: var(--t-xs);
		color: var(--c-text-4);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.none {
		padding: 0.75rem 0.5rem;
		color: var(--c-text-3);
	}
</style>
