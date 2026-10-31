<script lang="ts">
	// 에이전트·페르소나·팀 관리 (사용자 결정 2026-10-30): 왼쪽 목록에서 고르면 오른쪽에서 바로 고친다
	import { beforeNavigate, goto } from '$app/navigation';
	import { inApp } from '#lib/native.js';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import AgentEditor from '#lib/components/AgentEditor.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import PersonaEditor from '#lib/components/PersonaEditor.svelte';
	import TeamsTab from '#lib/manage/TeamsTab.svelte';
	import { download } from '#lib/download.js';
	import { statusLine } from '#lib/shell/agent-line.js';
	import Button from '#lib/ui/Button.svelte';
	import ListDetail from '#lib/ui/ListDetail.svelte';
	import ListRow from '#lib/ui/ListRow.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import type { Agent, Persona } from '@proprix/shared';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconRobot from '@tabler/icons-svelte-runes/icons/robot';
	import IconMasksTheater from '@tabler/icons-svelte-runes/icons/masks-theater';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import { onMount, untrack } from 'svelte';

	// undefined: 닫힘, null: 새로 만들기
	let editingPersona = $state<Persona | null | undefined>(undefined);
	let editingAgent = $state<Agent | null | undefined>(undefined);
	let tab = $state<'agents' | 'personas' | 'teams'>('agents');
	let removing = $state<{ kind: 'agent' | 'persona'; id: string; name: string } | null>(null);
	let fileInput: HTMLInputElement | undefined = $state();
	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	// 다른 화면에서 ?edit=에이전트id · ?new=agent · ?tab=personas 로 바로 연다
	// 주소마다 한 번만 (에이전트 목록이 늦게 오면 온 뒤에)
	let handled = '';
	$effect(() => {
		const search = page.url.search;
		const q = page.url.searchParams;
		const id = q.get('edit');
		const agent = id ? app.agents.find((a) => a.id === id) : undefined;
		if (search === handled || (id && !agent)) return;
		handled = search;
		untrack(() => {
			if (q.get('tab') === 'personas') tab = 'personas';
			else if (q.get('tab') === 'teams') tab = 'teams';
			if (agent) {
				tab = 'agents';
				editingAgent = agent;
			} else if (q.get('new') === 'agent') {
				tab = 'agents';
				editingAgent = null;
			}
		});
	});

	// 오른쪽에 보이는 에이전트: 고른 것, 없으면 첫 번째 (null = 새로 만들기). 지워졌으면 첫 번째로
	const current = $derived(editingAgent === null ? null : ((editingAgent && app.agent(editingAgent.id)) ?? app.agents[0]));
	let revision = $state(0); // 저장·취소하면 편집기를 저장된 값으로 다시 연다

	// 저장 안 한 변경이 있으면 옮기기 전에 묻는다. 창을 닫거나 새로 고칠 때는 브라우저 기본 경고 (데스크톱 앱은 창이 닫히지 않을 수 있어 뺀다)
	let dirty = $state(false);
	let leaving = $state<(() => void) | null>(null);
	const guarded = (fn: () => void) => {
		if (dirty) leaving = () => fn();
		else fn();
	};
	function discard() {
		const fn = leaving;
		leaving = null;
		dirty = false;
		fn?.();
	}
	beforeNavigate((nav) => {
		const to = nav.to?.url;
		if (nav.willUnload) {
			if (dirty && !inApp) nav.cancel();
			return;
		}
		if (!dirty || !to) return;
		nav.cancel();
		leaving = () => void goto(to);
	});

	function selectAgent(a: Agent) {
		// 지금 고치는 에이전트를 다시 눌러도 고친 내용을 지우지 않는다
		if (tab === 'agents' && editingPersona === undefined && current?.id === a.id) return;
		guarded(() => {
			tab = 'agents';
			editingPersona = undefined;
			editingAgent = a;
			revision++;
		});
	}

	function selectTab(t: 'personas' | 'teams') {
		guarded(() => {
			tab = t;
			editingPersona = undefined;
		});
	}

	function newAgent() {
		guarded(() => {
			tab = 'agents';
			editingPersona = undefined;
			editingAgent = null;
			revision++;
		});
	}

	// 편집기를 닫아도 고른 에이전트에 머문다. 주소의 ?edit 은 지운다 (다시 열리지 않게)
	function closeEditor() {
		dirty = false;
		if (editingAgent === null) editingAgent = undefined;
		editingPersona = undefined;
		revision++;
		if (page.url.search) void goto('/agents', { replaceState: true });
	}

	const usage = (personaId: string) => app.agents.filter((a) => a.personaId === personaId).length;

	async function run(fn: () => Promise<unknown>, ok = '') {
		try {
			await fn();
			if (ok) toast(ok, 'success');
		} catch (e) {
			toastError(e);
		}
	}

	async function onImport(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		await run(async () => {
			editingPersona = await app.importPersona(file); // 가져온 뒤 이모지·색을 다듬을 수 있게 바로 연다
		}, '가져왔습니다');
	}

	const exportPersona = (p: Persona, format: 'json' | 'markdown') =>
		run(() =>
			download(
				`/personas/${p.id}/export${format === 'markdown' ? '?format=markdown' : ''}`,
				format === 'markdown' ? 'persona.md' : `${p.name}.json`
			)
		);

	function confirmRemove() {
		const r = removing;
		removing = null;
		if (!r) return;
		void run(() => (r.kind === 'agent' ? app.deleteAgent(r.id) : app.deletePersona(r.id)), `'${r.name}' 을(를) 삭제했습니다`);
	}

	const agentItems = (a: Agent): MenuItem[] => [
		{ label: '편집', icon: IconPencil, onSelect: () => selectAgent(a) },
		...(a.builtin
			? []
			: [{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = { kind: 'agent' as const, id: a.id, name: a.name }) }])
	];
	const personaItems = (p: Persona): MenuItem[] => [
		{ label: '편집', icon: IconPencil, onSelect: () => (editingPersona = p) },
		{ label: 'JSON 내보내기', icon: IconDownload, onSelect: () => void exportPersona(p, 'json') },
		{ label: 'persona.md 내보내기', icon: IconDownload, onSelect: () => void exportPersona(p, 'markdown') },
		...(p.builtin
			? []
			: [{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = { kind: 'persona' as const, id: p.id, name: p.name }) }])
	];
</script>

<ListDetail label="에이전트 목록">
	{#snippet list()}
		<div class="list-head">
			<span>에이전트</span>
			<IconButton icon={IconPlus} label="새 에이전트" size="sm" disabled={app.personas.length === 0} onclick={newAgent} />
		</div>
		{#each app.orderedAgents as a (a.id)}
			{@const line = statusLine(app.statuses[a.id], now)}
			<ListRow title={a.name} sub={line.text} active={tab === 'agents' && current?.id === a.id} onclick={() => selectAgent(a)}>
				{#snippet lead()}<Avatar agentId={a.id} size={1.3} status={line.state} />{/snippet}
				{#snippet trail()}
					{#if !a.builtin}
						<Menu items={agentItems(a)}>
							{#snippet trigger({ toggle, props })}
								<IconButton icon={IconDots} label="{a.name} 메뉴" size="sm" onclick={toggle} {...props} />
							{/snippet}
						</Menu>
					{/if}
				{/snippet}
			</ListRow>
		{:else}
			<p class="hint pad">에이전트가 없습니다.</p>
		{/each}
		<div class="list-sec">그 밖에</div>
		<ListRow title="페르소나" sub="{app.personas.length}개" active={tab === 'personas'} onclick={() => selectTab('personas')}>
			{#snippet lead()}<IconMasksTheater size="1.1rem" stroke={1.75} aria-hidden="true" />{/snippet}
		</ListRow>
		<ListRow title="팀" sub="{app.teams.length}개" active={tab === 'teams'} onclick={() => selectTab('teams')}>
			{#snippet lead()}<IconUsers size="1.1rem" stroke={1.75} aria-hidden="true" />{/snippet}
		</ListRow>
	{/snippet}

	{#if editingPersona !== undefined}
		{#key editingPersona?.id ?? 'new'}
			<PersonaEditor persona={editingPersona} onclose={closeEditor} bind:dirty />
		{/key}
	{:else if tab === 'agents'}
		{#if current !== undefined}
			{#key `${current?.id ?? 'new'}:${revision}`}
				<AgentEditor agent={current} onclose={closeEditor} bind:dirty />
			{/key}
		{:else}
			<EmptyState icon={IconRobot} title="에이전트가 없어요" body="새 에이전트를 만들어 보세요." />
		{/if}
	{:else if tab === 'teams'}
		<div class="page">
			<h1>팀</h1>
			<TeamsTab />
		</div>
	{:else}
		<div class="page">
			<header>
				<h1>페르소나</h1>
				<span class="grow"></span>
				<Button icon={IconUpload} onclick={() => fileInput?.click()}>가져오기</Button>
				<Button variant="primary" icon={IconPlus} onclick={() => (editingPersona = null)}>새 페르소나</Button>
				<input bind:this={fileInput} type="file" accept=".json,.md,.txt" hidden onchange={onImport} />
			</header>
			<p class="hint">PROPRIX 페르소나 파일(.json) 또는 desktop_pet <code>persona.md</code> 를 가져올 수 있습니다.</p>
			<ul class="rows">
				{#each app.personas as p (p.id)}
					<li>
						<button class="main" onclick={() => (editingPersona = p)}>
							<Avatar emoji={p.emoji} color={p.color} image={p.avatarImage} size={1.5} />
							<span class="text">
								<span class="name">{p.name}{#if p.builtin}<span class="tag">기본</span>{/if}</span>
								<span class="meta">{p.description || '설명 없음'} · 에이전트 {usage(p.id)}개</span>
							</span>
						</button>
						<Menu items={personaItems(p)}>
							{#snippet trigger({ toggle, props })}
								<IconButton icon={IconDots} label="{p.name} 메뉴" size="sm" onclick={toggle} {...props} />
							{/snippet}
						</Menu>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</ListDetail>

<ConfirmDialog open={leaving !== null} title="저장하지 않은 변경" confirmLabel="버리고 옮기기" cancelLabel="계속 편집" onconfirm={discard} onclose={() => (leaving = null)}>
	<p>편집한 내용을 저장하지 않았습니다. 버리고 옮길까요?</p>
</ConfirmDialog>

<ConfirmDialog open={removing !== null} title="삭제" onconfirm={confirmRemove} onclose={() => (removing = null)}>
	<p>
		{removing?.kind === 'agent' ? '에이전트' : '페르소나'} '{removing?.name}' 을(를) 삭제할까요?
		{#if removing?.kind === 'persona'}쓰고 있는 에이전트가 있으면 삭제할 수 없습니다.{/if}
		{#if removing?.kind === 'agent'}참여 중인 채팅이 있으면 삭제할 수 없습니다.{/if}
	</p>
</ConfirmDialog>

<style>
	.page {
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5);
		display: grid;
		align-content: start;
		gap: var(--s-4);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	h1 {
		font-size: var(--t-2xl);
	}
	.grow {
		flex: 1;
	}
	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--s-1) var(--s-2) var(--s-2);
		font-weight: var(--w-bold);
	}
	.list-sec {
		padding: var(--s-3) var(--s-2) var(--s-1);
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.pad {
		padding: var(--s-2);
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
		color: var(--c-text-4);
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
