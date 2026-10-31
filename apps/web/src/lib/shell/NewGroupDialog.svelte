<script lang="ts">
	// 새 그룹 대화: 참여 에이전트(2명 이상)와 이름. 팀 프리셋을 불러오거나 고른 구성을 팀으로 저장한다 (P10d)
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import TeamDialog from '#lib/components/TeamDialog.svelte';
	import { errorText } from '#lib/ui/toast.svelte.js';
	import { MAX_ROOM_AGENTS, MIN_TEAM_AGENTS } from '@proprix/shared';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	let picked = $state<string[]>([]);
	let title = $state('');
	let chainLimit = $state(3);
	let teamId = $state(''); // 불러온 팀
	let saving = $state(false); // 팀으로 저장 대화상자
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		if (open) {
			picked = [];
			title = '';
			chainLimit = 3;
			teamId = '';
			error = '';
		}
	});

	function loadTeam(id: string) {
		teamId = id;
		const t = app.teams.find((x) => x.id === id);
		if (!t) return;
		picked = t.agentIds.filter((a) => app.agent(a));
		chainLimit = t.chainLimit;
		if (!title.trim()) title = t.name;
	}

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
	}

	async function create() {
		if (picked.length < 2) {
			error = '에이전트를 2명 이상 고르세요.';
			return;
		}
		busy = true;
		try {
			const room = await app.newRoom(picked, title.trim() || picked.map((id) => app.agent(id)?.name).join(', '), chainLimit);
			onclose();
			await goto(`/rooms/${room.id}`);
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog {open} title="새 그룹챗" {onclose}>
	{#if app.teams.length}
		<Field label="팀 불러오기">
			<select value={teamId} onchange={(e) => loadTeam(e.currentTarget.value)}>
				<option value="">고르지 않음</option>
				{#each app.teams as t (t.id)}
					<option value={t.id} disabled={t.agentIds.length < MIN_TEAM_AGENTS}>{t.name}</option>
				{/each}
			</select>
		</Field>
	{/if}
	<Field label="이름" hint="비우면 참여자 이름으로">
		<input bind:value={title} maxlength="100" placeholder="주말 계획" />
	</Field>
	<div class="list" role="group" aria-label="참여 에이전트">
		{#each app.agents as a (a.id)}
			{@const on = picked.includes(a.id)}
			<label class="row">
				<input
					type="checkbox"
					checked={on}
					disabled={!on && picked.length >= MAX_ROOM_AGENTS}
					onchange={(e) => toggle(a.id, e.currentTarget.checked)}
				/>
				<Avatar agentId={a.id} size={1.5} />
				<span>{a.name}</span>
				{#if on}<span class="order">{picked.indexOf(a.id) + 1}</span>{/if}
			</label>
		{/each}
	</div>
	<p class="hint">고른 순서가 차례대로 답할 때의 순서입니다. @이름으로 부르면 그 에이전트가 답합니다.</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#snippet footer()}
		<Button disabled={picked.length < MIN_TEAM_AGENTS} onclick={() => (saving = true)}>팀으로 저장</Button>
		<span class="grow"></span>
		<Button onclick={onclose}>취소</Button>
		<Button variant="primary" disabled={busy} onclick={create}>만들기</Button>
	{/snippet}
</Dialog>

<TeamDialog open={saving} initial={{ agentIds: picked, chainLimit, name: title.trim() }} onclose={() => (saving = false)} />

<style>
	.list {
		display: grid;
		gap: 2px;
		max-height: 16.25rem;
		overflow-y: auto;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.5rem;
		border-radius: var(--r-2);
		color: var(--c-text);
	}
	.row:hover {
		background: var(--c-hover);
	}
	.grow {
		flex: 1;
	}
	.order {
		margin-left: auto;
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.error {
		font-size: var(--t-sm);
		color: var(--c-danger);
	}
</style>
