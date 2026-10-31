<script lang="ts">
	// /team (이름 없이·못 찾음): 팀을 골라 그 구성으로 새 대화 (P10d)
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { toastError } from '#lib/ui/toast.svelte.js';
	import { MIN_TEAM_AGENTS, type Team } from '@proprix/shared';
	import IconUsersGroup from '@tabler/icons-svelte-runes/icons/users-group';

	let busy = $state(false);
	const close = () => (app.teamPicker = false);

	async function open(t: Team) {
		busy = true;
		try {
			close();
			await app.openTeam(t);
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog open={app.teamPicker} title="팀으로 새 채팅" width={480} onclose={close}>
	{#if app.teams.length === 0}
		<EmptyState
			icon={IconUsersGroup}
			title="저장한 팀이 없어요"
			body="에이전트 화면의 팀 탭이나 새 그룹챗에서 참여자 묶음을 팀으로 저장하세요."
		/>
	{:else}
		<ul>
			{#each app.teams as t (t.id)}
				{@const short = t.agentIds.length < MIN_TEAM_AGENTS}
				<li>
					<button disabled={busy || short} onclick={() => open(t)}>
						<span class="stack" aria-hidden="true">
							{#each t.agentIds.slice(0, 4) as id (id)}<Avatar agentId={id} size={1.2} />{/each}
						</span>
						<span class="text">
							<span class="name">{t.name}{#if short}<span class="warn"> · 참여자 부족</span>{/if}</span>
							<span class="meta">{t.description || t.agentIds.map((id) => app.agent(id)?.name ?? '?').join(', ')}</span>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#snippet footer()}
		<Button
			onclick={() => {
				close();
				void goto('/agents?tab=teams');
			}}>팀 관리</Button
		>
		<Button onclick={close}>닫기</Button>
	{/snippet}
</Dialog>

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
		max-height: 20rem;
		overflow-y: auto;
	}
	button {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		width: 100%;
		padding: var(--s-2);
		border: none;
		border-radius: var(--r-2);
		background: none;
		color: var(--c-text);
		text-align: left;
	}
	button:hover:not(:disabled) {
		background: var(--c-hover);
	}
	button:disabled {
		opacity: 0.6;
	}
	.stack {
		display: flex;
	}
	.stack :global(*:not(:first-child)) {
		margin-left: -0.35rem;
	}
	.text {
		display: grid;
		min-width: 0;
	}
	.name {
		font-weight: var(--w-bold);
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.warn {
		color: var(--c-danger);
		font-size: var(--t-sm);
	}
</style>
