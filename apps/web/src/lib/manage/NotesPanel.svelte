<script lang="ts">
	// 메모: 왼쪽 목록(검색) + 오른쪽 편집. 에이전트가 도구로 만든 메모도 여기서 본다
	import { app } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Markdown from '#lib/ui/Markdown.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { type Note, NoteInput } from '@proprix/shared';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconButton from '#lib/ui/IconButton.svelte';
	import IconNotes from '@tabler/icons-svelte-runes/icons/notes';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import { onMount } from 'svelte';

	let query = $state('');
	let selectedId = $state<string | null>(null); // null + creating = 새 메모
	let creating = $state(false);
	let form = $state({ title: '', body: '' });
	let mode = $state<'edit' | 'view'>('view');
	let saving = $state(false);
	let removing = $state(false);

	onMount(() => {
		void app.loadNotes();
	});

	const shown = $derived(
		query.trim()
			? app.notes.filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(query.trim().toLowerCase()))
			: app.notes
	);
	const selected = $derived(app.notes.find((n) => n.id === selectedId));
	const dirty = $derived(creating ? !!(form.title || form.body) : !!selected && (form.title !== selected.title || form.body !== selected.body));

	function open(n: Note) {
		selectedId = n.id;
		creating = false;
		form = { title: n.title, body: n.body };
		mode = 'view';
	}

	function startNew() {
		selectedId = null;
		creating = true;
		form = { title: '', body: '' };
		mode = 'edit';
	}

	async function save() {
		const parsed = NoteInput.safeParse(form);
		if (!parsed.success) {
			toast(parsed.error.issues.map((i) => i.message).join(', '), 'error');
			return;
		}
		saving = true;
		try {
			const note = await app.saveNote(creating ? null : selectedId, parsed.data);
			creating = false;
			selectedId = note.id;
			mode = 'view';
			toast('저장했습니다', 'success');
		} catch (e) {
			toastError(e);
		} finally {
			saving = false;
		}
	}

	async function remove() {
		removing = false;
		if (!selected) return;
		try {
			await app.deleteNote(selected.id);
			selectedId = null;
			toast('메모를 삭제했습니다', 'success');
		} catch (e) {
			toastError(e);
		}
	}

	function onKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 's' && mode === 'edit') {
			e.preventDefault();
			void save();
		}
	}

	const when = (t: number) => new Date(t).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="split" class:open={!!(selected || creating)} onkeydown={onKey}>
	<aside class="list">
		<header>
			<span class="grow"></span>
			<Button size="sm" variant="primary" icon={IconPlus} onclick={startNew}>새 메모</Button>
		</header>
		<label class="search">
			<IconSearch size="1rem" aria-hidden="true" />
			<input bind:value={query} placeholder="메모 검색" aria-label="메모 검색" />
		</label>
		<ul>
			{#each shown as n (n.id)}
				<li>
					<button class:on={n.id === selectedId} onclick={() => open(n)}>
						<span class="t">{n.title || '(제목 없음)'}</span>
						<span class="m">
							{#if n.agentId}<Avatar agentId={n.agentId} size={0.9} />{/if}
							{n.agentId ? app.look(n.agentId).name : '직접'} · {when(n.updatedAt)}
						</span>
						{#if n.body}<span class="p">{n.body.slice(0, 80)}</span>{/if}
					</button>
				</li>
			{:else}
				<li class="none">{query ? '찾는 메모가 없어요.' : '메모가 없어요.'}</li>
			{/each}
		</ul>
	</aside>

	<section class="detail">
		{#if selected || creating}
			<header>
				<span class="back">
					<IconButton
						icon={IconArrowLeft}
						label="목록으로"
						size="sm"
						onclick={() => {
							selectedId = null;
							creating = false;
						}}
					/>
				</span>
				{#if mode === 'edit'}
					<input class="title-input" bind:value={form.title} maxlength="200" placeholder="제목" aria-label="제목" />
				{:else}
					<h2>{selected?.title}</h2>
				{/if}
				<span class="grow"></span>
				{#if mode === 'view'}
					<Button size="sm" onclick={() => (mode = 'edit')}>편집</Button>
					<Button size="sm" variant="ghost" icon={IconTrash} onclick={() => (removing = true)}>삭제</Button>
				{:else}
					<Button
						size="sm"
						onclick={() => {
							if (creating) creating = false;
							else if (selected) open(selected);
						}}
					>
						취소
					</Button>
					<Button size="sm" variant="primary" disabled={saving || !dirty || !form.title.trim()} onclick={save} title="저장 (Ctrl+S)">
						저장
					</Button>
				{/if}
			</header>
			{#if selected && mode === 'view'}
				<p class="by">
					{selected.agentId ? `${app.look(selected.agentId).name} 이(가) 만듦` : '직접 만듦'} · {when(selected.updatedAt)}
				</p>
			{/if}
			<div class="body">
				{#if mode === 'edit'}
					<textarea bind:value={form.body} maxlength="20000" placeholder="내용 (마크다운)" aria-label="내용"></textarea>
				{:else if selected?.body}
					<Markdown text={selected.body} />
				{:else}
					<p class="none">내용이 없어요.</p>
				{/if}
			</div>
		{:else}
			<EmptyState icon={IconNotes} title="메모를 고르세요" body={'에이전트에게 "메모해줘"라고 하거나 직접 만들 수 있습니다.'} />
		{/if}
	</section>
</div>

<ConfirmDialog open={removing} title="메모 삭제" onconfirm={remove} onclose={() => (removing = false)}>
	<p>'{selected?.title}' 메모를 삭제할까요?</p>
</ConfirmDialog>

<style>
	.split {
		height: 100%;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		min-height: 0;
		padding: var(--s-4) var(--s-3) 0;
		border-right: 1px solid var(--c-line);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.grow {
		flex: 1;
	}
	.search {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: 0 var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-2);
		background: var(--c-surface-2);
		color: var(--c-text-3);
	}
	.search input {
		flex: 1;
		border: none;
		background: transparent;
		padding-left: 0;
	}
	.search input:focus-visible {
		box-shadow: none;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0 0 var(--s-4);
		overflow-y: auto;
		display: grid;
		align-content: start;
		gap: 0.125rem;
	}
	li button {
		width: 100%;
		display: grid;
		gap: 0.15rem;
		padding: var(--s-2) var(--s-3);
		border: none;
		border-radius: var(--r-2);
		background: none;
		text-align: left;
	}
	li button:hover {
		background: var(--c-hover);
	}
	li button.on {
		background: var(--c-selected);
	}
	.t {
		font-weight: var(--w-bold);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.m {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.p {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.none {
		padding: var(--s-3);
		color: var(--c-text-4);
		font-size: var(--t-sm);
	}
	.detail {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding: var(--s-4) var(--s-5);
		gap: var(--s-2);
	}
	h2 {
		font-size: var(--t-xl);
	}
	.title-input {
		flex: 1;
		font-size: var(--t-lg);
	}
	.by {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		max-width: 46rem;
	}
	.back {
		display: none;
	}
	/* 좁은 창: 목록과 메모를 번갈아 한 칸에 */
	@media (max-width: 1000px) {
		.split {
			grid-template-columns: minmax(0, 1fr);
		}
		.split.open .list,
		.split:not(.open) .detail {
			display: none;
		}
		.back {
			display: inline-flex;
		}
	}
	.body textarea {
		width: 100%;
		height: 100%;
		min-height: 20rem;
		resize: none;
	}
</style>
