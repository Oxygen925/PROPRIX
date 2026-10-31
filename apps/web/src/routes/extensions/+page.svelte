<script lang="ts">
	// 확장: 사용자 정의 / 명령 (P7b) · Skill (P7c) · MCP (P7d)
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import SkillsTab from '#lib/manage/SkillsTab.svelte';
	import McpTab from '#lib/manage/McpTab.svelte';
	import { usageOf } from '#lib/chat/slash.js';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import Tabs from '#lib/ui/Tabs.svelte';
	import { toast, toastError, toastRun } from '#lib/ui/toast.svelte.js';
	import { BUILTIN_COMMANDS, type Command, commandKey, commandNameError, expandCommand, MESSAGE_MAX } from '@proprix/shared';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconSlash from '@tabler/icons-svelte-runes/icons/slash';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';

	const initial = page.url.searchParams.get('tab');
	let tab = $state<'commands' | 'skills' | 'mcp'>(initial === 'skills' || initial === 'mcp' ? initial : 'commands');

	// ---- 편집 (undefined: 닫힘, null: 새로 만들기) ----
	let editing = $state<Command | null | undefined>(undefined);
	let form = $state({ name: '', description: '', template: '' });
	let sample = $state(''); // 미리보기에 넣어 볼 인자
	let saving = $state(false);
	let removing = $state<Command | null>(null);

	function open(c: Command | null) {
		editing = c;
		form = { name: c?.name ?? '', description: c?.description ?? '', template: c?.template ?? '' };
		sample = '';
	}

	// 이름 검사: 형식·예약어는 공용 규칙, 다른 명령과의 겹침은 목록으로 (skill 과의 겹침은 저장할 때 daemon 이 알려 준다)
	const nameError = $derived.by(() => {
		const name = form.name.trim();
		if (!name) return '';
		const e = commandNameError(name);
		if (e) return e;
		const key = commandKey(name);
		const other = app.commands.find((c) => commandKey(c.name) === key && c.id !== editing?.id);
		return other ? `/${other.name} 이(가) 이미 있습니다` : '';
	});
	const preview = $derived(form.template ? expandCommand(form.template, sample) : null);
	const canSave = $derived(!!form.name.trim() && !nameError && !!form.template && form.template.length <= MESSAGE_MAX && !saving);

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			const c = await app.saveCommand(editing?.id ?? null, {
				name: form.name.trim(),
				description: form.description.trim(),
				template: form.template
			});
			toast(`/${c.name} 을(를) 저장했습니다`, 'success');
			editing = undefined;
		} catch (e) {
			toastError(e);
		} finally {
			saving = false;
		}
	}

	async function confirmRemove() {
		const c = removing;
		removing = null;
		if (c) await toastRun(() => app.deleteCommand(c.id), `/${c.name} 을(를) 삭제했습니다`);
	}

	const items = (c: Command): MenuItem[] => [
		{ label: '편집', icon: IconPencil, onSelect: () => open(c) },
		{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = c) }
	];
</script>

<div class="page">
	<header>
		<h1>확장</h1>
		<span class="grow"></span>
		{#if tab === 'commands'}<Button variant="primary" icon={IconPlus} onclick={() => open(null)}>새 명령어</Button>{/if}
	</header>

	<Tabs
		tabs={[
			{ id: 'commands', label: '명령어', count: app.commands.length },
			{ id: 'skills', label: 'Skill', count: app.skills.length },
			{ id: 'mcp', label: 'MCP', count: app.mcpServers.length }
		]}
		active={tab}
		onselect={(t) => (tab = t)}
	/>

	{#if tab === 'skills'}
		<SkillsTab />
	{:else if tab === 'mcp'}
		<McpTab />
	{:else}
	<p class="hint">
		입력창 맨 앞에 <code>/이름 인자</code> 로 부르면 템플릿을 펼쳐 메시지로 보냅니다. <code>$ARGUMENTS</code> = 이름 뒤 전체,
		<code>$1</code>~<code>$9</code> = 공백으로 나눈 인자(<code>"…"</code> 는 한 덩어리, 있으면 필수), <code>$$</code> = $ 글자. 자리표시가
		없으면 인자를 빈 줄 뒤에 붙입니다.
	</p>

	{#if app.commands.length === 0}
		<EmptyState icon={IconSlash} title="만든 명령어가 없어요" body="자주 쓰는 요청을 / 명령어로 만들어 보세요." />
	{/if}
	<ul class="rows">
		{#each app.commands as c (c.id)}
			<li>
				<button class="main" onclick={() => open(c)}>
					<span class="text">
						<span class="name">/{c.name}&nbsp;<span class="usage">{usageOf(c)}</span></span>
						<span class="meta">{c.description || c.template.split('\n')[0]}</span>
					</span>
				</button>
				<Menu items={items(c)}>
					{#snippet trigger({ toggle, props })}
						<IconButton icon={IconDots} label="/{c.name} 메뉴" size="sm" onclick={toggle} {...props} />
					{/snippet}
				</Menu>
			</li>
		{/each}
	</ul>

	<section class="builtin" aria-labelledby="h-builtin">
		<h2 id="h-builtin">내장 명령어</h2>
		<p class="hint">이 이름들은 예약어라 만들 수 없습니다.</p>
		<dl>
			{#each BUILTIN_COMMANDS as b (b.name)}
				<dt>/{b.name}{#if b.args}&nbsp;<span class="usage">{b.args}</span>{/if}</dt>
				<dd>{b.description}</dd>
			{/each}
		</dl>
	</section>
	{/if}
</div>

<Dialog open={editing !== undefined} title={editing ? `/${editing.name} 편집` : '새 명령어'} width={600} onclose={() => (editing = undefined)}>
	<form
		id="command-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="이름" hint="1~32자, 한글·영문·숫자·-·_ (문자로 시작). 영문 대소문자는 같은 이름으로 봅니다." error={nameError}>
			<span class="slash-input"><span aria-hidden="true">/</span><input bind:value={form.name} maxlength="32" autocomplete="off" /></span>
		</Field>
		<Field label="설명" hint="목록에 보일 한 줄 (선택)">
			<input bind:value={form.description} maxlength="200" />
		</Field>
		<Field label="템플릿" error={form.template.length > MESSAGE_MAX ? `${MESSAGE_MAX.toLocaleString()}자까지` : ''}>
			<textarea class="mono" bind:value={form.template} rows="7" placeholder="예: 다음 파일을 리뷰해 줘: $1&#10;중점: $ARGUMENTS"></textarea>
		</Field>
		{#if preview}
			<div class="preview">
				<Field label="미리보기 인자">
					<input bind:value={sample} placeholder={'예: a.ts "읽기 쉬움"'} />
				</Field>
				<pre class="out">{preview.text}</pre>
				{#if preview.missing.length}
					<p class="warn">비어 있는 필수 인자: {preview.missing.map((n) => `$${n}`).join(', ')} — 이 상태로는 보내지 않습니다</p>
				{/if}
				{#if preview.tooLong}<p class="warn">펼친 내용이 {MESSAGE_MAX.toLocaleString()}자를 넘습니다</p>{/if}
			</div>
		{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => (editing = undefined)}>취소</Button>
		<Button variant="primary" type="submit" form="command-form" disabled={!canSave}>저장</Button>
	{/snippet}
</Dialog>

<ConfirmDialog open={removing !== null} title="명령어 삭제" onconfirm={confirmRemove} onclose={() => (removing = null)}>
	<p>/{removing?.name} 을(를) 삭제할까요?</p>
</ConfirmDialog>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5);
		display: grid;
		align-content: start;
		gap: var(--s-4);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	h1 {
		font-size: var(--t-2xl);
	}
	h2 {
		font-size: var(--t-md);
	}
	.grow {
		flex: 1;
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.125rem;
	}
	.rows li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding-right: var(--s-2);
		border-radius: var(--r-3);
	}
	.rows li:hover {
		background: var(--c-hover);
	}
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		padding: var(--s-2) var(--s-3);
		border: none;
		background: none;
		text-align: left;
	}
	.main:hover {
		background: none !important;
	}
	.text {
		display: grid;
		min-width: 0;
	}
	.name {
		font-family: var(--font-mono);
		font-weight: var(--w-bold);
	}
	.usage {
		font-family: var(--font-mono);
		font-weight: var(--w-regular);
		color: var(--c-text-4);
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.builtin {
		display: grid;
		gap: var(--s-2);
		margin-top: var(--s-4);
	}
	.builtin dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--s-1) var(--s-4);
		margin: 0;
		font-size: var(--t-sm);
	}
	.builtin dt {
		font-family: var(--font-mono);
		white-space: nowrap;
	}
	.builtin dd {
		margin: 0;
		color: var(--c-text-2);
	}
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.slash-input {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		font-family: var(--font-mono);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.preview {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
	}
	.out {
		margin: 0;
		max-height: 12rem;
		overflow: auto;
		white-space: pre-wrap;
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.warn {
		font-size: var(--t-sm);
		color: var(--c-waiting);
	}
</style>
