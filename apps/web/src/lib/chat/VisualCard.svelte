<script lang="ts">
	// 대화 중 시각화 카드 (show_visual): sandbox iframe 으로 그린다. 크게 보기·내려받기·작업 폴더에 저장,
	// 시각화 안의 proprix.send(텍스트)는 확인을 받은 뒤 대화로 보낸다. 바깥 데이터(웹 검색·MCP·명령 출력)가 든
	// 턴에서 만든 것은 눌러야 보인다. 다른 주소로 이동하려 하면 멈춘다
	import { ApiFailure } from '#lib/api.js';
	import { app } from '#lib/app.svelte.js';
	import { saveBlob } from '#lib/download.js';
	import { inApp } from '#lib/native.js';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import type { ToolCall } from '@proprix/shared';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconArrowsMaximize from '@tabler/icons-svelte-runes/icons/arrows-maximize';
	import IconChartDots from '@tabler/icons-svelte-runes/icons/chart-dots';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import { artifactFileName } from './artifact.js';
	import { buildVisualDoc, readTheme, visualMessage } from './visual.js';

	let { call }: { call: ToolCall } = $props();

	const parse = (raw: string): Record<string, unknown> => {
		try {
			const v: unknown = JSON.parse(raw);
			return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};
	const args = $derived(parse(call.args));
	const out = $derived(parse(call.output));
	const title = $derived(typeof args.title === 'string' ? args.title : '시각화');
	const format = $derived<'svg' | 'html'>(args.format === 'svg' ? 'svg' : 'html');
	const content = $derived(typeof args.content === 'string' ? args.content : '');
	const failed = $derived(call.status === 'failed' || typeof out.error === 'string');

	let reveal = $state(false);
	const ready = $derived(call.status === 'done' && out.shown === true);
	const visible = $derived(ready && (out.outside !== true || reveal));
	const doc = $derived(visible ? buildVisualDoc(format, content, readTheme()) : '');

	// ---- iframe ----
	let small = $state<HTMLIFrameElement>();
	let big = $state<HTMLIFrameElement>();
	let height = $state(160);
	let blocked = $state(false);
	let expanded = $state(false);
	let loads = { small: 0, big: 0 };
	// 첫 load 는 문서. 그 뒤 load 는 스스로 다른 주소로 이동한 것 → 멈춘다
	function onLoad(which: 'small' | 'big') {
		loads[which]++;
		if (loads[which] > 1) {
			blocked = true;
			expanded = false;
		}
	}
	// 앱 창: srcdoc 은 앱 CSP 를 물려받아 스크립트가 막히므로 문서를 daemon 에 맡기고 받은 주소로 연다.
	// 브라우저(개발): 앱 CSP 가 없고, 같은 origin 에서는 주소로 열면 sandbox 와 겹쳐 비어 보이므로 srcdoc 그대로
	let frame = $state('');
	let frameFailed = $state(false);
	$effect(() => {
		const d = doc;
		loads = { small: 0, big: 0 };
		frame = '';
		frameFailed = false;
		if (!d || !inApp) return;
		let stale = false;
		app.visualFrame(d).then(
			(url) => {
				if (!stale) frame = url;
			},
			() => {
				if (!stale) frameFailed = true;
			}
		);
		return () => {
			stale = true;
		};
	});

	let pending = $state<string | null>(null); // proprix.send 로 온 글: 확인 뒤 보낸다
	function onMessage(e: MessageEvent) {
		const fromSmall = !!small && e.source === small.contentWindow;
		const fromBig = !!big && e.source === big.contentWindow;
		if (!fromSmall && !fromBig) return;
		const m = visualMessage(e.data);
		if (!m) return;
		if (m.type === 'height') {
			if (fromSmall) height = Math.min(Math.max(Math.ceil(m.h), 40), 1200);
		} else pending = m.text;
	}

	async function send() {
		const text = pending;
		pending = null;
		if (!text) return;
		if (app.streaming) return toast('응답이 끝난 뒤에 보낼 수 있습니다', 'error');
		try {
			await app.send(text);
		} catch (e) {
			toastError(e);
		}
	}

	// ---- 내려받기·저장 ----
	const ext = $derived(format === 'svg' ? 'svg' : 'html');
	const fileContent = $derived(format === 'svg' ? content : buildVisualDoc(format, content, readTheme()));
	const fileName = $derived(artifactFileName(title).replace(/\.md$/, `.${ext}`));
	let overwrite = $state(false);
	async function saveToWorkspace(force = false) {
		try {
			await app.saveFile({ path: fileName, content: fileContent, messageId: call.messageId, overwrite: force });
			overwrite = false;
			toast(`작업 폴더에 ${fileName} 을(를) 저장했습니다. 메시지 아래에서 되돌릴 수 있습니다`, 'success');
		} catch (e) {
			if (!force && e instanceof ApiFailure && e.status === 409) overwrite = true;
			else toastError(e);
		}
	}
	const items = $derived<MenuItem[]>([
		{ label: '크게 보기', icon: IconArrowsMaximize, disabled: !visible || blocked, onSelect: () => (expanded = true) },
		{
			label: `내려받기 (.${ext})`,
			onSelect: () => saveBlob(fileContent, format === 'svg' ? 'image/svg+xml' : 'text/html', fileName)
		},
		...(app.room?.workspace ? [{ label: '작업 폴더에 저장', onSelect: () => void saveToWorkspace() }] : [])
	]);
</script>

<svelte:window onmessage={onMessage} />

<figure class="visual">
	<figcaption>
		<IconChartDots size="0.9rem" stroke={1.75} aria-hidden="true" />
		<span class="title">{title}</span>
		<span class="grow"></span>
		{#if ready}
			<Menu items={items}>
				{#snippet trigger({ toggle, props })}
					<IconButton icon={IconDots} label="시각화 메뉴" size="sm" onclick={toggle} {...props} />
				{/snippet}
			</Menu>
		{/if}
	</figcaption>
	{#if call.status === 'running' || call.status === 'pending'}
		<p class="note">시각화를 그리는 중…</p>
	{:else if failed}
		<p class="note err">그리지 못했습니다: {typeof out.error === 'string' ? out.error : call.reason}</p>
	{:else if blocked}
		<p class="note err"><IconAlertTriangle size="0.9rem" aria-hidden="true" /> 이 시각화가 다른 주소로 이동하려 해서 멈췄습니다.</p>
	{:else if ready && !visible}
		<div class="gate">
			<p>웹 검색·MCP·명령 결과가 들어온 뒤에 만든 시각화입니다. 스크립트가 실행되니 내용을 확인한 뒤 여세요.</p>
			<Button size="sm" onclick={() => (reveal = true)}>보기</Button>
		</div>
	{:else if frameFailed}
		<p class="note err">시각화를 불러오지 못했습니다.</p>
	{:else if visible && (frame || !inApp)}
		<iframe
			bind:this={small}
			title={title}
			sandbox="allow-scripts"
			src={inApp ? frame : undefined}
			srcdoc={inApp ? undefined : doc}
			style:height="{height}px"
			onload={() => onLoad('small')}
		></iframe>
	{/if}
</figure>

<Dialog open={expanded} title={title} width={1100} onclose={() => (expanded = false)}>
	{#if expanded && visible && !blocked && (frame || !inApp)}
		<iframe
			class="big"
			bind:this={big}
			title={title}
			sandbox="allow-scripts"
			src={inApp ? frame : undefined}
			srcdoc={inApp ? undefined : doc}
			onload={() => onLoad('big')}
		></iframe>
	{/if}
</Dialog>

<Dialog open={pending !== null} title="시각화에서 전송" onclose={() => (pending = null)}>
	<p class="hint">시각화가 아래 내용을 메시지로 보내려고 합니다.</p>
	<blockquote>{pending}</blockquote>
	{#snippet footer()}
		<Button onclick={() => (pending = null)}>취소</Button>
		<Button variant="primary" onclick={send}>전송</Button>
	{/snippet}
</Dialog>

<ConfirmDialog open={overwrite} title="덮어쓰기" confirmLabel="덮어쓰기" onconfirm={() => saveToWorkspace(true)} onclose={() => (overwrite = false)}>
	<p>작업 폴더에 '{fileName}' 이(가) 이미 있습니다. 덮어써도 원본은 보관돼 메시지 아래에서 되돌릴 수 있습니다.</p>
</ConfirmDialog>

<style>
	.visual {
		/* 말풍선이 글 폭에 맞춰 좁아지지 않게 (시각화는 넉넉한 폭이 필요하다) */
		width: 40rem;
		max-width: 100%;
		margin: var(--s-2) 0;
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
		overflow: hidden;
		animation: appear var(--dur) var(--ease) both;
	}
	figcaption {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-1) var(--s-2) var(--s-1) var(--s-3);
		border-bottom: 1px solid var(--c-line);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.grow {
		flex: 1;
	}
	iframe {
		display: block;
		width: 100%;
		border: none;
		background: transparent;
	}
	iframe.big {
		height: 70vh;
	}
	.note,
	.gate {
		padding: var(--s-3);
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.note.err {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		color: var(--c-danger);
	}
	.gate {
		display: flex;
		align-items: center;
		gap: var(--s-3);
	}
	.gate p {
		flex: 1;
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	blockquote {
		margin: var(--s-2) 0 0;
		padding: var(--s-2) var(--s-3);
		border-left: 3px solid var(--c-line-strong);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 12rem;
		overflow-y: auto;
	}
</style>
