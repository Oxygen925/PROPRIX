<script lang="ts">
	// 에이전트 화면의 '팀' 탭 (P10d): 팀 프리셋 목록·만들기·고치기·지우기, 그 팀으로 새 대화
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import TeamDialog from '#lib/components/TeamDialog.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { MIN_TEAM_AGENTS, type Team } from '@proprix/shared';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconMessagePlus from '@tabler/icons-svelte-runes/icons/message-plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconUsersGroup from '@tabler/icons-svelte-runes/icons/users-group';

	let editing = $state<Team | null | undefined>(undefined); // undefined: 닫힘, null: 새 팀
	let removing = $state<Team | null>(null);

	async function run(fn: () => Promise<unknown>) {
		try {
			await fn();
		} catch (e) {
			toastError(e);
		}
	}

	const items = (t: Team): MenuItem[] => [
		{ label: '이 팀으로 새 채팅', icon: IconMessagePlus, onSelect: () => void run(() => app.openTeam(t)) },
		{ label: '편집', icon: IconPencil, onSelect: () => (editing = t) },
		{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = t) }
	];

	async function confirmRemove() {
		const t = removing;
		removing = null;
		if (t) await run(async () => {
			await app.deleteTeam(t.id);
			toast(`'${t.name}' 팀을 삭제했습니다`, 'success');
		});
	}
</script>

<div class="bar">
	<p class="hint">
		자주 쓰는 참여자 묶음을 팀으로 저장해 두고 <code>/team 이름</code> 이나 새 그룹챗에서 바로 씁니다. 역할·도구는 각 에이전트 설정을
		그대로 씁니다.
	</p>
	<Button variant="primary" icon={IconPlus} disabled={app.agents.length < MIN_TEAM_AGENTS} onclick={() => (editing = null)}>새 팀</Button>
</div>

{#if app.teams.length === 0}
	<EmptyState icon={IconUsersGroup} title="저장한 팀이 없어요" body="예: 리서치팀 = 검색 담당 + 정리 담당 + 검토 담당" />
{/if}
<ul class="rows">
	{#each app.teams as t (t.id)}
		{@const short = t.agentIds.length < MIN_TEAM_AGENTS}
		<li>
			<button class="main" onclick={() => (editing = t)}>
				<span class="stack" aria-hidden="true">
					{#each t.agentIds.slice(0, 4) as id (id)}<Avatar agentId={id} size={1.5} />{/each}
				</span>
				<span class="text">
					<span class="name">{t.name}{#if short}<span class="warn">참여자 부족</span>{/if}</span>
					<span class="meta">
						{t.agentIds.map((id) => app.agent(id)?.name ?? '?').join(' → ') || '참여자 없음'} · 연쇄 {t.chainLimit}{t.description
							? ` · ${t.description}`
							: ''}
					</span>
				</span>
			</button>
			<Menu items={items(t)}>
				{#snippet trigger({ toggle, props })}
					<IconButton icon={IconDots} label="{t.name} 메뉴" size="sm" onclick={toggle} {...props} />
				{/snippet}
			</Menu>
		</li>
	{/each}
</ul>

<TeamDialog open={editing !== undefined} team={editing ?? null} onclose={() => (editing = undefined)} />

<ConfirmDialog open={removing !== null} title="팀 삭제" onconfirm={confirmRemove} onclose={() => (removing = null)}>
	<p>'{removing?.name}' 팀을 삭제할까요? 에이전트와 채팅은 그대로 남습니다.</p>
</ConfirmDialog>

<style>
	.bar {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
	}
	.hint {
		flex: 1;
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
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-width: 0;
		padding: var(--s-2) var(--s-3);
		border: none;
		background: none;
		color: var(--c-text);
		text-align: left;
	}
	.stack {
		display: flex;
	}
	.stack :global(*:not(:first-child)) {
		margin-left: -0.45rem;
	}
	.text {
		display: grid;
		min-width: 0;
	}
	.name {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.warn {
		font-size: var(--t-xs);
		color: var(--c-danger);
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
