<script lang="ts">
	// 리서치 만들기·고치기 (P11b): 목표, 결과 글 종류, 글쓴이, 범위(페이지·깊이·검색어·도메인), 저장 위치, 반복 예약 (P11c)
	import { app } from '#lib/app.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import { errorText, toast } from '#lib/ui/toast.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import {
		RESEARCH_LIMITS,
		RESEARCH_MAX_AGENTS,
		type Research,
		ResearchInput,
		type ResearchMode,
		researchRequests,
		type TaskSchedule
	} from '@proprix/shared';
	import ScheduleEditor from './ScheduleEditor.svelte';
	import { untrack } from 'svelte';

	let {
		open,
		research = null,
		onclose,
		onsaved
	}: { open: boolean; research?: Research | null; onclose: () => void; onsaved?: (r: Research) => void } = $props();

	// 결과 글 종류 → 지시 (직접 쓰기는 자유 지시만)
	const KINDS = {
		review: { label: '감상문', text: '읽은 내용을 바탕으로 개인적인 감상문을 써 주세요.' },
		evaluation: { label: '평가', text: '장단점과 근거를 들어 평가하고, 마지막에 한 줄 결론과 점수(10점 만점)를 붙여 주세요.' },
		summary: { label: '요약', text: '핵심을 정리한 요약 보고서를 써 주세요.' },
		custom: { label: '직접 쓰기', text: '' }
	} as const;
	type Kind = keyof typeof KINDS;

	let title = $state('');
	let goal = $state('');
	let kind = $state<Kind>('review');
	let extra = $state('');
	let agentIds = $state<string[]>([]);
	let mode = $state<ResearchMode>('separate');
	const MODES: Record<ResearchMode, { label: string; hint: string }> = {
		separate: { label: '각자 조사하고 각자 글쓰기', hint: '에이전트마다 따로 검색·읽기·글쓰기를 합니다.' },
		merged: { label: '각자 조사한 뒤 합친 글 추가', hint: '각자의 글에 더해, 첫 번째로 고른 에이전트가 하나로 합친 글을 씁니다.' },
		shared: { label: '자료는 함께, 글만 각자', hint: '첫 번째로 고른 에이전트가 한 번 모으고, 글은 각자 씁니다. 요청이 가장 적습니다.' }
	};
	const toggleAgent = (id: string, on: boolean) => (agentIds = on ? [...agentIds, id] : agentIds.filter((x) => x !== id));
	let maxPages = $state(15);
	let depth = $state(1);
	let queries = $state(4);
	const estimate = $derived(researchRequests({ queries: Number(queries) || 0, maxPages: Number(maxPages) || 0 }, agentIds.length || 1, mode));
	let domains = $state('');
	let startUrls = $state('');
	let target = $state<'note' | 'file'>('note');
	let roomId = $state('');
	let path = $state('');
	let repeat = $state(false);
	let schedule = $state<TaskSchedule>({ kind: 'daily', time: '09:00' });
	let scheduleErr = $state('');
	let error = $state('');
	let busy = $state(false);

	const workspaceRooms = $derived(app.rooms.filter((r) => r.kind === 'chat' && r.workspace));

	$effect(() => {
		if (!open) return;
		untrack(() => {
			const r = research;
			title = r?.title ?? '';
			goal = r?.goal ?? '';
			const known = (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k].text && r?.instruction.startsWith(KINDS[k].text));
			kind = r ? (known ?? 'custom') : 'review';
			extra = r ? (known ? r.instruction.slice(KINDS[known].text.length).trim() : r.instruction) : '';
			agentIds = r ? r.agentIds.filter((id) => app.agent(id)) : app.orderedAgents.slice(0, 1).map((a) => a.id);
			mode = r?.mode ?? 'separate';
			maxPages = r?.scope.maxPages ?? 15;
			depth = r?.scope.depth ?? 1;
			queries = r?.scope.queries ?? 4;
			domains = r?.scope.domains.join('\n') ?? '';
			startUrls = r?.scope.startUrls.join('\n') ?? '';
			target = r?.output.target ?? 'note';
			roomId = r?.output.target === 'file' ? r.output.roomId : (workspaceRooms[0]?.id ?? '');
			path = r?.output.target === 'file' ? r.output.path : 'research/결과.md';
			repeat = !!r?.schedule;
			error = '';
		});
	});

	async function save() {
		if (repeat && scheduleErr) {
			error = scheduleErr;
			return;
		}
		const instruction = [KINDS[kind].text, extra.trim()].filter(Boolean).join('\n');
		const parsed = ResearchInput.safeParse({
			title,
			goal,
			instruction,
			agentIds,
			mode,
			scope: {
				maxPages,
				depth,
				queries,
				domains: [
					...new Set(
						domains
							.split(/[\s,]+/)
							.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
							.filter(Boolean)
					)
				],
				startUrls: [...new Set(startUrls.split(/\s+/).filter(Boolean))]
			},
			output: target === 'file' ? { target, roomId, path } : { target },
			schedule: repeat ? schedule : null,
			enabled: research?.enabled ?? true
		});
		if (!parsed.success) {
			error = parsed.error.issues.map((i) => i.message).join(', ');
			return;
		}
		busy = true;
		try {
			const saved = await app.saveResearch(research?.id ?? null, parsed.data);
			toast(research ? '리서치를 편집했습니다' : '리서치를 만들었습니다', 'success');
			onclose();
			onsaved?.(saved);
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog {open} title={research ? '리서치 편집' : '새 리서치'} width={600} {onclose}>
	<form
		id="research-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="제목">
			<input bind:value={title} maxlength="100" placeholder="이번 주 개봉 영화 평가" />
		</Field>
		<Field label="무엇을 조사할까요" hint="에이전트가 검색어를 만들고, 찾은 페이지와 그 안의 링크를 읽습니다">
			<textarea bind:value={goal} rows="3" maxlength="2000" placeholder="올해 나온 무선 이어폰의 음질·배터리 평가"></textarea>
		</Field>
		<fieldset>
			<legend>맡을 에이전트 (최대 {RESEARCH_MAX_AGENTS}명)</legend>
			<div class="agents">
				{#each app.orderedAgents as a (a.id)}
					{@const on = agentIds.includes(a.id)}
					<label class="agent" class:on>
						<input
							type="checkbox"
							checked={on}
							disabled={!on && agentIds.length >= RESEARCH_MAX_AGENTS}
							onchange={(e) => toggleAgent(a.id, e.currentTarget.checked)}
						/>
						<Avatar agentId={a.id} size={1.25} />
						{a.name}
					</label>
				{/each}
			</div>
			{#if agentIds.length > 1}
				<select bind:value={mode} aria-label="결과 방식">
					{#each Object.entries(MODES) as [k, v] (k)}<option value={k}>{v.label}</option>{/each}
				</select>
				<p class="hint">{MODES[mode].hint}</p>
			{/if}
		</fieldset>
		<Field label="결과 글">
			<select bind:value={kind}>
				{#each Object.entries(KINDS) as [k, v] (k)}<option value={k}>{v.label}</option>{/each}
			</select>
		</Field>
		<Field label={kind === 'custom' ? '어떻게 쓸까요' : '덧붙일 지시 (선택)'}>
			<textarea bind:value={extra} rows="2" maxlength="1500" placeholder="예: 500자 안팎, 표 하나 포함"></textarea>
		</Field>
		<fieldset>
			<legend>범위</legend>
			<div class="grid3">
				<label>페이지 수 <input type="number" min="1" max={RESEARCH_LIMITS.maxPages} bind:value={maxPages} /></label>
				<label>
					링크 깊이
					<select bind:value={depth}>
						<option value={0}>0 (검색 결과만)</option>
						<option value={1}>1</option>
						<option value={2}>2</option>
					</select>
				</label>
				<label>검색어 수 <input type="number" min="1" max={RESEARCH_LIMITS.queries} bind:value={queries} /></label>
			</div>
			<label class="block">
				허용 도메인 (비우면 제한 없음, 있으면 이 도메인과 그 하위만 읽음. 한 줄에 하나)
				<textarea bind:value={domains} rows="2" placeholder="example.com"></textarea>
			</label>
			<label class="block">
				시작 주소 (선택, 검색 결과와 함께 먼저 읽음. 검색에 안 잡히는 회원 전용 페이지 등. 한 줄에 하나)
				<textarea bind:value={startUrls} rows="2" placeholder="https://example.com/board"></textarea>
			</label>
			<p class="hint">
				검색어 수: 목표로 만들 검색 문장의 개수입니다. 링크 깊이: 읽은 페이지 안의 링크를 몇 단계까지 따라갈지입니다 (페이지마다 최대 3개, 페이지 수 상한까지).
			</p>
			<p class="hint">플랜 사용량: 이 설정이면 최대 약 {estimate}회입니다. 리서치 일일 예산 안에서만 돕니다.</p>
		</fieldset>
		<fieldset>
			<legend>저장 위치</legend>
			<label class="radio"><input type="radio" bind:group={target} value="note" /> 메모</label>
			<label class="radio">
				<input type="radio" bind:group={target} value="file" disabled={workspaceRooms.length === 0} /> 작업 폴더 파일
				{#if workspaceRooms.length === 0}<span class="hint">(작업 폴더가 있는 채팅이 없음)</span>{/if}
			</label>
			{#if target === 'file'}
				<div class="grid2">
					<select bind:value={roomId} aria-label="채팅">
						{#each workspaceRooms as r (r.id)}<option value={r.id}>{r.title}</option>{/each}
					</select>
					<input bind:value={path} maxlength="200" aria-label="파일 경로" />
				</div>
				<p class="hint">파일 이름 뒤에 날짜가 붙습니다. 그 채팅 메시지가 아니라 리서치 탭에서 되돌릴 수 있습니다.</p>
			{/if}
		</fieldset>
		<fieldset>
			<legend>반복 예약</legend>
			<label class="radio"><input type="checkbox" bind:checked={repeat} /> 정한 때마다 다시 실행</label>
			{#if repeat}
				<ScheduleEditor initial={research?.schedule ?? null} bind:schedule bind:error={scheduleErr} />
				<p class="hint">반복 실행은 이 리서치에서 예전에 읽은 페이지를 건너뛰고, 새로 읽은 관련 페이지가 없으면 글을 쓰지 않습니다.</p>
			{/if}
		</fieldset>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</form>
	{#snippet footer()}
		<Button onclick={onclose}>취소</Button>
		<Button variant="primary" type="submit" form="research-form" disabled={busy}>저장</Button>
	{/snippet}
</Dialog>

<style>
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.grid2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-3);
	}
	.grid3 {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--s-3);
	}
	.grid3 label,
	.block {
		display: grid;
		gap: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	fieldset {
		display: grid;
		gap: var(--s-2);
		margin: 0;
		padding: var(--s-2) var(--s-3) var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
	legend {
		padding: 0 var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.agents {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}
	.agent {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		padding: 0.25rem var(--s-2);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		font-size: var(--t-sm);
		cursor: pointer;
	}
	.agent.on {
		background: var(--c-selected);
		border-color: var(--c-text-3);
	}
	.agent:focus-within {
		box-shadow: var(--focus-ring);
	}
	.agent input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.radio {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
	.hint {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.error {
		font-size: var(--t-sm);
		color: var(--c-danger);
	}
</style>
