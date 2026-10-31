<script lang="ts" module>
	const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
	// 짧은 날짜: 10/30(금) 09:00
	export const shortWhen = (t: number) => {
		const d = new Date(t);
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
	};
</script>

<script lang="ts">
	// 반복 일정 입력 (예약 작업·리서치 공용): 처음 값으로 채우고, 만든 일정과 오류를 bind 로 돌려준다.
	// 대화상자가 열릴 때마다 새로 만들어지므로 initial 은 처음 한 번만 읽는다
	import Field from '#lib/ui/Field.svelte';
	import { describeSchedule, scheduleError, type TaskSchedule, upcoming } from '@proprix/shared';
	import { untrack } from 'svelte';

	let {
		initial = null,
		schedule = $bindable(),
		error = $bindable('')
	}: { initial?: TaskSchedule | null; schedule?: TaskSchedule; error?: string } = $props();

	const s0 = untrack(() => initial);
	let kind = $state<TaskSchedule['kind']>(s0?.kind ?? 'daily');
	let time = $state(s0 && 'time' in s0 ? s0.time : '09:00');
	let days = $state<number[]>(s0?.kind === 'weekly' ? [...s0.days] : [1, 2, 3, 4, 5]);
	let day = $state(s0?.kind === 'monthly' ? s0.day : 1);
	let hours = $state(s0?.kind === 'interval' ? s0.hours : 6);
	let cron = $state(s0?.kind === 'cron' ? s0.cron : '0 9 * * 1-5');

	const built = $derived<TaskSchedule>(
		kind === 'daily'
			? { kind: 'daily', time }
			: kind === 'weekly'
				? { kind: 'weekly', time, days: [...days].sort() }
				: kind === 'monthly'
					? { kind: 'monthly', time, day: Number(day) }
					: kind === 'interval'
						? { kind: 'interval', hours: Number(hours) }
						: { kind: 'cron', cron: cron.trim() }
	);
	// 미리보기: 공용 계산 그대로 (N시간마다는 지금을 기준으로 — 저장하면 저장 시각이 기준)
	const preview = $derived.by(() => {
		const now = Date.now();
		const s = built.kind === 'interval' ? { ...built, anchor: s0?.kind === 'interval' ? s0.anchor : now } : built;
		const err = kind === 'weekly' && days.length === 0 ? '요일을 하나 이상 고르세요' : scheduleError(s, now);
		return { text: describeSchedule(s), error: err ?? '', next: err ? [] : upcoming(s, now, 5) };
	});

	$effect.pre(() => {
		schedule = built;
		error = preview.error;
	});
</script>

<div class="two">
	<Field label="반복">
		<select bind:value={kind}>
			<option value="daily">매일</option>
			<option value="weekly">요일 고르기</option>
			<option value="monthly">매월</option>
			<option value="interval">N시간마다</option>
			<option value="cron">cron 식</option>
		</select>
	</Field>
	{#if kind === 'daily' || kind === 'weekly' || kind === 'monthly'}
		<Field label="시각"><input type="time" bind:value={time} /></Field>
	{:else if kind === 'interval'}
		<Field label="간격 (시간)" hint="1시간 이상"><input type="number" min="1" max="744" bind:value={hours} /></Field>
	{/if}
</div>
{#if kind === 'weekly'}
	<div class="days" role="group" aria-label="요일">
		{#each DAYS as d, i (i)}
			<label class="day" class:on={days.includes(i)}>
				<input
					type="checkbox"
					checked={days.includes(i)}
					onchange={(e) => (days = e.currentTarget.checked ? [...days, i] : days.filter((x) => x !== i))}
				/>{d}
			</label>
		{/each}
	</div>
{:else if kind === 'monthly'}
	<Field label="날짜" hint="그 달에 없는 날(31일 등)은 말일에"><input type="number" min="1" max="31" bind:value={day} /></Field>
{:else if kind === 'cron'}
	<Field label="cron 식" hint="분 시 일 월 요일 (이 PC 시각). 예: 0 9 * * 1-5 = 평일 9시. 실행 사이 1시간 이상">
		<input class="mono" bind:value={cron} spellcheck="false" />
	</Field>
{/if}
<div class="preview" aria-live="polite">
	{#if preview.error}
		<span class="err">{preview.error}</span>
	{:else}
		<strong>{preview.text}</strong> · 다음: {preview.next.map((t) => shortWhen(t)).join(', ')}
	{/if}
</div>

<style>
	.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-3);
	}
	.days {
		display: flex;
		gap: var(--s-1);
	}
	.day {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--c-line-strong);
		border-radius: 50%;
		font-size: var(--t-sm);
		cursor: pointer;
	}
	.day input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.day.on {
		background: var(--c-text);
		color: var(--c-bg);
		border-color: var(--c-text);
	}
	.day:focus-within {
		box-shadow: var(--focus-ring);
	}
	.preview {
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.err {
		color: var(--c-danger);
	}
	.mono {
		font-family: var(--font-mono);
	}
</style>
