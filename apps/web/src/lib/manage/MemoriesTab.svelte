<script lang="ts">
	// '기억·메모' 화면의 기억 탭: 필터 막대(범위·종류·검색·이력) + 행 목록 또는 그래프. 추가·편집은 대화상자.
	// P10e: 출처 대화(메시지)로 이동, 참고한 답변, 여러 개 골라 바꾸기·지우기·병합(원본은 대체됨), 그래프 보기
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import { flashTo } from '#lib/flash.js';
	import { MEMORY_KIND_LABEL } from '#lib/labels.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import MemoryBulkBar from '#lib/manage/MemoryBulkBar.svelte';
	import MemoryDetail from '#lib/manage/MemoryDetail.svelte';
	import MemoryFields from '#lib/manage/MemoryFields.svelte';
	import MemoryGraph from '#lib/manage/MemoryGraph.svelte';
	import MemoryScopeSelect from '#lib/manage/MemoryScopeSelect.svelte';
	import MemoryUses from '#lib/manage/MemoryUses.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { errorText, toast, toastError, toastRun } from '#lib/ui/toast.svelte.js';
	import { type Memory, type MemoryGraph as Graph, MemoryInput, MemoryKind, SHARED_SCOPE } from '@proprix/shared';
	import IconAffiliate from '@tabler/icons-svelte-runes/icons/affiliate';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconList from '@tabler/icons-svelte-runes/icons/list';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import { onMount, tick, untrack } from 'svelte';

	let scope = $state(''); // '' = 전체
	let kinds = $state<string[]>([]); // 비면 전체
	let query = $state('');
	let history = $state(false);
	let view = $state<'list' | 'graph'>('list');
	// undefined: 닫힘, null: 새 기억
	let editing = $state<Memory | null | undefined>(undefined);
	let form = $state({ scope: SHARED_SCOPE, kind: 'fact', content: '', contentEn: '', importance: 3 });
	let error = $state('');
	let removing = $state<Memory | null>(null);

	onMount(() => {
		void app.loadMemories();
	});

	const expired = (m: Memory) => m.validUntil !== null && m.validUntil < Date.now();
	const shown = $derived(
		app.memories.filter(
			(m) =>
				(history || (!m.supersededBy && !expired(m))) &&
				(!scope || m.scope === scope) &&
				(kinds.length === 0 || kinds.includes(m.kind)) &&
				(!query.trim() || `${m.content}\n${m.contentEn}`.toLowerCase().includes(query.trim().toLowerCase()))
		)
	);
	const count = (k: string) => app.memories.filter((m) => m.kind === k && (history || (!m.supersededBy && !expired(m)))).length;

	function toggleKind(k: string) {
		kinds = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
	}

	function edit(m: Memory | null) {
		editing = m;
		form = {
			scope: m?.scope ?? (scope || SHARED_SCOPE),
			kind: m?.kind ?? 'fact',
			content: m?.content ?? '',
			contentEn: m?.contentEn ?? '',
			importance: m?.importance ?? 3
		};
		error = '';
	}

	async function save() {
		const parsed = MemoryInput.safeParse({ ...form, validUntil: editing?.validUntil ?? null });
		if (!parsed.success) {
			error = parsed.error.issues.map((i) => i.message).join(', ');
			return;
		}
		try {
			await app.saveMemory(editing?.id ?? null, parsed.data);
			toast(editing ? '기억을 편집했습니다' : '기억을 추가했습니다', 'success');
			editing = undefined;
		} catch (e) {
			error = errorText(e);
		}
	}

	async function remove() {
		const m = removing;
		removing = null;
		if (m) await toastRun(() => app.deleteMemory(m.id), '기억을 삭제했습니다');
	}

	const day = (t: number) => new Date(t).toLocaleDateString('ko-KR');

	// ---- 출처·참고한 답변 ----
	let useCounts = $state<Record<string, number>>({});
	let openUses = $state<string | null>(null);
	// 기억이 바뀔 때마다 (새 답변·추출) 수를 다시 센다
	$effect(() => {
		void app.memories;
		untrack(() => {
			app
				.memoryUseCounts()
				.then((c) => (useCounts = c))
				.catch(() => {});
		});
	});

	// 출처: 방이 남아 있으면 그 메시지로 (P10e 전 기억은 대화로만)
	function source(m: Memory): { href: string; label: string } | null {
		if (!m.sourceRoomId) return null;
		const room = app.rooms.find((r) => r.id === m.sourceRoomId);
		if (!room) return { href: '', label: '삭제한 채팅' };
		return { href: `/rooms/${room.id}${m.sourceMessageId ? `?m=${m.sourceMessageId}` : ''}`, label: room.title };
	}

	// 다른 화면에서 ?focus=기억id 로 오면 그 행으로 가서 잠깐 강조 (대체·만료된 것이면 이력도 켠다)
	let focused = '';
	$effect(() => {
		const id = page.url.searchParams.get('focus');
		const m = id ? app.memories.find((x) => x.id === id) : undefined;
		if (!id || !m || focused === id) return;
		focused = id;
		untrack(() => {
			view = 'list';
			if (m.supersededBy || expired(m)) history = true;
			scope = '';
			kinds = [];
			query = '';
			void tick().then(() => {
				const el = document.getElementById(`mem-${id}`);
				if (el) flashTo(el);
			});
		});
	});

	// ---- 여러 개 골라 바꾸기·지우기·병합 ----
	let picked = $state<string[]>([]);
	const pickedMemories = $derived(picked.flatMap((id) => app.memory(id) ?? []));
	const allPicked = $derived(shown.length > 0 && shown.every((m) => picked.includes(m.id)));
	const togglePick = (id: string, on: boolean) => (picked = on ? [...picked, id] : picked.filter((x) => x !== id));
	const togglePickAll = (on: boolean) =>
		(picked = on ? [...new Set([...picked, ...shown.map((m) => m.id)])] : picked.filter((id) => !shown.some((m) => m.id === id)));
	let removingMany = $state(false);
	let busy = $state(false);

	async function bulkSet(set: { scope?: string; kind?: Memory['kind']; importance?: number }) {
		busy = true;
		try {
			const n = await app.bulkMemories({ ids: pickedMemories.map((m) => m.id), set });
			toast(`기억 ${n}개를 바꿨습니다`, 'success');
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	async function removeMany() {
		removingMany = false;
		busy = true;
		try {
			const n = await app.bulkMemories({ ids: pickedMemories.map((m) => m.id), delete: true });
			picked = [];
			toast(`기억 ${n}개를 삭제했습니다`, 'success');
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	// 병합: 원본을 이어 붙인 초안을 고쳐 새 기억으로, 원본은 대체됨 (이력)
	let merging = $state(false);
	let mergeForm = $state({ scope: SHARED_SCOPE, kind: 'fact', content: '', importance: 3 });
	let mergeError = $state('');
	function openMerge() {
		const ms = pickedMemories;
		const first = ms[0];
		if (!first) return;
		mergeForm = {
			scope: ms.every((m) => m.scope === first.scope) ? first.scope : SHARED_SCOPE,
			kind: first.kind,
			content: ms.map((m) => m.content).join(' ').slice(0, 500),
			importance: Math.max(...ms.map((m) => m.importance))
		};
		mergeError = '';
		merging = true;
	}
	async function merge() {
		const parsed = MemoryInput.safeParse({ ...mergeForm, contentEn: '', validUntil: null });
		if (!parsed.success) {
			mergeError = parsed.error.issues.map((i) => i.message).join(', ');
			return;
		}
		busy = true;
		try {
			const m = await app.mergeMemories(
				pickedMemories.map((x) => x.id),
				parsed.data
			);
			merging = false;
			picked = [m.id];
			toast('합쳤습니다. 원본은 대체됨으로 남습니다', 'success');
		} catch (e) {
			mergeError = errorText(e);
		} finally {
			busy = false;
		}
	}

	// ---- 그래프 ----
	let graph = $state<Graph | null>(null);
	let graphPick = $state<string | null>(null);
	$effect(() => {
		if (view !== 'graph') return;
		void app.memories;
		untrack(() => {
			app
				.memoryGraph()
				.then((g) => (graph = g))
				.catch((e) => toastError(e));
		});
	});
	const graphMemory = $derived(graphPick ? app.memory(graphPick) : undefined);
</script>

<div class="page">
	<header>
		<span class="grow"></span>
		<div class="views" role="radiogroup" aria-label="보기">
			<IconButton icon={IconList} label="목록" active={view === 'list'} onclick={() => (view = 'list')} />
			<IconButton icon={IconAffiliate} label="그래프" active={view === 'graph'} onclick={() => (view = 'graph')} />
		</div>
		<Button variant="primary" icon={IconPlus} onclick={() => edit(null)}>추가</Button>
	</header>
	<p class="hint">
		채팅이 잠시 멈추면 기억할 만한 내용을 자동으로 저장합니다. 공용 기억은 모든 에이전트가, 전용 기억은 그 에이전트만 씁니다.
		영어본은 요청에 넣는 형태이며, 원문을 편집하면 다시 만들어집니다.
	</p>

	<div class="filters">
		<label class="search">
			<IconSearch size="1rem" aria-hidden="true" />
			<input bind:value={query} placeholder="기억 검색" aria-label="기억 검색" />
		</label>
		<MemoryScopeSelect value={scope} label="범위" placeholder="모든 범위" onpick={(s) => (scope = s)} />
		<label class="check"><input type="checkbox" bind:checked={history} /> 대체·만료 포함</label>
	</div>
	<div class="chips" role="group" aria-label="종류">
		{#each MemoryKind.options as k (k)}
			<button class="chip" class:on={kinds.includes(k)} aria-pressed={kinds.includes(k)} onclick={() => toggleKind(k)}>
				{MEMORY_KIND_LABEL[k]} <span class="n">{count(k)}</span>
			</button>
		{/each}
	</div>

	{#if view === 'list' && pickedMemories.length}
		<MemoryBulkBar
			count={pickedMemories.length}
			{busy}
			onset={(set) => void bulkSet(set)}
			onmerge={openMerge}
			onremove={() => (removingMany = true)}
			onclear={() => (picked = [])}
		/>
	{/if}

	{#if shown.length === 0}
		<EmptyState
			icon={IconBrain}
			title={app.memories.length ? '조건에 맞는 기억이 없어요' : '아직 기억이 없어요'}
			body={app.memories.length ? '필터를 바꿔 보세요.' : '채팅하면서 쌓이거나, "기억해줘"라고 부탁하면 저장됩니다.'}
		/>
	{:else if view === 'graph'}
		{#if graph}
			<p class="hint">
				실선은 내용이 비슷한 기억({graph.similarity === 'embedding' ? '로컬 임베딩' : '키워드 검색 — 설정에서 로컬 임베딩을 켜면 더 정확'}), 점선은 같은
				답변에 함께 참고된 기억입니다. 휠로 확대, 끌어서 이동합니다.
			</p>
			<MemoryGraph memories={shown} edges={graph.edges} selected={graphPick} onselect={(id) => (graphPick = id)} />
		{:else}
			<p class="hint">그래프를 만드는 중…</p>
		{/if}
		{#if graphMemory}
			<MemoryDetail
				memory={graphMemory}
				source={source(graphMemory)}
				uses={useCounts[graphMemory.id] ?? 0}
				onedit={() => edit(graphMemory ?? null)}
			/>
		{/if}
	{:else}
		<label class="check all"><input type="checkbox" checked={allPicked} onchange={(e) => togglePickAll(e.currentTarget.checked)} /> 보이는 기억 모두 고르기</label>
		<ul class="rows">
			{#each shown as m (m.id)}
				{@const src = source(m)}
				{@const uses = useCounts[m.id] ?? 0}
				<li id="mem-{m.id}" class:old={m.supersededBy || expired(m)} class:picked={picked.includes(m.id)}>
					<input
						class="pick"
						type="checkbox"
						aria-label="고르기"
						checked={picked.includes(m.id)}
						onchange={(e) => togglePick(m.id, e.currentTarget.checked)}
					/>
					{#if m.scope === SHARED_SCOPE}
						<span class="scope shared" title="공용">공용</span>
					{:else}
						<span class="scope" title={app.scopeLabel(m.scope)}><Avatar agentId={m.scope} size={1.1} /></span>
					{/if}
					<div class="text">
						<div class="content">{m.content}</div>
						<div class="meta">
							<span>{MEMORY_KIND_LABEL[m.kind]}</span>
							<span title="중요도 {m.importance}">{'●'.repeat(m.importance)}<span class="dim">{'●'.repeat(5 - m.importance)}</span></span>
							{#if m.supersededBy}<span class="warn">대체됨</span>{/if}
							{#if expired(m)}<span class="warn">만료</span>{:else if m.validUntil}<span>~{day(m.validUntil)}</span>{/if}
							<span>{day(m.updatedAt)}</span>
							{#if src}
								{#if src.href}<a class="src" href={src.href} title="이 기억이 나온 채팅으로">출처: {src.label}</a>
								{:else}<span>출처: {src.label}</span>{/if}
							{/if}
							<button class="uses" disabled={uses === 0} aria-expanded={openUses === m.id} onclick={() => (openUses = openUses === m.id ? null : m.id)}>
								참고한 답변 {uses}
							</button>
							<span class="en" title={m.contentEn}>{m.contentEn || '영어본 만드는 중'}</span>
						</div>
						{#if openUses === m.id}
							<div class="uses-list"><MemoryUses memoryId={m.id} /></div>
						{/if}
					</div>
					<div class="row-actions">
						<IconButton icon={IconPencil} label="편집" size="sm" onclick={() => edit(m)} />
						<IconButton icon={IconTrash} label="삭제" size="sm" onclick={() => (removing = m)} />
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<Dialog open={editing !== undefined} title={editing ? '기억 편집' : '기억 추가'} width={520} onclose={() => (editing = undefined)}>
	<form
		id="memory-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="기억 (원문)">
			<textarea bind:value={form.content} rows="3" maxlength="500"></textarea>
		</Field>
		<MemoryFields bind:scope={form.scope} bind:kind={form.kind} bind:importance={form.importance} />
		<Field label="English" hint="비우면 자동으로 만듭니다.">
			<textarea bind:value={form.contentEn} rows="2" maxlength="800"></textarea>
		</Field>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => (editing = undefined)}>취소</Button>
		<Button variant="primary" type="submit" form="memory-form" disabled={!form.content.trim()}>저장</Button>
	{/snippet}
</Dialog>

<Dialog open={merging} title="기억 병합" width={560} onclose={() => (merging = false)}>
	<form
		id="merge-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void merge();
		}}
	>
		<p class="hint">고른 {pickedMemories.length}개를 새 기억 하나로 합칩니다. 원본은 '대체됨'으로 남아 이력에서 볼 수 있습니다.</p>
		<ul class="merge-src">
			{#each pickedMemories as m (m.id)}<li>{m.content}</li>{/each}
		</ul>
		<Field label="합친 기억 (원문)">
			<textarea bind:value={mergeForm.content} rows="3" maxlength="500"></textarea>
		</Field>
		<MemoryFields bind:scope={mergeForm.scope} bind:kind={mergeForm.kind} bind:importance={mergeForm.importance} />
		{#if mergeError}<p class="error" role="alert">{mergeError}</p>{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => (merging = false)}>취소</Button>
		<Button variant="primary" type="submit" form="merge-form" disabled={busy || !mergeForm.content.trim()}>병합</Button>
	{/snippet}
</Dialog>

<ConfirmDialog open={removing !== null} title="기억 삭제" onconfirm={remove} onclose={() => (removing = null)}>
	<p>'{removing?.content}' 을(를) 삭제할까요? 에이전트가 더 이상 참고하지 않습니다.</p>
</ConfirmDialog>

<ConfirmDialog open={removingMany} title="기억 삭제" onconfirm={removeMany} onclose={() => (removingMany = false)}>
	<p>고른 기억 {pickedMemories.length}개를 삭제할까요? 에이전트가 더 이상 참고하지 않으며 되돌릴 수 없습니다.</p>
</ConfirmDialog>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--s-3) var(--s-5) var(--s-6);
		display: grid;
		align-content: start;
		gap: var(--s-3);
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}
	.grow {
		flex: 1;
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-3);
		margin-top: var(--s-2);
	}
	.search {
		flex: 1;
		min-width: 14rem;
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
	.search:focus-within {
		border-color: var(--c-line-stronger);
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}
	.chip {
		padding: 0.15rem var(--s-3);
		border-radius: var(--r-pill);
		border: 1px solid var(--c-line-strong);
		background: transparent;
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.chip.on {
		background: var(--c-surface-3);
		border-color: var(--c-text-3);
		color: var(--c-text);
	}
	.n {
		color: var(--c-text-4);
		font-size: var(--t-xs);
	}
	.rows {
		list-style: none;
		margin: var(--s-2) 0 0;
		padding: 0;
		display: grid;
	}
	.rows li {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
		padding: var(--s-3);
		border-bottom: 1px solid var(--c-line);
	}
	.rows li:hover {
		background: var(--c-hover);
	}
	.rows li.old {
		opacity: 0.55;
	}
	.scope {
		flex: none;
		width: 2.6rem;
		display: grid;
		place-items: center;
		padding-top: 0.15rem;
	}
	.scope.shared {
		font-size: var(--t-xs);
		color: var(--c-text-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-pill);
		padding: 0.05rem 0;
	}
	.text {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 0.2rem;
		overflow-wrap: anywhere;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.dim {
		color: var(--c-line-stronger);
	}
	.warn {
		color: var(--c-waiting);
	}
	.en {
		min-width: 0;
		max-width: 22rem;
		color: var(--c-text-4);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row-actions {
		display: flex;
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease);
	}
	.rows li:hover .row-actions,
	.row-actions:focus-within {
		opacity: 1;
	}
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.form textarea {
		width: 100%;
	}
	.error {
		color: var(--c-danger);
		font-size: var(--t-sm);
	}
	/* ---- P10e ---- */
	.views {
		display: flex;
		gap: 2px;
	}
	.check.all {
		margin-top: var(--s-1);
		color: var(--c-text-3);
	}
	.pick {
		flex: none;
		margin-top: 0.3rem;
	}
	.rows li.picked {
		background: var(--c-selected);
	}
	.rows li:global(.flash) {
		animation: flash 2.4s var(--ease);
	}
	@keyframes flash {
		0%,
		60% {
			box-shadow: inset 0 0 0 2px var(--c-waiting);
		}
	}
	.src {
		color: var(--c-text-3);
		text-decoration: none;
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.src:hover {
		color: var(--c-text);
		text-decoration: underline;
	}
	.uses {
		padding: 0;
		border: none;
		background: none;
		color: var(--c-text-3);
		font-size: var(--t-xs);
		text-decoration: underline dotted;
	}
	.uses:hover:not(:disabled) {
		color: var(--c-text);
	}
	.uses:disabled {
		text-decoration: none;
		color: var(--c-text-4);
	}
	.uses-list {
		margin-top: var(--s-1);
		padding: var(--s-1);
		border-radius: var(--r-2);
		background: var(--c-surface-2);
	}
	.merge-src {
		margin: 0;
		padding-left: 1.1em;
		display: grid;
		gap: var(--s-1);
		max-height: 8rem;
		overflow-y: auto;
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
</style>
