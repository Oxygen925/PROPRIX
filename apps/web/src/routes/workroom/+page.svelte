<script lang="ts">
	// 작업실 (사용자 결정 2026-10-31): 모든 에이전트가 지금 하는 일에 따라 칸을 오간다. 누르면 그 일이 있는 곳으로 간다
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import { slotPosition, ZONES, type ZoneId, zoneDensity, zoneOf } from '#lib/character/zones.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { statusLine } from '#lib/shell/agent-line.js';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import type { Agent } from '@proprix/shared';
	import IconArmchair from '@tabler/icons-svelte-runes/icons/armchair';
	import IconDesk from '@tabler/icons-svelte-runes/icons/desk';
	import IconMessages from '@tabler/icons-svelte-runes/icons/messages';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconTools from '@tabler/icons-svelte-runes/icons/tools';
	import IconWorldSearch from '@tabler/icons-svelte-runes/icons/world-search';
	import { onMount } from 'svelte';

	const AVATAR = { normal: 3, compact: 2.25, tiny: 1.75 };
	const ICONS = { search: IconSearch, tools: IconTools, write: IconPencil, debate: IconMessages, research: IconWorldSearch, rest: IconArmchair };

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 5000);
		return () => clearInterval(t);
	});

	// 에이전트 → 돌고 있는 리서치
	const researching = $derived.by(() => {
		const map = new Map<string, string>();
		for (const r of app.researches) {
			if (!app.researchRunning(r.id)) continue;
			const live = app.researchLive[r.id]?.filter((x) => x.status === 'running').map((x) => x.agentId);
			for (const id of live?.length ? live : r.agentIds) map.set(id, r.id);
		}
		return map;
	});

	const placed = $derived.by(() => {
		const list = app.orderedAgents.map((a) => {
			const s = app.statuses[a.id];
			const line = statusLine(s, now);
			const room = s?.roomId ? app.rooms.find((r) => r.id === s.roomId) : undefined;
			const zone = zoneOf({
				state: line.state,
				text: line.text,
				debate: !!s?.debate && !!room?.running, // 끝난 토론의 마지막 상태는 빼고
				lounge: room?.kind === 'lounge',
				researching: researching.has(a.id)
			});
			return { a, line, zone, room };
		});
		const inZone = (z: ZoneId) => list.filter((x) => x.zone === z);
		return list.map((x) => {
			const mates = inZone(x.zone);
			return { ...x, pos: slotPosition(x.zone, mates.indexOf(x), mates.length), density: zoneDensity(mates.length) };
		});
	});

	// 그 일이 있는 곳으로: 일하는 채팅 → 리서치 → 최근 1인 채팅
	function open(a: Agent, roomId: string | undefined, active: boolean) {
		const research = researching.get(a.id);
		const target = active && roomId ? `/rooms/${roomId}` : research ? `/research/${research}` : app.soloRooms(a.id)[0] ? `/rooms/${app.soloRooms(a.id)[0]?.id}` : '';
		if (target) void goto(target);
	}
</script>

<div class="page">
	<header>
		<h1>{app.label('workroom', '작업실')}</h1>
		<p class="hint">에이전트가 지금 하는 일에 따라 자리를 옮깁니다. 누르면 그 일이 있는 곳으로 갑니다.</p>
	</header>
	{#if app.agents.length === 0}
		<EmptyState icon={IconDesk} title="에이전트가 없어요" body="에이전트 화면에서 새 에이전트를 만들어 보세요." />
	{:else}
		<div class="stage" data-ui="workroom" class:still={!app.characterMotion}>
			{#each ZONES as z (z.id)}
				{@const I = ICONS[z.id]}
				<section class="zone {z.id}" data-zone={z.id} aria-label={app.label(`zone.${z.id}`, z.label)}>
					<h2><I size="1rem" stroke={1.75} aria-hidden="true" /> {app.label(`zone.${z.id}`, z.label)}</h2>
				</section>
			{/each}
			{#each placed as { a, line, zone, room, pos, density } (a.id)}
				<button
					class="char {density}"
					style:left="{pos.left}%"
					style:top="{pos.top}%"
					title="{a.name} · {line.text}"
					aria-label="{a.name}, {app.label(`zone.${zone}`, ZONES.find((z) => z.id === zone)?.label ?? '')}, {line.text}"
					onclick={() => open(a, room?.id, line.state === 'thinking' || line.state === 'working' || line.state === 'waiting')}
				>
					<Avatar agentId={a.id} size={AVATAR[density]} status={line.state} motion="full" />
					{#if density !== 'tiny'}<span class="name">{a.name}</span>{/if}
					{#if density === 'normal'}<span class="line {line.state}">{line.text}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		padding: var(--s-4) var(--s-5);
		min-height: 0;
	}
	h1 {
		margin: 0;
	}
	.hint {
		margin: var(--s-1) 0 0;
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 24rem;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		grid-template-rows: repeat(2, minmax(0, 1fr));
		gap: var(--s-2);
	}
	.zone {
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
	}
	.zone.rest {
		background: var(--c-surface-2);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		margin: 0;
		font-size: var(--t-sm);
		font-weight: var(--w-bold);
		color: var(--c-text-3);
	}
	.char {
		position: absolute;
		display: grid;
		justify-items: center;
		gap: 0.125rem;
		width: 8rem;
		padding: var(--s-1);
		transform: translate(-50%, -50%);
		background: transparent;
		border: none;
		border-radius: var(--r-3);
		color: var(--c-text);
		cursor: pointer;
		transition:
			left 0.9s var(--ease),
			top 0.9s var(--ease),
			background var(--dur-fast) var(--ease);
	}
	.char.compact {
		width: 4.25rem;
	}
	.char.tiny {
		width: auto;
		padding: 0.125rem;
	}
	.still .char {
		transition: none;
	}
	.char:hover {
		background: var(--c-hover);
	}
	.name,
	.line {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.compact .name {
		margin-top: 0;
		font-size: var(--t-xs);
		font-weight: var(--w-regular);
	}
	.name {
		margin-top: var(--s-1);
		font-size: var(--t-sm);
		font-weight: var(--w-bold);
	}
	.line {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.line.thinking,
	.line.working {
		color: var(--c-working);
	}
	.line.waiting {
		color: var(--c-waiting);
	}
	.line.blocked {
		color: var(--c-danger);
	}
	@media (prefers-reduced-motion: reduce) {
		.char {
			transition: none;
		}
	}
</style>
