<script lang="ts">
	// 팀 프리셋 만들기·고치기 (P10d): 이름·설명·참가자(순서)·연쇄 상한. 역할·도구는 각 에이전트 설정을 그대로 쓴다
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { errorText, toast } from '#lib/ui/toast.svelte.js';
	import { MAX_ROOM_AGENTS, MIN_TEAM_AGENTS, type Team, TeamInput } from '@proprix/shared';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconChevronUp from '@tabler/icons-svelte-runes/icons/chevron-up';
	import { untrack } from 'svelte';

	let {
		open,
		team = null,
		initial,
		onclose
	}: {
		open: boolean;
		team?: Team | null; // null = 새 팀
		initial?: { agentIds: string[]; chainLimit: number; name?: string }; // 새 팀의 처음 값 (지금 대화·고른 참가자)
		onclose: () => void;
	} = $props();

	let name = $state('');
	let description = $state('');
	let picked = $state<string[]>([]);
	let chainLimit = $state(3);
	let error = $state('');
	let busy = $state(false);

	// 열릴 때마다 채운다
	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = team?.name ?? initial?.name ?? '';
			description = team?.description ?? '';
			picked = [...(team?.agentIds ?? initial?.agentIds ?? [])].filter((id) => app.agent(id));
			chainLimit = team?.chainLimit ?? initial?.chainLimit ?? 3;
			error = '';
		});
	});

	// 고른 참가자(순서대로) → 나머지
	const ordered = $derived([...picked.flatMap((id) => app.agent(id) ?? []), ...app.agents.filter((a) => !picked.includes(a.id))]);
	const toggle = (id: string, on: boolean) => (picked = on ? [...picked, id] : picked.filter((x) => x !== id));
	function move(id: string, by: number) {
		const i = picked.indexOf(id);
		const j = i + by;
		if (i < 0 || j < 0 || j >= picked.length) return;
		const next = [...picked];
		[next[i], next[j]] = [next[j] as string, next[i] as string];
		picked = next;
	}

	async function save() {
		const parsed = TeamInput.safeParse({ name, description, agentIds: picked, chainLimit });
		if (!parsed.success) {
			error = picked.length < MIN_TEAM_AGENTS ? '에이전트를 2명 이상 고르세요.' : parsed.error.issues.map((i) => i.message).join(', ');
			return;
		}
		busy = true;
		try {
			await app.saveTeam(team?.id ?? null, parsed.data);
			toast(team ? '팀을 편집했습니다' : `'${parsed.data.name}' 팀을 저장했습니다. /team ${parsed.data.name} 으로 새 채팅을 엽니다`, 'success');
			onclose();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog {open} title={team ? '팀 편집' : '팀으로 저장'} width={520} {onclose}>
	<form
		id="team-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="이름" hint="/team 이름 으로 이 구성의 새 채팅을 엽니다">
			<input bind:value={name} maxlength="40" placeholder="리서치팀" />
		</Field>
		<Field label="설명">
			<input bind:value={description} maxlength="200" placeholder="검색 + 정리 + 검토" />
		</Field>
		<fieldset>
			<legend>참여자 (답변 순서)</legend>
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
							<Avatar agentId={a.id} size={1.2} />
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
		</fieldset>
		<label class="limit">
			연쇄 응답 상한
			<select bind:value={chainLimit}>
				{#each [1, 2, 3, 4, 5] as n (n)}<option value={n}>{n}</option>{/each}
			</select>
		</label>
		<p class="hint">역할·도구는 각 에이전트 설정을 그대로 씁니다.</p>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</form>
	{#snippet footer()}
		<Button onclick={onclose}>취소</Button>
		<Button variant="primary" type="submit" form="team-form" disabled={busy}>저장</Button>
	{/snippet}
</Dialog>

<style>
	.form {
		display: grid;
		gap: var(--s-3);
	}
	fieldset {
		margin: 0;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
	legend {
		padding: 0 var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
		max-height: 14rem;
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
	li label {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex: 1;
	}
	.order {
		display: flex;
		gap: 0.2rem;
	}
	.limit {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
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
