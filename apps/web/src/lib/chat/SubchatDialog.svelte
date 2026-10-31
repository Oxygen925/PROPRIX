<script lang="ts">
	// 서브 채팅 만들기 (P9b): 분기 시점까지의 대화를 복사해 참조하는 새 채팅. 부모에는 쓰지 않고 새 기억도 저장하지 않는다
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import { toastError } from '#lib/ui/toast.svelte.js';
	import { untrack } from 'svelte';

	const draft = $derived(app.subchatDraft);
	const parent = $derived(draft ? app.rooms.find((r) => r.id === draft.roomId) : undefined);
	const fork = $derived(draft?.messageId ? app.messages.find((m) => m.id === draft.messageId) : undefined);

	let title = $state('');
	let agentIds = $state<string[]>([]);
	let busy = $state(false);

	// 열릴 때마다 부모 값으로 채운다
	$effect(() => {
		const p = parent;
		untrack(() => {
			title = p ? `서브: ${p.title}`.slice(0, 100) : '';
			agentIds = p ? [...p.agentIds] : [];
		});
	});

	const toggle = (id: string, on: boolean) => (agentIds = on ? [...agentIds, id] : agentIds.filter((x) => x !== id));
	const close = () => (app.subchatDraft = null);

	async function create() {
		if (!draft || agentIds.length === 0 || !title.trim()) return;
		busy = true;
		try {
			const room = await app.createSubchat(draft.roomId, {
				messageId: draft.messageId,
				agentIds,
				title: title.trim()
			});
			close();
			await goto(`/rooms/${room.id}`);
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog open={draft !== null} title="서브 채팅 만들기" width={520} onclose={close}>
	<form
		id="subchat-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void create();
		}}
	>
		<p class="hint">
			{fork ? '이 메시지까지의' : '지금까지의'} 채팅을 복사해 참고하는 새 채팅을 엽니다. 부모 채팅에는 아무것도 쓰지 않고, 이 채팅에서는 새
			기억을 저장하지 않습니다. 만든 뒤 부모가 바뀌어도 복사한 내용은 그대로입니다.
		</p>
		{#if fork}<blockquote class="fork">{fork.content.slice(0, 160)}{fork.content.length > 160 ? '…' : ''}</blockquote>{/if}
		<Field label="제목">
			<input bind:value={title} maxlength="100" />
		</Field>
		<fieldset class="agents">
			<legend>참여 에이전트</legend>
			{#each app.agents as a (a.id)}
				<label class="check">
					<input type="checkbox" checked={agentIds.includes(a.id)} onchange={(e) => toggle(a.id, e.currentTarget.checked)} />
					<Avatar agentId={a.id} size={1.1} />
					{a.name}
				</label>
			{/each}
		</fieldset>
	</form>
	{#snippet footer()}
		<Button onclick={close}>취소</Button>
		<Button variant="primary" type="submit" form="subchat-form" disabled={busy || agentIds.length === 0 || !title.trim()}>만들기</Button>
	{/snippet}
</Dialog>

<style>
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.fork {
		margin: 0;
		padding: var(--s-2) var(--s-3);
		border-left: 3px solid var(--c-line-strong);
		font-size: var(--t-sm);
		color: var(--c-text-2);
		white-space: pre-wrap;
	}
	.agents {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-1) var(--s-3);
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
	.check {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
</style>
