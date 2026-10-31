<script lang="ts">
	// 토론·협업 시작: 주제·참가자(방 참여자 중, /debate·/collab 이면 아무 에이전트)·진행자(아무 에이전트)·라운드
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { errorText } from '#lib/ui/toast.svelte.js';
	import { MAX_DEBATE_AGENTS, MAX_DEBATE_ROUNDS, type DebateMode } from '@proprix/shared';
	import { untrack } from 'svelte';

	let {
		onclose,
		invite = false,
		initialMode = 'debate',
		initialTopic = ''
	}: {
		onclose: () => void;
		// /debate·/collab: 방 밖 에이전트도 초대하고 이 대화의 기억·도구 작업을 넘긴다 (방 구성은 그대로)
		invite?: boolean;
		initialMode?: DebateMode;
		initialTopic?: string;
	} = $props();

	// 고를 수 있는 참가자: 방 참여자, 초대면 그 뒤에 나머지 에이전트
	const members = $derived(
		invite ? [...app.roomAgents, ...app.agents.filter((a) => !app.room?.agentIds.includes(a.id))] : app.roomAgents
	);
	// /debate·/collab 이 채운 값으로 시작 (처음 값만)
	let mode = $state<DebateMode>(untrack(() => initialMode));
	let topic = $state(untrack(() => initialTopic));
	let picked = $state<string[]>(app.roomAgents.slice(0, MAX_DEBATE_AGENTS).map((a) => a.id));
	// 기본 진행자: 참가자가 아닌 기본 에이전트가 있으면 그쪽, 없으면 첫 참가자
	let moderatorId = $state(
		app.agents.find((a) => a.builtin && !app.room?.agentIds.includes(a.id))?.id ?? app.roomAgents[0]?.id ?? ''
	);
	let rounds = $state(2);
	let error = $state('');
	let starting = $state(false);

	// 발언 순서: 초대면 고른 순서, 아니면 방 참여자 순서
	const ordered = $derived(
		invite ? picked.flatMap((id) => app.agent(id) ?? []) : members.filter((a) => picked.includes(a.id))
	);
	// 여는 말 + 라운드 × 참가자 + 맺는 말 (위임·도구 단계는 별도)
	const calls = $derived(rounds * ordered.length + 2);
	const canStart = $derived(
		topic.trim() !== '' && ordered.length >= 2 && !!moderatorId && !app.streaming && !!app.model && !starting
	);

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
	}

	async function start() {
		error = '';
		starting = true;
		try {
			await app.startDebate({
				mode,
				topic: topic.trim(),
				agentIds: ordered.map((a) => a.id),
				moderatorId,
				rounds,
				...(invite ? { context: true } : {})
			});
			onclose();
		} catch (e) {
			error = errorText(e);
		} finally {
			starting = false;
		}
	}
</script>

<div class="panel">
	{#if members.length < 2}
		<p class="hint">
			토론·협업은 채팅 참여자가 2명 이상일 때 시작할 수 있습니다. 먼저 참여자를 추가하거나, 입력창에서 /debate·/collab 으로
			다른 에이전트를 초대하세요.
		</p>
	{:else}
		<div class="modes" role="radiogroup" aria-label="방식">
			<label><input type="radio" bind:group={mode} value="debate" /> {app.label('debate', '토론')} <span class="hint">서로 반박하고 진행자가 결론</span></label>
			<label><input type="radio" bind:group={mode} value="collab" /> 협업 <span class="hint">앞 발언을 보완해 결과물을 만들고 진행자가 최종본 정리</span></label>
		</div>
		<textarea
			bind:value={topic}
			rows="2"
			maxlength="2000"
			placeholder={mode === 'debate' ? '토론 주제 (예: 재택근무가 더 생산적인가)' : '함께 만들 것 (예: 주말 여행 계획 초안)'}
		></textarea>
		<div class="row">
			<span class="label">{app.label('participant', '참여자')} ({invite ? '고른 순서로 발언' : '발언 순서'})</span>
			{#each members as a (a.id)}
				<label class="who">
					<input
						type="checkbox"
						checked={picked.includes(a.id)}
						disabled={!picked.includes(a.id) && picked.length >= MAX_DEBATE_AGENTS}
						onchange={(e) => toggle(a.id, e.currentTarget.checked)}
					/>
					<Avatar agentId={a.id} size={1.2} />
					{a.name}{#if invite && !app.room?.agentIds.includes(a.id)}<span class="hint">(초대)</span>{/if}
				</label>
			{/each}
		</div>
		<div class="row">
			<label>
				진행자
				<select bind:value={moderatorId}>
					{#each app.agents as a (a.id)}
						<option value={a.id}>{a.name}{picked.includes(a.id) ? ' (참여자)' : ''}</option>
					{/each}
				</select>
			</label>
			<label>
				라운드
				<select bind:value={rounds}>
					{#each Array.from({ length: MAX_DEBATE_ROUNDS }, (_, i) => i + 1) as n (n)}
						<option value={n}>{n}</option>
					{/each}
				</select>
			</label>
		</div>
		{#if invite}
			<p class="hint">
				참여자 모두가 이 채팅의 내용과 이 채팅에서 나온 기억(참여자 개인 기억 포함), 최근 도구 작업 기록을 참고합니다. 초대한
				에이전트는 이 토론에서만 말하고 채팅 참여자는 바뀌지 않습니다. 토론 중에는 새 기억을 저장하지 않습니다.
			</p>
		{/if}
		<p class="hint">
			플랜 사용량: 응답 약 {calls}회 (도구·위임을 쓰면 더). 진행 중에는 메시지를 보낼 수 없고 '중지'로 멈출 수 있습니다. 토론
			발언은 기억으로 추출하지 않습니다.
		</p>
		<div class="actions">
			<Button onclick={onclose}>취소</Button>
			<Button variant="primary" disabled={!canStart} onclick={start}>{mode === 'debate' ? '토론 시작' : '협업 시작'}</Button>
		</div>
		{#if error}<p class="error">{error}</p>{/if}
	{/if}
</div>

<style>
	/* 대화상자·오른쪽 패널 안에 들어간다 (바깥 여백·배경은 그쪽에서) */
	.panel {
		font-size: 0.85rem;
		display: grid;
		gap: 0.45rem;
	}
	.modes {
		display: grid;
		gap: 0.2rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.4rem;
		border-radius: 0.4rem;
		border: 1px solid var(--c-line-strong);
		background: var(--c-surface-2);
		color: var(--c-text);
		resize: vertical;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.label {
		color: var(--c-text-3);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.actions {
		display: flex;
		gap: var(--s-2);
		justify-content: flex-end;
	}
	.hint {
		margin: 0;
		color: var(--c-text-3);
		font-size: 0.75rem;
	}
	.error {
		margin: 0;
		color: var(--c-danger);
	}
</style>
