<script lang="ts">
	// 메시지 하나: 말풍선(마크다운) · 도구 카드 · 출처 칩 · 참고한 기억 · 가리키면 시각·복사·수정/다시 받기
	import { app, describeFailure } from '#lib/app.svelte.js';
	import ToolCallCard from '#lib/components/ToolCallCard.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Markdown from '#lib/ui/Markdown.svelte';
	import { errorText, toast, toastError } from '#lib/ui/toast.svelte.js';
	import type { Attachment, Message } from '@proprix/shared';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconGitBranch from '@tabler/icons-svelte-runes/icons/git-branch';
	import IconFileExport from '@tabler/icons-svelte-runes/icons/file-export';
	import IconNotes from '@tabler/icons-svelte-runes/icons/notes';
	import { tick } from 'svelte';
	import { canRewind, laterCount } from './rewind.js';
	import { fullTime, timeLabel } from './time.js';

	let { m }: { m: Message } = $props();

	const PROACTIVE = { reminder: '⏰ 리마인더', checkin: '👋 체크인', nudge: '👋 안부', task: '🗓 예약 작업', '': '' } as const;

	// 서브 채팅: 일반 채팅의 끝난 메시지에서만 (라운지·서브 채팅·토론 제외)
	const canBranch = $derived(
		app.room?.kind === 'chat' && !app.room.parentRoomId && !m.debateId && m.status !== 'streaming' && !!m.content.trim()
	);

	// 토론·협업의 맺는 말 (협업이면 최종본): 메모·파일로 저장할 수 있다
	const closing = $derived.by(() => {
		if (!m.debateId || m.role !== 'assistant' || m.status !== 'complete') return false;
		const d = app.debate(m.debateId);
		return !!d && m.debateRound === d.rounds + 1;
	});

	const rewindable = $derived(
		canRewind(app.messages, m, {
			streaming: app.streaming,
			room: app.room,
			coveredUntil: app.summary?.coveredUntil ?? 0
		})
	);
	const calls = $derived(app.toolCalls.filter((c) => c.messageId === m.id && !c.parentId));
	const changes = $derived.by(() => {
		const ids = new Set(app.toolCalls.filter((c) => c.messageId === m.id).map((c) => c.id));
		// 도구 호출의 변경 + 이 메시지를 산출물로 저장한 파일
		return app.fileChanges.filter((c) => (ids.has(c.callId) || c.callId === `artifact:${m.id}`) && !c.restoredAt);
	});
	let reverting = $state(false);
	async function revertAll() {
		reverting = true;
		let done = 0;
		try {
			for (const c of [...changes].sort((a, b) => b.createdAt - a.createdAt)) {
				await app.restoreChange(c.id);
				done++;
			}
			toast(`파일 ${done}개를 되돌렸습니다`, 'success');
		} catch (e) {
			toast(`${done}개를 되돌리고 멈췄습니다: ${errorText(e)} — 남은 것은 하나씩 되돌리세요`, 'error');
		} finally {
			reverting = false;
		}
	}

	// ---- 수정·다시 받기 ----
	let editing = $state(false);
	let editText = $state('');
	let confirmDrop = $state(0); // > 0 이면 확인 창

	async function rewind(edited?: string) {
		try {
			await app.rewind(m.id, edited);
		} catch (e) {
			toastError(e);
		}
	}

	function regenerate() {
		const drop = laterCount(app.messages, m);
		if (drop > 0) confirmDrop = drop;
		else void rewind();
	}

	function saveEdit() {
		const value = editText.trim();
		if (!value) return;
		editing = false;
		void rewind(value);
	}

	function onEditKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			editing = false;
		} else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			saveEdit();
		}
	}

	// 편집 칸이 열리면 글 끝에 커서
	function focusEnd(el: HTMLTextAreaElement) {
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(m.content);
			toast('복사했습니다', 'success');
		} catch {
			toast('복사하지 못했습니다', 'error');
		}
	}

	// ---- 첨부: 누르면 크게 (이미지) · 내용 (텍스트·PDF 에서 뽑은 글자) ----
	let viewing = $state<{ name: string; image?: string; text?: string } | null>(null);

	async function openAttachment(a: Attachment) {
		if (a.kind === 'image') {
			viewing = { name: a.name, image: a.data };
			return;
		}
		try {
			viewing = { name: a.name, text: (await app.attachmentContent(a.id)).data };
		} catch (e) {
			toastError(e);
		}
	}

	const sizeText = (n: number) =>
		n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

	// ---- 참고한 기억 팝오버 (Esc·바깥 클릭으로 닫힘) ----
	let memOpen = $state(false);
	let memBox: HTMLElement | undefined = $state();

	let memUp = $state(false); // 목록 아래에 자리가 없으면 위로 연다

	async function toggleMemories() {
		memOpen = !memOpen;
		if (!memOpen) return;
		memUp = false;
		if (!app.memoriesLoaded) await app.loadMemories();
		await tick();
		const pop = memBox?.querySelector('.popover')?.getBoundingClientRect();
		const list = memBox?.closest('.messages')?.getBoundingClientRect();
		if (pop && list && pop.bottom > list.bottom && pop.height < pop.top - list.top) memUp = true;
	}

	$effect(() => {
		if (!memOpen) return;
		const onDown = (e: PointerEvent) => {
			if (memBox && !memBox.contains(e.target as Node)) memOpen = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') memOpen = false;
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('keydown', onKey);
		};
	});

	const host = (url: string) => {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return url;
		}
	};
</script>

<article
	data-ui="message"
	data-role={m.role}
	id="msg-{m.id}"
	class="msg {m.role}"
	class:failed={m.status === 'failed'}
	class:editing
	class:raised={memOpen}
	style:--agent={m.role === 'assistant' ? app.look(m.agentId).color : undefined}
>
	{#if m.role === 'assistant'}
		<div class="who">
			<span class="name">{app.look(m.agentId).name}</span>
			{#if m.proactive === 'task'}
				<a class="pro" href="/activity?tab=tasks">{PROACTIVE.task}{app.taskMessages[m.id] ? ` · ${app.taskMessages[m.id]?.title}` : ''}</a>
			{:else if m.proactive}<span class="pro">{PROACTIVE[m.proactive]}</span>{/if}
			<time datetime={new Date(m.createdAt).toISOString()} title={fullTime(m.createdAt)}>{timeLabel(m.createdAt)}</time>
		</div>
		{#each calls as call (call.id)}
			<ToolCallCard {call} />
		{/each}
		{#if changes.length > 1}
			<Button size="sm" variant="ghost" disabled={reverting} onclick={revertAll}>이 답의 파일 변경 {changes.length}개 모두 되돌리기</Button>
		{/if}
	{/if}

	{#if editing}
		<div class="edit">
			<textarea
				bind:value={editText}
				rows={Math.min(10, editText.split('\n').length + 1)}
				aria-label="메시지 편집"
				onkeydown={onEditKey}
				{@attach focusEnd}
			></textarea>
			{#if laterCount(app.messages, m) > 0}
				<p class="hint">아래 메시지 {laterCount(app.messages, m)}개가 삭제되고 다시 답합니다.</p>
			{/if}
			<div class="edit-actions">
				<Button size="sm" onclick={() => (editing = false)}>취소</Button>
				<Button size="sm" variant="primary" disabled={!editText.trim()} onclick={saveEdit}>전송</Button>
			</div>
		</div>
	{:else if m.content.trim()}
		<div class="content"><Markdown text={m.content.trim()} /></div>
	{:else if m.status === 'streaming'}
		<div class="typing" aria-label="답하는 중"><span></span><span></span><span></span></div>
	{/if}

	{#if m.attachments.length && !editing}
		<div class="attachments">
			{#each m.attachments as a (a.id)}
				{#if a.kind === 'image'}
					<button class="thumb" onclick={() => openAttachment(a)} aria-label="{a.name} 크게 보기">
						<img src={a.data} alt={a.name} />
					</button>
				{:else}
					<button class="file" onclick={() => openAttachment(a)} title="{a.name} 내용 보기">
						<IconFileText size="1rem" aria-hidden="true" />
						<span class="fname">{a.name}</span>
						<span class="fsize">{sizeText(a.size)}</span>
					</button>
				{/if}
			{/each}
		</div>
	{/if}

	{#if m.sources.length || m.memoryIds.length}
		<div class="chips">
			{#each m.sources as s (s.url)}
				<a class="chip" href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>{host(s.url)}</a>
			{/each}
			{#if m.memoryIds.length}
				<span class="mem-wrap" bind:this={memBox}>
					<button class="chip mem" aria-expanded={memOpen} onclick={toggleMemories}>
						<IconBrain size="0.85rem" stroke={1.75} aria-hidden="true" /> 기억 {m.memoryIds.length}
					</button>
					{#if memOpen}
						<div class="popover" class:up={memUp} role="dialog" aria-label="참고한 기억">
							<p class="pop-title">이 답에서 참고한 기억</p>
							<ul>
								{#each m.memoryIds as id (id)}
									<li>
										{#if app.memory(id)}<a href="/memories?focus={id}">{app.memory(id)?.content}</a>{:else}(삭제된 기억){/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</span>
			{/if}
		</div>
	{/if}

	{#if m.status === 'partial' || m.status === 'failed'}
		<div class="status">{describeFailure(m)}</div>
	{/if}

	{#if !editing && m.status !== 'streaming'}
		<div class="actions">
			{#if m.role === 'user'}
				<time class="at" datetime={new Date(m.createdAt).toISOString()} title={fullTime(m.createdAt)}>{timeLabel(m.createdAt)}</time>
			{/if}
			{#if m.content.trim()}<IconButton icon={IconCopy} label="복사" size="sm" onclick={copy} />{/if}
			{#if canBranch}
				<IconButton
					icon={IconGitBranch}
					label="여기서 서브 채팅 (이 메시지까지 참조)"
					size="sm"
					onclick={() => (app.subchatDraft = { roomId: m.roomId, messageId: m.id })}
				/>
			{/if}
			{#if closing}
				<IconButton
					icon={IconNotes}
					label="메모로 저장"
					size="sm"
					onclick={() => (app.artifactDraft = { messageId: m.id, kind: 'note' })}
				/>
				{#if app.room?.workspace}
					<IconButton
						icon={IconFileExport}
						label="작업 폴더에 파일로 저장"
						size="sm"
						onclick={() => (app.artifactDraft = { messageId: m.id, kind: 'file' })}
					/>
				{/if}
			{/if}
			{#if rewindable}
				{#if m.role === 'user'}
					<IconButton
						icon={IconPencil}
						label="편집"
						size="sm"
						onclick={() => {
							editText = m.content;
							editing = true;
						}}
					/>
				{:else}
					<IconButton icon={IconRefresh} label="다시 받기" size="sm" onclick={regenerate} />
				{/if}
			{/if}
		</div>
	{/if}
</article>

<Dialog open={viewing !== null} title={viewing?.name ?? ''} width={viewing?.image ? 900 : 720} onclose={() => (viewing = null)}>
	{#if viewing?.image}
		<img class="full" src={viewing.image} alt={viewing.name} />
	{:else if viewing}
		<pre class="text">{viewing.text}</pre>
	{/if}
</Dialog>

<Dialog open={confirmDrop > 0} title="답 다시 받기" onclose={() => (confirmDrop = 0)}>
	<p>이 답 아래의 메시지 {confirmDrop}개가 삭제되고, 이 턴부터 다시 답합니다.</p>
	{#snippet footer()}
		<Button onclick={() => (confirmDrop = 0)}>취소</Button>
		<Button
			variant="primary"
			onclick={() => {
				confirmDrop = 0;
				void rewind();
			}}
		>
			다시 받기
		</Button>
	{/snippet}
</Dialog>

<style>
	/* 말풍선은 내용 크기만큼 */
	.msg {
		animation: appear var(--dur) var(--ease) both;
		position: relative;
		align-self: flex-start;
		max-width: min(46rem, 85%);
		padding: var(--s-2) var(--s-3);
		border-radius: var(--r-4);
		background: var(--c-surface-2);
		border: 1px solid var(--c-line);
		overflow-wrap: anywhere;
		line-height: 1.55;
	}
	/* 에이전트 색은 왼쪽 줄과 이름에만 (사용자 결정 2026-10-30) */
	/* 말풍선마다 쌓임 순서가 따로라(등장 애니메이션) 팝오버를 연 말풍선을 위로 올린다 */
	.msg.raised {
		z-index: 30;
	}
	.msg.assistant {
		border-left: 3px solid var(--agent);
		border-radius: 0 var(--r-4) var(--r-4) 0;
	}
	.msg.user {
		align-self: flex-end;
		background: var(--c-surface-3);
		border-color: transparent;
	}
	.msg.failed {
		border-color: var(--c-danger-line);
	}
	/* 검색에서 온 메시지: 잠깐 테두리로 */
	.msg:global(.flash) {
		animation: flash 2.4s var(--ease);
	}
	@keyframes flash {
		0%,
		60% {
			box-shadow: 0 0 0 2px var(--c-waiting);
		}
	}
	.msg.editing {
		width: min(46rem, 85%);
	}
	.who {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-bottom: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.who .name {
		/* 어두운 색도 읽히게 밝은 쪽으로 섞는다 */
		color: color-mix(in srgb, var(--agent) 65%, var(--c-text));
		font-weight: var(--w-bold);
	}
	.who time {
		color: var(--c-text-4);
		font-size: var(--t-xs);
	}
	.pro {
		font-size: var(--t-xs);
		padding: 0 var(--s-1);
		border-radius: var(--r-1);
		border: 1px solid var(--c-line-strong);
	}
	.typing {
		display: flex;
		gap: 0.25rem;
		padding: 0.4rem 0;
	}
	.typing span {
		width: 0.35rem;
		height: 0.35rem;
		border-radius: 50%;
		background: var(--c-text-3);
		animation: blink 1.2s infinite ease-in-out;
	}
	.typing span:nth-child(2) {
		animation-delay: 0.2s;
	}
	.typing span:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.25;
		}
		40% {
			opacity: 1;
		}
	}
	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		margin-top: var(--s-2);
	}
	.thumb {
		padding: 0;
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		overflow: hidden;
		background: none;
		cursor: zoom-in;
	}
	.thumb img {
		display: block;
		max-width: 14rem;
		max-height: 11rem;
		object-fit: cover;
	}
	.file {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		max-width: 18rem;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
		color: var(--c-text-2);
		font-size: var(--t-sm);
	}
	.fname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fsize {
		color: var(--c-text-4);
		font-size: var(--t-xs);
		white-space: nowrap;
	}
	.full {
		display: block;
		max-width: 100%;
		max-height: 70vh;
		margin: 0 auto;
		border-radius: var(--r-2);
	}
	.text {
		margin: 0;
		max-height: 65vh;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: var(--t-sm);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
		margin-top: var(--s-2);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		max-width: 14rem;
		padding: 0.05rem var(--s-2);
		border-radius: var(--r-pill);
		border: 1px solid var(--c-line-strong);
		background: var(--c-surface-1);
		color: var(--c-text-3);
		font-size: var(--t-xs);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-decoration: none;
	}
	.chip:hover {
		color: var(--c-text);
		text-decoration: none;
	}
	.mem-wrap {
		position: relative;
	}
	.popover {
		position: absolute;
		z-index: 20;
		top: calc(100% + var(--s-1));
		left: 0;
		width: min(24rem, 70vw);
		max-height: 16rem;
		overflow-y: auto;
		padding: var(--s-2) var(--s-3);
		border-radius: var(--r-3);
		border: 1px solid var(--c-line-strong);
		background: var(--c-surface-3);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.4);
		font-size: var(--t-sm);
	}
	.popover.up {
		top: auto;
		bottom: calc(100% + var(--s-1));
	}
	.pop-title {
		color: var(--c-text-3);
		font-size: var(--t-xs);
		margin-bottom: var(--s-1);
	}
	.popover ul {
		margin: 0;
		padding-left: 1.1em;
		display: grid;
		gap: var(--s-1);
	}
	.popover a {
		color: inherit;
		text-decoration: none;
	}
	.popover a:hover {
		text-decoration: underline;
	}
	.status {
		margin-top: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	/* 시각·복사·수정 버튼은 말풍선 옆에, 가리킬 때만 (말풍선 높이를 늘리지 않게) */
	.actions {
		position: absolute;
		bottom: 0;
		left: calc(100% + var(--s-1));
		display: flex;
		align-items: center;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease);
	}
	.msg.user .actions {
		left: auto;
		right: calc(100% + var(--s-1));
	}
	.msg:hover .actions,
	.actions:focus-within {
		opacity: 1;
	}
	.at {
		color: var(--c-text-4);
		font-size: var(--t-xs);
		white-space: nowrap;
		margin-right: var(--s-1);
	}
	.edit {
		display: grid;
		gap: var(--s-2);
	}
	.edit textarea {
		width: 100%;
		resize: vertical;
	}
	.edit-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
	}
	.hint {
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
</style>
