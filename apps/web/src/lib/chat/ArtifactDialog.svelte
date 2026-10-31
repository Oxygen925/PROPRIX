<script lang="ts">
	// 토론·협업 맺는 말을 산출물로 저장 (P10a): 메모 또는 작업 폴더 파일. 파일은 원본을 보관해 그 메시지 아래에서 되돌릴 수 있다
	import { ApiFailure } from '#lib/api.js';
	import { app } from '#lib/app.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { untrack } from 'svelte';
	import { artifactBody, artifactFileName, NOTE_BODY_MAX } from './artifact.js';

	const draft = $derived(app.artifactDraft);
	const msg = $derived(draft ? app.messages.find((m) => m.id === draft.messageId) : undefined);
	const debate = $derived(msg?.debateId ? app.debate(msg.debateId) : undefined);
	const body = $derived(msg && debate ? artifactBody(debate, msg, (id) => app.look(id).name) : '');
	const isFile = $derived(draft?.kind === 'file');

	let title = $state('');
	let path = $state('');
	let overwrite = $state(false); // 같은 이름의 파일이 있다고 알린 뒤 '덮어쓰기'
	let busy = $state(false);

	// 열릴 때마다 토론 주제로 채운다
	$effect(() => {
		const d = debate;
		untrack(() => {
			title = d ? `${d.mode === 'debate' ? '토론' : '협업'}: ${d.topic}`.slice(0, 200) : '';
			path = d ? artifactFileName(d.topic) : '';
			overwrite = false;
		});
	});

	const close = () => (app.artifactDraft = null);
	const valid = $derived(!!msg && (isFile ? path.trim() !== '' : title.trim() !== ''));

	async function save() {
		if (!msg || !valid) return;
		busy = true;
		try {
			if (isFile) {
				await app.saveFile({ path: path.trim(), content: body, messageId: msg.id, overwrite });
				toast('파일로 저장했습니다. 메시지 아래에서 되돌릴 수 있습니다', 'success');
			} else {
				await app.saveNote(null, { title: title.trim(), body: body.slice(0, NOTE_BODY_MAX) });
				toast('메모로 저장했습니다', 'success');
			}
			close();
		} catch (e) {
			if (isFile && e instanceof ApiFailure && e.status === 409) overwrite = true;
			else toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog open={draft !== null} title={isFile ? '작업 폴더에 파일로 저장' : '메모로 저장'} width={560} onclose={close}>
	<form
		id="artifact-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if isFile}
			<Field label="파일 경로" hint="작업 폴더 안의 상대 경로">
				<input bind:value={path} maxlength="500" oninput={() => (overwrite = false)} />
			</Field>
			{#if overwrite}
				<p class="warn">같은 이름의 파일이 있습니다. 덮어써도 원본은 보관돼 메시지 아래에서 되돌릴 수 있습니다.</p>
			{/if}
		{:else}
			<Field label="제목">
				<input bind:value={title} maxlength="200" />
			</Field>
			{#if body.length > NOTE_BODY_MAX}
				<p class="warn">메모는 {NOTE_BODY_MAX.toLocaleString()}자까지라 뒷부분이 잘립니다. 전체를 남기려면 파일로 저장하세요.</p>
			{/if}
		{/if}
		<pre class="preview">{body}</pre>
	</form>
	{#snippet footer()}
		<Button onclick={close}>취소</Button>
		<Button variant="primary" type="submit" form="artifact-form" disabled={busy || !valid}>
			{overwrite ? '덮어쓰기' : '저장'}
		</Button>
	{/snippet}
</Dialog>

<style>
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.warn {
		font-size: var(--t-sm);
		color: var(--c-danger);
	}
	.preview {
		margin: 0;
		max-height: 16rem;
		overflow: auto;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
		font-family: inherit;
		font-size: var(--t-sm);
		color: var(--c-text-2);
		white-space: pre-wrap;
	}
</style>
