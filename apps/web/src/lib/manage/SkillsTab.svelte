<script lang="ts">
	// 확장 화면 'Skill' 탭: 실행기 상태 · 목록 · 가져오기(폴더·zip)·직접 작성 → 미리보기(바뀐 파일·스크립트·실행기) → 설치
	import { app } from '#lib/app.svelte.js';
	import DiffView from '#lib/chat/DiffView.svelte';
	import { inApp, pickFolder } from '#lib/native.js';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Markdown from '#lib/ui/Markdown.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError, toastRun } from '#lib/ui/toast.svelte.js';
	import {
		type RunnerStatus,
		SKILL_LIMITS,
		type SkillDetail,
		type SkillImportRequest,
		type SkillInfo,
		type SkillStage
	} from '@proprix/shared';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconUpload from '@tabler/icons-svelte-runes/icons/upload';
	import { onMount } from 'svelte';

	const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

	// ---- 실행기 ----
	let runners = $state<RunnerStatus[]>([]);
	let checking = $state(false);
	async function loadRunners(refresh = false) {
		checking = true;
		try {
			runners = await app.runners(refresh);
			if (refresh) await app.loadSkills();
		} catch (e) {
			toastError(e);
		} finally {
			checking = false;
		}
	}
	onMount(() => void loadRunners());

	// ---- 가져오기 → 미리보기 ----
	let importOpen = $state(false);
	let folder = $state('');
	let zipInput: HTMLInputElement | undefined = $state();
	let busy = $state(false);
	let review = $state<SkillStage | null>(null);

	async function stage(req: SkillImportRequest) {
		busy = true;
		try {
			review = await app.stageSkill(req);
			importOpen = false;
			editing = undefined;
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	async function browse() {
		const picked = await pickFolder('Skill 폴더 고르기');
		if (picked) folder = picked;
	}

	function readBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const r = new FileReader();
			r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
			r.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
			r.readAsDataURL(file);
		});
	}

	async function onZip(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (file.size > SKILL_LIMITS.totalBytes) return toast('zip 은 20MB 까지입니다', 'error');
		await stage({ kind: 'zip', fileName: file.name, data: await readBase64(file) });
	}

	async function install() {
		const r = review;
		if (!r) return;
		busy = true;
		try {
			const s = await app.commitSkill(r.id);
			toast(`${s.name} 을(를) ${r.existing ? '업데이트' : '설치'}했습니다${r.existing ? '' : ' — 쓸 에이전트의 편집기에서 켜세요'}`, 'success');
			review = null;
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	function cancelReview() {
		if (review) void app.discardSkill(review.id);
		review = null;
	}

	// ---- 직접 작성·편집 (undefined: 닫힘, null: 새로) ----
	let editing = $state<SkillDetail | null | undefined>(undefined);
	let draft = $state({ name: '', description: '', body: '' });
	function openEditor(d: SkillDetail | null) {
		editing = d;
		draft = { name: d?.name ?? '', description: d?.description ?? '', body: d?.body ?? '' };
	}

	// ---- 보기·지우기 ----
	let viewing = $state<SkillDetail | null>(null);
	let removing = $state<SkillInfo | null>(null);
	const detail = async (name: string) => {
		try {
			return await app.skillDetail(name);
		} catch (e) {
			toastError(e);
			return null;
		}
	};

	async function confirmRemove() {
		const s = removing;
		removing = null;
		if (s) await toastRun(() => app.deleteSkill(s.name), `${s.name} 을(를) 삭제했습니다`);
	}

	const items = (s: SkillInfo): MenuItem[] => [
		{ label: '보기', icon: IconEye, onSelect: async () => (viewing = await detail(s.name)) },
		{ label: 'SKILL.md 편집', icon: IconPencil, onSelect: async () => openEditor(await detail(s.name)) },
		{ label: '업데이트 (다시 가져오기)', icon: IconUpload, onSelect: () => (importOpen = true) },
		{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = s) }
	];
	const runnerOf = (id: string) => runners.find((r) => r.id === id);
	const metaOf = (s: SkillInfo) => {
		const missing = s.scripts.filter((x) => !x.ok).length;
		const scripts = s.scripts.length ? `스크립트 ${s.scripts.length}개${missing ? ` (실행기 없음 ${missing})` : ''}` : '';
		return [s.description, `파일 ${s.files}개`, sizeText(s.size), scripts].filter(Boolean).join(' · ');
	};
	const STATUS_LABEL = { added: '새 파일', changed: '바뀜', same: '같음' } as const;
</script>

<div class="actions">
	<Button icon={IconUpload} onclick={() => (importOpen = true)}>가져오기</Button>
	<Button variant="primary" icon={IconPencil} onclick={() => openEditor(null)}>새 skill</Button>
</div>

<p class="hint">
	SKILL.md 가 든 폴더(또는 그 zip)를 가져옵니다. 설치 전에 파일·스크립트·실행기를 보여 주고, 업데이트는 바뀐 내용을 확인받습니다.
	설치한 Skill 은 아무 에이전트도 쓰지 않으며, 에이전트 편집기에서 켜거나 입력창에서 <code>/이름</code> 으로 부릅니다. 스크립트는 채팅에서
	명령 실행을 켰을 때만 매번 확인을 거쳐 실행됩니다 (명령 실행과 같은 한계).
</p>

<section class="runners" aria-labelledby="h-runners">
	<div class="row">
		<h2 id="h-runners">스크립트 실행기</h2>
		<span class="grow"></span>
		<IconButton icon={IconRefresh} label="다시 점검" size="sm" disabled={checking} onclick={() => loadRunners(true)} />
	</div>
	<ul>
		{#each runners as r (r.id)}
			<li>
				<span class="dot" class:ok={r.ok}></span>
				<span class="rname">{r.label}</span>
				<span class="exts">.{r.exts.join(' .')}</span>
				{#if r.ok}
					<span class="ver">{r.version}</span>
					<code class="path" title={r.path}>{r.path}</code>
				{:else}
					<span class="err">{r.error}</span>
				{/if}
			</li>
		{/each}
	</ul>
</section>

{#if app.skills.length === 0}
	<EmptyState icon={IconSparkles} title="설치한 Skill 이 없어요" body="SKILL.md 폴더를 가져오거나 직접 만들어 보세요." />
{/if}
<ul class="rows">
	{#each app.skills as s (s.name)}
		<li>
			<button class="main" onclick={async () => (viewing = await detail(s.name))}>
				<span class="text">
					<span class="name"
						>/{s.name}
						{#if s.modified}<span class="warn" title="설치한 뒤 폴더 내용이 바뀌었습니다. 다시 가져와 확인하세요"
								><IconAlertTriangle size="0.8rem" aria-hidden="true" /> 바뀜</span
							>{/if}</span
					>
					<span class="meta">{metaOf(s)}</span>
				</span>
			</button>
			<Menu items={items(s)}>
				{#snippet trigger({ toggle, props })}
					<IconButton icon={IconDots} label="{s.name} 메뉴" size="sm" onclick={toggle} {...props} />
				{/snippet}
			</Menu>
		</li>
	{/each}
</ul>

<!-- 가져오기 -->
<Dialog open={importOpen} title="Skill 가져오기" width={560} onclose={() => (importOpen = false)}>
	<div class="form">
		<Field label="폴더" hint="SKILL.md 가 맨 위에 있는 폴더. 폴더 이름과 SKILL.md 의 name 이 같아야 합니다.">
			<span class="pick">
				<input bind:value={folder} placeholder="예: D:\skills\pdf" spellcheck="false" />
				{#if inApp}<Button icon={IconFolder} onclick={browse}>고르기</Button>{/if}
			</span>
		</Field>
		<Button variant="primary" disabled={busy || !folder.trim()} onclick={() => stage({ kind: 'folder', path: folder.trim() })}
			>폴더 확인</Button
		>
		<div class="or">또는</div>
		<Button icon={IconUpload} disabled={busy} onclick={() => zipInput?.click()}>zip 파일 고르기</Button>
		<input bind:this={zipInput} type="file" accept=".zip" hidden onchange={onZip} />
		<p class="hint">
			파일 {SKILL_LIMITS.files}개·전체 20MB·깊이 {SKILL_LIMITS.depth}단계까지. 실행 파일·라이브러리(exe·dll·bat·cmd 등)와 링크·정션,
			폴더 밖을 가리키는 경로는 받지 않습니다.
		</p>
	</div>
</Dialog>

<!-- 직접 작성 -->
<Dialog
	open={editing !== undefined}
	title={editing ? `${editing.name} SKILL.md 편집` : '새 Skill'}
	width={640}
	onclose={() => (editing = undefined)}
>
	<form
		id="skill-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void stage({ kind: 'manual', ...draft });
		}}
	>
		<Field label="이름" hint="/ 명령어와 같은 규칙 (1~32자, 한글·영문·숫자·-·_)">
			<input bind:value={draft.name} maxlength="32" disabled={!!editing} autocomplete="off" />
		</Field>
		<Field label="설명" hint="에이전트가 언제 이 Skill 을 쓸지 고르는 기준입니다">
			<input bind:value={draft.description} maxlength={SKILL_LIMITS.description} />
		</Field>
		<Field label="본문 (SKILL.md)">
			<textarea class="mono" bind:value={draft.body} rows="12"></textarea>
		</Field>
		{#if editing}<p class="hint">SKILL.md 만 바꾸고 다른 파일은 그대로 둡니다. 저장 전에 바뀐 내용을 보여 줍니다.</p>{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => (editing = undefined)}>취소</Button>
		<Button
			variant="primary"
			type="submit"
			form="skill-form"
			disabled={busy || !draft.name.trim() || !draft.description.trim()}>미리보기</Button
		>
	{/snippet}
</Dialog>

<!-- 미리보기 → 설치 -->
<Dialog open={review !== null} title={review?.existing ? `${review.name} 업데이트` : '설치 미리보기'} width={680} onclose={cancelReview}>
	{#if review}
		<div class="review">
			<p><strong>/{review.name}</strong> — {review.description}</p>
			{#each review.warnings as w (w)}<p class="warn-line"><IconAlertTriangle size="0.9rem" aria-hidden="true" /> {w}</p>{/each}
			{#if review.scripts.length}
				<h3>스크립트</h3>
				<ul class="files">
					{#each review.scripts as sc (sc.path)}
						{@const r = runnerOf(sc.runner)}
						<li>
							<code>{sc.path}</code>
							<span class:bad={!sc.ok}>{sc.ok ? `${r?.label ?? sc.runner} ${r?.version ?? ''} · ${r?.path ?? ''}` : `실행기(${sc.runner}) 없음`}</span>
						</li>
					{/each}
				</ul>
				<p class="hint">스크립트는 채팅에서 명령 실행을 켰을 때만, 실행할 때마다 확인을 거칩니다. 폴더 밖·네트워크에도 영향을 줄 수 있습니다.</p>
			{/if}
			<h3>파일 {review.files.length}개</h3>
			<ul class="files">
				{#each review.files as f (f.path)}
					<li class={f.status}>
						<code>{f.path}</code><span>{sizeText(f.size)}{review.existing ? ` · ${STATUS_LABEL[f.status]}` : ''}</span>
					</li>
				{/each}
				{#each review.removed as p (p)}
					<li class="removed"><code>{p}</code><span>삭제됨</span></li>
				{/each}
			</ul>
			{#if review.skipped.length}<p class="hint">건너뜀(숨김 파일 등): {review.skipped.join(', ')}</p>{/if}
			{#each review.diffs as d (d.path)}
				<h3>{d.path}</h3>
				<DiffView text={d.diff} lines={30} />
			{/each}
		</div>
	{/if}
	{#snippet footer()}
		<Button onclick={cancelReview}>취소</Button>
		<Button variant="primary" disabled={busy} onclick={install}>{review?.existing ? '업데이트' : '설치'}</Button>
	{/snippet}
</Dialog>

<!-- 보기 -->
<Dialog open={viewing !== null} title={viewing ? `/${viewing.name}` : ''} width={680} onclose={() => (viewing = null)}>
	{#if viewing}
		<p class="hint">{viewing.description}</p>
		<div class="body"><Markdown text={viewing.body} /></div>
		<h3>파일</h3>
		<ul class="files">
			{#each viewing.fileList as f (f.path)}
				<li><code>{f.path}</code><span>{sizeText(f.size)}</span></li>
			{/each}
		</ul>
	{/if}
</Dialog>

<ConfirmDialog open={removing !== null} title="Skill 삭제" onconfirm={confirmRemove} onclose={() => (removing = null)}>
	<p>{removing?.name} 을(를) 삭제할까요? 설치 폴더를 삭제하고, 이 Skill 을 켠 에이전트에서도 뺍니다.</p>
</ConfirmDialog>

<style>
	.actions {
		display: flex;
		gap: var(--s-2);
		justify-content: flex-end;
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	h2 {
		font-size: var(--t-md);
	}
	h3 {
		margin-top: var(--s-2);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.grow {
		flex: 1;
	}
	.runners {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
	.runners ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
		font-size: var(--t-sm);
	}
	.runners li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--c-danger);
		flex: none;
	}
	.dot.ok {
		background: var(--c-success);
	}
	.rname {
		font-weight: var(--w-bold);
	}
	.exts,
	.ver {
		color: var(--c-text-3);
	}
	.path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--c-text-4);
		font-size: var(--t-xs);
	}
	.err {
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
	.warn {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		margin-left: var(--s-2);
		font-family: var(--font);
		font-size: var(--t-xs);
		font-weight: var(--w-regular);
		color: var(--c-waiting);
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.pick {
		display: flex;
		gap: var(--s-2);
	}
	.or {
		text-align: center;
		font-size: var(--t-sm);
		color: var(--c-text-4);
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.review {
		display: grid;
		gap: var(--s-2);
		max-height: 65vh;
		overflow-y: auto;
	}
	.warn-line {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-waiting);
	}
	.files {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.1rem;
		font-size: var(--t-sm);
	}
	.files li {
		display: flex;
		justify-content: space-between;
		gap: var(--s-3);
		color: var(--c-text-2);
	}
	.files li span {
		color: var(--c-text-4);
		white-space: nowrap;
	}
	.files .added code {
		color: var(--c-success);
	}
	.files .changed code {
		color: var(--c-waiting);
	}
	.files .removed code {
		color: var(--c-danger);
		text-decoration: line-through;
	}
	.files .bad {
		color: var(--c-danger);
	}
	.body {
		max-height: 40vh;
		overflow-y: auto;
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
</style>
