<script lang="ts">
	// 아이콘 레일 (사용자 결정 2026-10-30: studio 테마): 맨 왼쪽의 화면 전환. 이름은 마우스를 올리면 뜨고, 설정에서 늘 보이게 할 수 있다.
	// 대화·리서치는 이미 그 화면이면 목록 패널을 접고 편다
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import IconButton from '#lib/ui/IconButton.svelte';
	import type { Icon } from '@tabler/icons-svelte-runes';
	import IconActivity from '@tabler/icons-svelte-runes/icons/activity';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconDesk from '@tabler/icons-svelte-runes/icons/desk';
	import IconMessageCircle from '@tabler/icons-svelte-runes/icons/message-circle';
	import IconPuzzle from '@tabler/icons-svelte-runes/icons/puzzle';
	import IconRobot from '@tabler/icons-svelte-runes/icons/robot';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconSun from '@tabler/icons-svelte-runes/icons/sun';
	import IconWorldSearch from '@tabler/icons-svelte-runes/icons/world-search';

	let { onsearch, ontogglelist }: { onsearch: () => void; ontogglelist: () => void } = $props();

	const route = $derived(page.route.id ?? '');
	const inRooms = $derived(route.startsWith('/rooms'));
	const inResearch = $derived(route.startsWith('/research'));
	const unread = $derived(app.unread.length > 0);
	const researching = $derived(app.researches.some((r) => app.researchRunning(r.id)));

	// 대화: 지금 방 → 가장 최근 방 → 오늘 화면
	function openChats() {
		if (inRooms) return ontogglelist();
		const last = app.roomId || app.rooms.find((r) => r.kind === 'chat' && !r.archived)?.id;
		void goto(last ? `/rooms/${last}` : '/');
	}

	function openResearch() {
		if (inResearch) return ontogglelist();
		const first = app.researches[0];
		void goto(first ? `/research/${first.id}` : '/research');
	}
</script>

{#snippet item(icon: Icon, short: string, label: string, active: boolean, onclick: () => void)}
	{#if app.railLabels}
		{@const I = icon}
		<button class="labeled" class:active type="button" aria-label={label} title={label} {onclick}>
			<I size="1.125rem" stroke={1.75} aria-hidden="true" />
			<span>{short}</span>
		</button>
	{:else}
		<IconButton {icon} {label} {active} {onclick} />
	{/if}
{/snippet}

<nav class="rail" data-ui="rail" aria-label="화면">
	{@render item(IconSun, '오늘', '오늘', route === '/', () => goto('/'))}
	<span class="dotted">
		{@render item(IconMessageCircle, '채팅', '채팅', inRooms, openChats)}
		{#if unread}<i class="dot" aria-label="새 메시지"></i>{/if}
	</span>
	<span class="dotted">
		{@render item(IconWorldSearch, '리서치', '리서치', inResearch, openResearch)}
		{#if researching}<i class="dot busy" aria-label="실행 중"></i>{/if}
	</span>
	{@render item(IconDesk, app.label('workroom', '작업실'), `${app.label('workroom', '작업실')} (에이전트가 지금 하는 일)`, route.startsWith('/workroom'), () => goto('/workroom'))}
	{@render item(IconBrain, '기억', '기억·메모', route.startsWith('/memories'), () => goto('/memories'))}
	{@render item(IconActivity, '활동', '활동 (도구 실행·사용량·예약 작업)', route.startsWith('/activity'), () => goto('/activity'))}
	{@render item(IconPuzzle, '확장', '확장 (/ 명령어·Skill·MCP)', route.startsWith('/extensions'), () => goto('/extensions'))}
	{@render item(IconRobot, '에이전트', '에이전트·페르소나·팀', route.startsWith('/agents'), () => goto('/agents'))}
	<span class="grow"></span>
	{@render item(IconSearch, '검색', '검색 (Ctrl+K)', false, onsearch)}
	{@render item(IconSettings, '설정', '설정·계정', route.startsWith('/settings'), () => goto('/settings'))}
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.125rem;
		padding: var(--s-2) 0;
		background: var(--c-surface-1);
		border-right: 1px solid var(--c-line);
		min-height: 0;
	}
	.grow {
		flex: 1;
	}
	.labeled {
		display: grid;
		justify-items: center;
		gap: 0.0625rem;
		width: 3.75rem;
		padding: var(--s-1) 0;
		background: transparent;
		border: none;
		border-radius: var(--r-2);
		color: var(--c-text-3);
		cursor: pointer;
		font-size: var(--t-xs);
		line-height: 1.2;
		transition:
			background var(--dur-fast) var(--ease),
			color var(--dur-fast) var(--ease);
	}
	.labeled:hover,
	.labeled.active {
		background: var(--c-hover);
		color: var(--c-text);
	}
	.dotted {
		position: relative;
		display: inline-flex;
	}
	.dot {
		position: absolute;
		right: 0.25rem;
		top: 0.25rem;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--c-accent-hover);
		pointer-events: none;
	}
	.dot.busy {
		background: var(--c-working);
		animation: blink 1.2s ease-in-out infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot.busy {
			animation: none;
		}
	}
</style>
