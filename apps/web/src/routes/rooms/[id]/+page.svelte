<script lang="ts">
	// 대화 방: 주소의 id 로 방을 연다 (사이드바·알림·빠른 전환이 이 경로로 온다)
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import Chat from '#lib/components/Chat.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import IconMessageOff from '@tabler/icons-svelte-runes/icons/message-off';

	const id = $derived(page.params.id ?? '');

	$effect(() => {
		if (id && id !== app.roomId) void app.openRoom(id);
	});
</script>

{#if app.room && app.roomId === id}
	<Chat />
{:else if app.rooms.length > 0 && !app.rooms.some((r) => r.id === id)}
	<EmptyState icon={IconMessageOff} title="채팅을 찾을 수 없어요" body="삭제됐거나 잘못된 주소입니다.">
		{#snippet action()}<Button onclick={() => goto('/')}>오늘로 가기</Button>{/snippet}
	</EmptyState>
{/if}
