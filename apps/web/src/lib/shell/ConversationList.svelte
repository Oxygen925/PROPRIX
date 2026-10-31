<script lang="ts">
	// 대화 목록 패널 (사용자 결정 2026-10-30): 에이전트별 묶음(머리글에 상태, 최근 3개 + 더 보기) · 그룹 · 라운지 · 보관함
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import { openAgent } from '#lib/chat/room-actions.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';
	import IconCoffee from '@tabler/icons-svelte-runes/icons/coffee';
	import IconMessagePlus from '@tabler/icons-svelte-runes/icons/message-plus';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconRobot from '@tabler/icons-svelte-runes/icons/robot';
	import IconGitBranch from '@tabler/icons-svelte-runes/icons/git-branch';
	import { slide } from 'svelte/transition';
	import IconUsersGroup from '@tabler/icons-svelte-runes/icons/users-group';
	import type { Agent } from '@proprix/shared';
	import { onMount, tick } from 'svelte';
	import { jobTitle, statusLine } from './agent-line.js';
	import NewGroupDialog from './NewGroupDialog.svelte';

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	// 펼친 에이전트와 '더 보기'를 누른 에이전트 (이번 실행 동안 기억). 기본은 에이전트만 보인다 (사용자 결정 2026-10-31)
	const ROOMS_SHOWN = 3;
	let expanded = $state<string[]>([]);
	let showAll = $state<string[]>([]);
	let groupOpen = $state(false);
	let subOpen = $state<string[]>([]); // 서브 채팅 목록을 펼친 부모 방
	let archiveOpen = $state(false);

	const currentRoom = $derived(page.route.id === '/rooms/[id]' ? (page.params.id ?? '') : '');

	function toggle(id: string) {
		expanded = expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id];
	}

	// 에이전트를 누르면 가장 최근 방으로, 방이 없으면 새로 만든다
	async function newChat(a: Agent) {
		const room = await app.newRoom([a.id]);
		if (!expanded.includes(a.id)) expanded = [...expanded, a.id];
		await goto(`/rooms/${room.id}`);
	}

	// 에이전트 순서 바꾸기: 행을 끌어 다른 에이전트 위·아래에 놓는다 (키보드는 Alt+↑/↓)
	let dragId = $state('');
	let dropAt = $state(-1); // orderedAgents 에서 끼워 넣을 자리 (0..n)

	function onDragStart(e: DragEvent, id: string) {
		dragId = id;
		e.dataTransfer?.setData('text/plain', id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function onDragOver(e: DragEvent, i: number) {
		if (!dragId) return; // 방 링크 같은 다른 것을 끄는 중
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		dropAt = e.clientY < r.top + r.height / 2 ? i : i + 1;
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		if (dragId && dropAt >= 0) {
			const from = app.orderedAgents.findIndex((a) => a.id === dragId);
			app.moveAgent(dragId, dropAt > from ? dropAt - 1 : dropAt);
		}
		endDrag();
	}

	function endDrag() {
		dragId = '';
		dropAt = -1;
	}

	function onAgentKey(e: KeyboardEvent, i: number, id: string) {
		if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
		e.preventDefault();
		app.moveAgent(id, e.key === 'ArrowUp' ? i - 1 : i + 1);
		// 자리를 옮기면 포커스가 풀릴 수 있어 다시 잡는다
		void tick().then(() => document.querySelector<HTMLElement>(`[data-agent="${id}"] .agent-main`)?.focus());
	}

	const plusItems: MenuItem[] = $derived([
		{
			label: '새 채팅',
			icon: IconMessagePlus,
			hint: 'Ctrl+N',
			onSelect: () => {
				const a = app.agentsByActivity[0];
				if (a) void newChat(a);
			}
		},
		{ label: '새 그룹챗', icon: IconUsersGroup, onSelect: () => (groupOpen = true) },
		{ label: '새 에이전트', icon: IconRobot, onSelect: () => void goto('/agents?new=agent') }
	]);

	const unreadIn = (ids: string[]) => ids.some((id) => app.unread.includes(id));
</script>

<aside class="sidebar" data-ui="list" aria-label="채팅 목록">
	<header>
		<span class="brand">채팅</span>
		{#if app.account?.mock}<span class="mock">mock</span>{/if}
		<span class="grow"></span>
		<Menu items={plusItems}>
			{#snippet trigger({ toggle: t, props })}
				<IconButton icon={IconPlus} label="새로 만들기" size="sm" onclick={t} {...props} />
			{/snippet}
		</Menu>
	</header>

	<nav class="scroll">
		<div class="section">에이전트</div>
		{#each app.orderedAgents as a, i (a.id)}
			{@const rooms = app.soloRooms(a.id)}
			{@const line = statusLine(app.statuses[a.id], now)}
			{@const open = expanded.includes(a.id)}
			{@const shown = showAll.includes(a.id) ? rooms : rooms.filter((r, n) => n < ROOMS_SHOWN || r.id === currentRoom)}
			{@const active = rooms.some((r) => r.id === currentRoom)}
			<div
				class="agent-block"
				role="group"
				aria-label={a.name}
				data-agent={a.id}
				class:dragging={dragId === a.id}
				class:drop-before={dropAt === i}
				class:drop-after={dropAt === i + 1 && i === app.orderedAgents.length - 1}
				ondragover={(e) => onDragOver(e, i)}
				ondrop={onDrop}
			>
				<!-- 끌기는 마우스용. 키보드는 이름 버튼에서 Alt+↑/↓ 로 같은 일을 한다 -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="agent"
					class:active={active && !open}
					draggable="true"
					ondragstart={(e) => onDragStart(e, a.id)}
					ondragend={endDrag}
				>
					<button
						class="agent-main"
						title="끌어서 순서 바꾸기 (Alt+↑/↓)"
						aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
						onclick={() => openAgent(a.id)}
						onkeydown={(e) => onAgentKey(e, i, a.id)}
					>
						<Avatar agentId={a.id} size={2.4} status={line.state} motion="gaze" />
						<span class="agent-text">
							<span class="name-row">
								<span class="name">{a.name}</span>
								{#if jobTitle(a, app.persona(a.personaId))}<span class="job">· {jobTitle(a, app.persona(a.personaId))}</span>{/if}
								{#if unreadIn(rooms.map((r) => r.id))}<span class="unread" aria-label="새 메시지"></span>{/if}
							</span>
							<span class="line {line.state}">{line.text}</span>
						</span>
					</button>
					<button
						class="chev"
						aria-label="{a.name} 채팅 목록 {open ? '접기' : '펼치기'}"
						aria-expanded={open}
						onclick={() => toggle(a.id)}
					>
						{#if open}<IconChevronDown size="0.875rem" />{:else}<IconChevronRight size="0.875rem" />{/if}
					</button>
				</div>
				{#if open}
					<div class="rooms" transition:slide={{ duration: 160 }}>
						{#each shown as r (r.id)}
							<a class="room" class:active={r.id === currentRoom} href="/rooms/{r.id}">
								{#if r.pinned}<IconPin size="0.75rem" aria-label="고정됨" />{/if}
								<span class="title">{r.title}</span>
								{#if app.unread.includes(r.id)}<span class="unread" aria-label="새 메시지"></span>{/if}
							</a>
							{@render subchats(r.id)}
						{/each}
						{#if shown.length < rooms.length}
							<button class="room new" onclick={() => (showAll = [...showAll, a.id])}>더 보기 {rooms.length - shown.length}</button>
						{/if}
						<button class="room new" onclick={() => newChat(a)}>
							<IconPlus size="0.8125rem" aria-hidden="true" /> 새 채팅
						</button>
					</div>
				{/if}
			</div>
		{/each}

		<div class="section">그룹</div>
		{#each app.groupRooms as r (r.id)}
			<a class="item" class:active={r.id === currentRoom} href="/rooms/{r.id}">
				<span class="stack" aria-hidden="true">
					{#each r.agentIds.slice(0, 3) as id (id)}<Avatar agentId={id} size={1.5} motion="gaze" />{/each}
				</span>
				{#if r.pinned}<IconPin size="0.75rem" aria-label="고정됨" />{/if}
				<span class="title">{r.title}</span>
				{#if r.running}<span class="busy" aria-label="응답 중"></span>{/if}
				{#if app.unread.includes(r.id)}<span class="unread" aria-label="새 메시지"></span>{/if}
			</a>
			{@render subchats(r.id)}
		{:else}
			<button class="item muted" onclick={() => (groupOpen = true)}>
				<IconUsersGroup size="1rem" stroke={1.75} aria-hidden="true" /> 그룹챗 만들기
			</button>
		{/each}
		{#if app.loungeRoom}
			{@const l = app.loungeRoom}
			<a class="item" class:active={l.id === currentRoom} href="/rooms/{l.id}">
				<IconCoffee size="1rem" stroke={1.75} aria-hidden="true" />
				<span class="title">라운지</span>
				{#if l.running}<span class="busy" aria-label="채팅 중"></span>{/if}
				{#if app.unread.includes(l.id)}<span class="unread" aria-label="새 메시지"></span>{/if}
			</a>
		{/if}
		{#if app.archivedRooms.length}
			<button class="section toggle" aria-expanded={archiveOpen} onclick={() => (archiveOpen = !archiveOpen)}>
				{#if archiveOpen}<IconChevronDown size="0.75rem" aria-hidden="true" />{:else}<IconChevronRight size="0.75rem" aria-hidden="true" />{/if}
				보관함 {app.archivedRooms.length}
			</button>
			{#if archiveOpen}
				<div class="list" transition:slide={{ duration: 160 }}>
					{#each app.archivedRooms as r (r.id)}
						<a class="item archived" class:active={r.id === currentRoom} href="/rooms/{r.id}">
							<span class="stack" aria-hidden="true">
								{#each r.agentIds.slice(0, 3) as id (id)}<Avatar agentId={id} size={1.5} motion="gaze" />{/each}
							</span>
							<span class="title">{r.title}</span>
						</a>
					{/each}
				</div>
			{/if}
		{/if}
	</nav>

</aside>

{#snippet subchats(parentId: string)}
	{@const subs = app.subchatsOf(parentId)}
	{#if subs.length}
		{@const open = subOpen.includes(parentId) || subs.some((s) => s.id === currentRoom)}
		<button
			class="room sub-toggle"
			aria-expanded={open}
			onclick={() => (subOpen = open ? subOpen.filter((x) => x !== parentId) : [...subOpen, parentId])}
		>
			{#if open}<IconChevronDown size="0.7rem" aria-hidden="true" />{:else}<IconChevronRight size="0.7rem" aria-hidden="true" />{/if}
			서브 채팅 {subs.length}
		</button>
		{#if open}
			<div class="list" transition:slide={{ duration: 160 }}>
				{#each subs as s (s.id)}
					<a class="room sub" class:active={s.id === currentRoom} href="/rooms/{s.id}">
						<IconGitBranch size="0.7rem" aria-hidden="true" />
						<span class="title">{s.title}</span>
						{#if s.running}<span class="busy" aria-label="응답 중"></span>{/if}
						{#if app.unread.includes(s.id)}<span class="unread" aria-label="새 메시지"></span>{/if}
					</a>
				{/each}
			</div>
		{/if}
	{/if}
{/snippet}

<NewGroupDialog open={groupOpen} onclose={() => (groupOpen = false)} />

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--c-surface-1);
		border-right: 1px solid var(--c-line);
	}
	header {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.75rem 0.625rem 0.5rem 0.875rem;
	}
	.brand {
		font-weight: var(--w-bold);
	}
	.mock {
		font-size: var(--t-xs);
		color: var(--c-waiting);
		border: 1px solid var(--c-waiting-line);
		border-radius: var(--r-1);
		padding: 0 0.3125rem;
		margin-left: 0.375rem;
	}
	.grow {
		flex: 1;
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem 0.5rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	/* 끌어 놓을 자리는 위·아래 선으로 */
	.agent-block {
		border-radius: var(--r-2);
	}
	.agent-block.dragging {
		opacity: 0.45;
	}
	.agent-block.drop-before {
		box-shadow: inset 0 2px 0 var(--c-accent-hover);
	}
	.agent-block.drop-after {
		box-shadow: inset 0 -2px 0 var(--c-accent-hover);
	}
	.section.toggle {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		border: none;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.section.toggle:hover {
		color: var(--c-text-2);
	}
	.item.archived {
		opacity: 0.7;
	}
	.section {
		color: var(--c-text-4);
		font-size: var(--t-xs);
		padding: 0.875rem 0.5rem 0.25rem;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 0.5625rem;
		padding: 0.4375rem 0.5rem;
		border-radius: var(--r-2);
		color: var(--c-text-2);
		background: none;
		border: none;
		text-align: left;
		text-decoration: none;
		font-size: var(--t-md);
	}
	.item:hover {
		background: var(--c-hover);
		color: var(--c-text);
		text-decoration: none;
	}
	.item.active,
	.agent.active,
	.room.active {
		background: var(--c-selected);
		color: var(--c-text);
	}
	.item.muted {
		color: var(--c-text-3);
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.agent {
		display: flex;
		align-items: center;
		border-radius: var(--r-2);
	}
	.agent:hover {
		background: var(--c-hover);
	}
	.agent-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.4375rem 0.25rem 0.4375rem 0.5rem;
		background: none;
		border: none;
		text-align: left;
	}
	.agent-main:hover {
		background: none;
	}
	.agent-text {
		min-width: 0;
		display: grid;
		gap: 1px;
	}
	.name-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
	.name {
		color: var(--c-text);
		font-weight: var(--w-bold);
		white-space: nowrap;
	}
	.job {
		color: var(--c-text-4);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.line {
		font-size: var(--t-xs);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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
	.line.done {
		color: var(--c-done);
	}
	.chev {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		margin-right: 0.25rem;
		background: none;
		border: none;
		border-radius: var(--r-1);
		color: var(--c-text-4);
		padding: 0;
		opacity: 0;
	}
	.agent:hover .chev,
	.chev:focus-visible,
	.chev[aria-expanded='true'] {
		opacity: 1;
	}
	.chev:hover {
		color: var(--c-text);
		background: var(--c-surface-3);
	}
	.rooms {
		display: grid;
		gap: 1px;
		padding: 2px 0 0.375rem 1.75rem;
	}
	.room {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.5rem;
		border-radius: var(--r-1);
		color: var(--c-text-3);
		font-size: var(--t-sm);
		background: none;
		border: none;
		text-align: left;
		text-decoration: none;
	}
	.room:hover {
		background: var(--c-hover);
		color: var(--c-text);
		text-decoration: none;
	}
	.room.new {
		color: var(--c-text-4);
	}
	.stack {
		display: flex;
	}
	.stack :global(.wrap + .wrap) {
		margin-left: -0.4375rem;
	}
	.unread {
		flex-shrink: 0;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--c-text);
		margin-left: auto;
	}
	.busy {
		flex-shrink: 0;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--c-working);
		animation: blink 1.2s ease-in-out infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.sub-toggle,
	.sub {
		padding-left: 1.75rem !important;
		font-size: var(--t-xs);
	}
	.sub-toggle {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		border: none;
		background: none;
		color: var(--c-text-4);
	}
	.sub {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--c-text-3);
	}
</style>
