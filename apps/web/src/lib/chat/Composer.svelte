<script lang="ts">
	// 입력창: 첨부 · / 명령 · 그룹방 @ 자동완성 · 모델·추론 강도 칩 · 전송/중지 · 플랜 사용 문구
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import Dialog from '#lib/ui/Dialog.svelte';
	import { type BuiltinCommand, builtinCommand, parseSlash, USAGE_URL } from '@proprix/shared';
	import { expandUser, findCommand, runBuiltin, slashItems } from './slash.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { ACCEPT, prepareAttachment } from '#lib/attach.js';
	import Button from '#lib/ui/Button.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import { errorText, toast, toastError } from '#lib/ui/toast.svelte.js';
	import { type AttachmentInput, MAX_ATTACHMENTS } from '@proprix/shared';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconPaperclip from '@tabler/icons-svelte-runes/icons/paperclip';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import ModelPicker from './ModelPicker.svelte';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconPlayerStop from '@tabler/icons-svelte-runes/icons/player-stop';

	let text = $state('');
	let error = $state('');
	let input: HTMLTextAreaElement | undefined = $state();

	const group = $derived(app.roomAgents.length > 1);
	const lounge = $derived(app.room?.kind === 'lounge');
	const signedIn = $derived(!!app.account?.planUsage);
	// ---- 첨부 ----
	let files = $state<{ key: string; input: AttachmentInput }[]>([]);
	let preparing = $state(0);
	let dragging = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();

	async function addFiles(list: Iterable<File>) {
		for (const file of list) {
			if (files.length + preparing >= MAX_ATTACHMENTS) {
				toast(`첨부는 메시지당 ${MAX_ATTACHMENTS}개까지입니다`, 'error');
				break;
			}
			preparing++;
			try {
				files = [...files, { key: crypto.randomUUID(), input: await prepareAttachment(file) }];
			} catch (e) {
				toastError(e);
			} finally {
				preparing--;
			}
		}
	}

	function onPaste(e: ClipboardEvent) {
		const pasted = [...(e.clipboardData?.files ?? [])];
		if (pasted.length === 0) return; // 글 붙여넣기는 그대로
		e.preventDefault();
		void addFiles(pasted);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (signedIn) void addFiles([...(e.dataTransfer?.files ?? [])]);
	}

	const canSend = $derived(
		(text.trim() !== '' || files.length > 0) &&
			preparing === 0 &&
			!app.streaming &&
			!!app.model &&
			signedIn &&
			!app.llm.paused
	);

	// ---- 자동완성: 맨 앞 "/이름" (명령) · 그룹방 "@이름" (참여자). 한 상태로 같은 키 처리를 쓴다 ----
	type Suggestion = { id: string; label: string; hint: string; agentId?: string; value: string };
	let trigger = $state<{ kind: '/' | '@' | 'team'; start: number; query: string } | null>(null);
	let active = $state(0);
	let list: HTMLUListElement | undefined = $state();
	const suggestions = $derived.by((): Suggestion[] => {
		if (!trigger) return [];
		if (trigger.kind === 'team') {
			const q = trigger.query.trim().toLowerCase();
			return app.teams
				.filter((t) => t.name.toLowerCase().includes(q))
				.map((t) => ({
					id: t.id,
					label: t.name,
					hint: t.agentIds.map((id) => app.agent(id)?.name ?? '?').join(', '),
					value: t.name
				}));
		}
		if (trigger.kind === '/')
			return slashItems(trigger.query, lounge).map((i) => ({
				id: `/${i.name}`,
				label: `/${i.name}`,
				hint: [i.usage, i.description].filter(Boolean).join(' · '),
				value: i.name
			}));
		const q = trigger.query.toLowerCase();
		return app.roomAgents
			.filter((a) => a.name.toLowerCase().includes(q))
			.sort((x, y) => Number(!x.name.toLowerCase().startsWith(q)) - Number(!y.name.toLowerCase().startsWith(q)))
			.map((a) => ({ id: a.id, label: a.name, hint: '', agentId: a.id, value: a.name }));
	});

	function updateTrigger() {
		if (!input) return (trigger = null);
		const before = text.slice(0, input.selectionStart ?? text.length);
		const slash = /^\/([^\s/]*)$/.exec(before);
		const team = /^\/team\s+([^\n]*)$/i.exec(before);
		const at = group ? /(^|\s)@([^\s@]*)$/.exec(before) : null;
		trigger = slash
			? { kind: '/', start: 0, query: slash[1] ?? '' }
			: team
				? { kind: 'team', start: 0, query: team[1] ?? '' }
				: at
				? { kind: '@', start: before.length - (at[2]?.length ?? 0) - 1, query: at[2] ?? '' }
				: null;
		active = 0;
	}

	// 고르면 이름만 채운다 (명령은 Enter 를 한 번 더 눌러 실행 — 사용자 결정 2026-10-29)
	function pick(s: Suggestion) {
		if (!trigger || !input) return;
		const caret = input.selectionStart ?? text.length;
		const after = text.slice(caret);
		// 팀 이름은 줄 전체를 "/team 이름" 으로 (공백이 든 이름도 그대로)
		const insert = trigger.kind === 'team' ? `/team ${s.value}` : `${trigger.kind}${s.value} `;
		text =
			text.slice(0, trigger.start) +
			insert +
			(trigger.kind === '@' ? after : trigger.kind === '/' ? after.replace(/^\S*\s*/, '') : '');
		const pos = trigger.start + insert.length;
		trigger = null;
		queueMicrotask(() => {
			input?.focus();
			input?.setSelectionRange(pos, pos);
		});
	}

	$effect(() => {
		void active;
		list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
	});

	// ---- 보내기: / 명령이면 실행하거나 펼친다. 없는 명령은 글 그대로 (사용자 결정 2026-10-29) ----
	let picker: { show: () => void } | undefined = $state();
	let helpOpen = $state(false);
	let running = $state(false);

	async function submit() {
		error = '';
		const value = text.trim();
		const slash = parseSlash(value);
		if (slash) {
			const b = builtinCommand(slash.name);
			if (b) return runSlash(b, slash.rest);
			const c = findCommand(slash.name);
			if (c) {
				const r = expandUser(c, slash.rest);
				if ('error' in r) error = r.error;
				else await send(r.text);
				return;
			}
		}
		await send(value);
	}

	async function send(value: string) {
		if (!canSend) return;
		const before = text;
		const sent = files;
		text = '';
		files = [];
		trigger = null;
		try {
			await app.send(value, sent.map((f) => f.input));
		} catch (e) {
			text = before;
			files = sent;
			error = errorText(e);
		}
	}

	// 내장 명령은 전송 조건(응답 중·모델)과 관계없이 실행한다. 실패하면 입력은 그대로 둔다
	async function runSlash(b: BuiltinCommand, rest: string) {
		if (running) return;
		running = true;
		try {
			const r = await runBuiltin(b, rest);
			if ('error' in r) {
				error = r.error;
				return;
			}
			text = '';
			trigger = null;
			if ('open' in r) {
				if (r.open === 'model') picker?.show();
				else helpOpen = true;
			} else if (r.done) toast(r.done, 'success');
		} catch (e) {
			error = errorText(e);
		} finally {
			running = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		// 한글 조합 중에는 자동완성·전송 키를 가로채지 않는다
		if (e.isComposing) return;
		if (suggestions.length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const n = suggestions.length;
				active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				const s = suggestions[active];
				if (s) pick(s);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				trigger = null;
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void submit();
		}
	}

	const placeholder = $derived(
		!signedIn
			? '먼저 ChatGPT 로 로그인하세요'
			: group
				? '@이름으로 부르거나 그냥 전송 · / 명령어 (Enter 전송, Shift+Enter 줄바꿈)'
				: '메시지 입력 · / 명령어 (Enter 전송, Shift+Enter 줄바꿈)'
	);
</script>

<form
	data-ui="composer"
	class="composer"
	onsubmit={(e) => {
		e.preventDefault();
		void submit();
	}}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="box"
		class:dragging
		ondragover={(e) => {
			if (!e.dataTransfer?.types.includes('Files')) return;
			e.preventDefault();
			dragging = true;
		}}
		ondragleave={(e) => {
			if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false;
		}}
		ondrop={onDrop}
	>
		{#if files.length || preparing}
			<ul class="files" aria-label="첨부">
				{#each files as f (f.key)}
					<li class:image={f.input.kind === 'image'}>
						{#if f.input.kind === 'image'}
							<img src={f.input.data} alt={f.input.name} />
						{:else}
							<IconFileText size="1rem" aria-hidden="true" />
							<span class="fname" title={f.input.name}>{f.input.name}</span>
						{/if}
						<button
							type="button"
							class="remove"
							aria-label="{f.input.name} 빼기"
							onclick={() => (files = files.filter((x) => x.key !== f.key))}
						>
							<IconX size="0.75rem" aria-hidden="true" />
						</button>
					</li>
				{/each}
				{#if preparing}<li class="busy">준비 중…</li>{/if}
			</ul>
		{/if}
		{#if suggestions.length > 0}
			<ul
				class="mentions"
				class:slash={trigger?.kind !== '@'}
				role="listbox"
				aria-label={trigger?.kind === '/' ? '명령어' : trigger?.kind === 'team' ? '팀' : '부를 에이전트'}
				bind:this={list}
			>
				{#each suggestions as s, i (s.id)}
					<li role="option" aria-selected={i === active}>
						<button type="button" class:active={i === active} onmousedown={(e) => e.preventDefault()} onclick={() => pick(s)}>
							{#if s.agentId}<Avatar agentId={s.agentId} size={1.1} />{/if}
							<span class="label">{s.label}</span>
							{#if s.hint}<span class="shint">{s.hint}</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<textarea
			data-gaze-input
			bind:this={input}
			bind:value={text}
			onkeydown={onKey}
			oninput={updateTrigger}
			onclick={updateTrigger}
			onblur={() => (trigger = null)}
			onpaste={onPaste}
			rows="2"
			{placeholder}
			disabled={!signedIn}
			aria-label="메시지"
			aria-autocomplete="list"
		></textarea>
		<div class="bar">
			<IconButton
				icon={IconPaperclip}
				label="파일 첨부 (이미지·텍스트·PDF, 붙여넣기·끌어 놓기도 됨)"
				size="sm"
				disabled={!signedIn || files.length >= MAX_ATTACHMENTS}
				onclick={() => fileInput?.click()}
			/>
			<input
				bind:this={fileInput}
				type="file"
				accept={ACCEPT}
				multiple
				hidden
				onchange={(e) => {
					const list = [...(e.currentTarget.files ?? [])];
					e.currentTarget.value = '';
					void addFiles(list);
				}}
			/>
			{#if group && !lounge}<span class="hint">부르지 않으면 라우터가 답할 에이전트를 고릅니다</span>{/if}
			<span class="grow"></span>
			<ModelPicker bind:this={picker} />
			{#if app.streaming}
				<Button size="sm" icon={IconPlayerStop} onclick={() => app.cancel()}>중지</Button>
			{:else}
				<Button size="sm" variant="primary" icon={IconArrowUp} type="submit" disabled={!canSend}>전송</Button>
			{/if}
		</div>
	</div>
	{#if signedIn}
		<p class="plan">
			Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
		</p>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</form>

<Dialog open={helpOpen} title="/ 명령어" width={520} onclose={() => (helpOpen = false)}>
	<p class="help-hint">입력창 맨 앞에 / 를 쓰면 목록이 뜹니다. 등록되지 않은 /글은 그대로 보냅니다.</p>
	<dl class="help">
		{#each slashItems('', lounge) as i (i.name)}
			<dt>/{i.name}{#if i.usage}&nbsp;<span class="usage">{i.usage}</span>{/if}</dt>
			<dd>{i.description}{#if !i.builtin && !i.skill}<span class="mine"> · 사용자 정의</span>{/if}</dd>
		{/each}
	</dl>
	{#snippet footer()}
		<Button
			onclick={() => {
				helpOpen = false;
				void goto('/extensions');
			}}>명령어 관리</Button
		>
		<Button variant="primary" onclick={() => (helpOpen = false)}>닫기</Button>
	{/snippet}
</Dialog>

<style>
	.composer {
		padding: var(--s-2) var(--s-4) var(--s-3);
		display: grid;
		gap: var(--s-1);
	}
	.box {
		position: relative;
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-4);
		background: var(--c-surface-2);
		transition: border-color var(--dur-fast) var(--ease);
	}
	.box:focus-within {
		border-color: var(--c-line-stronger);
	}
	.box.dragging {
		border-color: var(--c-info);
		border-style: dashed;
	}
	.files {
		list-style: none;
		margin: 0;
		padding: var(--s-2) var(--s-2) 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}
	.files li {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--s-1);
		max-width: 14rem;
		padding: var(--s-1) var(--s-2);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-2);
		background: var(--c-surface-3);
		font-size: var(--t-xs);
		color: var(--c-text-2);
	}
	.files li.image {
		padding: 0;
		overflow: hidden;
	}
	.files img {
		display: block;
		width: 3.5rem;
		height: 3.5rem;
		object-fit: cover;
	}
	.fname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.files .busy {
		color: var(--c-text-3);
	}
	.remove {
		display: grid;
		place-items: center;
		padding: 0.1rem;
		border: none;
		border-radius: 50%;
		background: rgb(0 0 0 / 0.55);
		color: #fff;
	}
	.image .remove {
		position: absolute;
		top: 0.15rem;
		right: 0.15rem;
	}
	textarea {
		display: block;
		width: 100%;
		resize: none;
		border: none;
		background: transparent;
		padding: var(--s-3) var(--s-3) var(--s-1);
		max-height: 40vh;
		field-sizing: content;
		min-height: 3.5rem;
	}
	textarea:focus-visible {
		box-shadow: none;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-1) var(--s-2) var(--s-2) var(--s-3);
	}
	.grow {
		flex: 1;
	}
	.hint {
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.mentions {
		position: absolute;
		left: var(--s-2);
		bottom: calc(100% + var(--s-1));
		z-index: 20;
		min-width: 12rem;
		margin: 0;
		padding: var(--s-1);
		list-style: none;
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-3);
		background: var(--c-surface-3);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.4);
	}
	.mentions button {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		width: 100%;
		padding: var(--s-1) var(--s-2);
		border: none;
		background: none;
		border-radius: var(--r-2);
		text-align: left;
	}
	.mentions button.active,
	.mentions button:hover {
		background: var(--c-hover);
	}
	.mentions.slash {
		right: var(--s-2);
		max-height: 16rem;
		overflow-y: auto;
	}
	.mentions .label {
		white-space: nowrap;
	}
	.slash .label {
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.shint {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.help-hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.help {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--s-1) var(--s-3);
		margin: var(--s-3) 0 0;
		max-height: 50vh;
		overflow-y: auto;
		font-size: var(--t-sm);
	}
	.help dt {
		font-family: var(--font-mono);
		white-space: nowrap;
	}
	.help dd {
		margin: 0;
		color: var(--c-text-2);
	}
	.usage,
	.mine {
		color: var(--c-text-4);
	}
	.plan,
	.error {
		font-size: var(--t-xs);
		color: var(--c-text-4);
		padding-left: var(--s-1);
	}
	.error {
		color: var(--c-danger);
	}
</style>
