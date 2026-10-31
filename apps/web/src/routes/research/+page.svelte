<script lang="ts">
	// 리서치 첫 화면: 고른 리서치가 없을 때. 가장 최근 리서치로 보내고, 없으면 만들기 안내
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import ResearchDialog from '#lib/manage/ResearchDialog.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import IconWorldSearch from '@tabler/icons-svelte-runes/icons/world-search';

	let creating = $state(false);

	$effect(() => {
		const first = app.researches[0];
		if (first) void goto(`/research/${first.id}`, { replaceState: true });
	});
</script>

{#if app.researches.length === 0}
	<EmptyState icon={IconWorldSearch} title="리서치가 없어요" body="주제를 주면 에이전트가 검색하고 페이지를 읽어 글을 씁니다.">
		{#snippet action()}<Button variant="primary" onclick={() => (creating = true)}>새 리서치</Button>{/snippet}
	</EmptyState>
{/if}

<ResearchDialog open={creating} onclose={() => (creating = false)} onsaved={(r) => goto(`/research/${r.id}`)} />
