<script lang="ts">
	// 방 참여자·연쇄 상한 편집 (2명 이상이면 그룹챗)
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import TeamDialog from '#lib/components/TeamDialog.svelte';
	import Button from '#lib/ui/Button.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { errorText } from '#lib/ui/toast.svelte.js';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconChevronUp from '@tabler/icons-svelte-runes/icons/chevron-up';
	import { MAX_ROOM_AGENTS, MIN_TEAM_AGENTS } from '@proprix/shared';

	let { onclose }: { onclose: () => void } = $props();

	let picked = $state<string[]>([...(app.room?.agentIds ?? [])]);
	let chainLimit = $state(app.room?.chainLimit ?? 3);
	let error = $state('');
	let saving = $state(false);
	let teamOpen = $state(false); // 이 구성을 팀으로 저장

	// 현재 참여자(순서대로) → 나머지
	const ordered = $derived([
		...picked.flatMap((id) => app.agent(id) ?? []),
		...app.agents.filter((a) => !picked.includes(a.id))
	]);

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
	}

	function move(id: string, by: number) {
		const i = picked.indexOf(id);
		const j = i + by;
		if (i < 0 || j < 0 || j >= picked.length) return;
		const next = [...picked];
		[next[i], next[j]] = [next[j] as string, next[i] as string];
		picked = next;
	}

	async function save() {
		error = '';
		saving = true;
		try {
			await app.updateRoom({ agentIds: picked, chainLimit });
			onclose();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
</script>

<div class="panel">
	<p class="hint">
		2명 이상이면 그룹챗입니다. <code>@이름</code>으로 부르면 그 에이전트가, 아니면 라우터가 고른 에이전트가 답합니다. 순서는
		라우터 실패 시 돌아가며 답하는 차례입니다.
	</p>
	<ul>
		{#each ordered as a (a.id)}
			{@const on = picked.includes(a.id)}
			<li>
				<label>
					<input
						type="checkbox"
						checked={on}
						disabled={!on && picked.length >= MAX_ROOM_AGENTS}
						onchange={(e) => toggle(a.id, e.currentTarget.checked)}
					/>
					<Avatar agentId={a.id} size={1.3} />
					{a.name}
				</label>
				{#if on && picked.length > 1}
					<span class="order">
						<IconButton icon={IconChevronUp} label="{a.name} 위로" size="sm" onclick={() => move(a.id, -1)} />
						<IconButton icon={IconChevronDown} label="{a.name} 아래로" size="sm" onclick={() => move(a.id, 1)} />
					</span>
				{/if}
			</li>
		{/each}
	</ul>
	<label class="limit">
		연쇄 응답 상한
		<select bind:value={chainLimit}>
			{#each [1, 2, 3, 4, 5] as n (n)}
				<option value={n}>{n}</option>
			{/each}
		</select>
		<span class="hint">사용자 메시지 1개에 에이전트가 이어서 답하는 최대 횟수</span>
	</label>
	<div class="actions">
		<Button size="sm" disabled={picked.length < MIN_TEAM_AGENTS} onclick={() => (teamOpen = true)}>팀으로 저장</Button>
		<span class="grow"></span>
		<Button size="sm" onclick={onclose}>취소</Button>
		<Button size="sm" variant="primary" disabled={saving || picked.length === 0 || app.streaming} onclick={save}>저장</Button>
	</div>
	{#if app.streaming}<p class="hint">응답 중에는 참여자를 바꿀 수 없습니다.</p>{/if}
	{#if error}<p class="error">{error}</p>{/if}
</div>

<TeamDialog open={teamOpen} initial={{ agentIds: picked, chainLimit, name: app.room?.title }} onclose={() => (teamOpen = false)} />

<style>
	/* 대화상자·오른쪽 패널 안에 들어간다 (바깥 여백·배경은 그쪽에서) */
	.panel {
		font-size: 0.85rem;
	}
	ul {
		list-style: none;
		margin: 0.4rem 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
		max-height: 14rem;
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	li label {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		justify-content: flex-end;
		flex: 1;
	}
	.order {
		display: flex;
		gap: 0.2rem;
	}
	.limit {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.grow {
		flex: 1;
	}
	.actions {
		display: flex;
		gap: var(--s-2);
		justify-content: flex-end;
		margin-top: 0.5rem;
	}
	.hint {
		margin: 0;
		color: var(--c-text-3);
		font-size: 0.75rem;
	}
	.error {
		margin: 0.3rem 0 0;
		color: var(--c-danger);
	}
</style>
