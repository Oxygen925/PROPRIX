<script lang="ts">
	// 확장 화면 'MCP' 탭: 서버 등록(양식·Claude Desktop 설정) · 상태·협상 판 · 신뢰 정책 · 도구별 켜기(정의를 보고 고정) · 로그
	import { app } from '#lib/app.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { errorText, toast, toastError, toastRun } from '#lib/ui/toast.svelte.js';
	import {
		type McpServerInfo,
		type McpServerInput,
		type McpToolInfo,
		mcpUrlError,
		MCP_SERVER_NAME,
		parseClaudeDesktopConfig
	} from '@proprix/shared';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconFileImport from '@tabler/icons-svelte-runes/icons/file-import';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlug from '@tabler/icons-svelte-runes/icons/plug';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';

	const STATUS = { idle: '대기 (필요할 때 연결)', connecting: '연결 중…', connected: '연결됨', error: '오류' } as const;
	const TRUST = {
		ask: '매번 확인 — 모든 호출을 승인 카드로 확인 (도구별 항상 허용만 적용)',
		'readonly-auto': '읽기 도구는 바로 — 서버가 읽기 전용이라고 표시한 도구만 확인 없이 (서버를 믿을 때만)'
	} as const;

	// ---- 서버 양식 (undefined: 닫힘, null: 새로) ----
	let editing = $state<McpServerInfo | null | undefined>(undefined);
	let form = $state({ name: '', transport: 'stdio' as 'stdio' | 'http', command: '', args: '', env: '', url: '', headers: '', trust: 'ask' as 'ask' | 'readonly-auto', enabled: true });
	let saving = $state(false);

	function open(s: McpServerInfo | null) {
		editing = s;
		form = {
			name: s?.name ?? '',
			transport: s?.transport ?? 'stdio',
			command: s?.command ?? '',
			args: (s?.args ?? []).join('\n'),
			// 저장된 비밀은 키만 보인다: 값을 비워 두면 그대로
			env: (s?.envKeys ?? []).map((k) => `${k}=`).join('\n'),
			url: s?.url ?? '',
			headers: (s?.headerKeys ?? []).map((k) => `${k}: `).join('\n'),
			trust: s?.trust ?? 'ask',
			enabled: s?.enabled ?? true
		};
	}

	const pairs = (text: string, sep: '=' | ':') =>
		Object.fromEntries(
			text
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
				.map((l) => {
					const at = l.indexOf(sep);
					return at < 0 ? [l, ''] : [l.slice(0, at).trim(), l.slice(at + 1).trim()];
				})
		);

	const input = $derived<McpServerInput>({
		name: form.name.trim(),
		transport: form.transport,
		command: form.command.trim(),
		args: form.args.split('\n').map((a) => a.trim()).filter(Boolean),
		env: pairs(form.env, '='),
		url: form.url.trim(),
		headers: pairs(form.headers, ':'),
		trust: form.trust,
		enabled: form.enabled
	});
	const formError = $derived.by(() => {
		if (!MCP_SERVER_NAME.test(input.name)) return '이름은 영문으로 시작하는 1~20자 (영문·숫자·-·_)';
		if (input.transport === 'stdio' && !input.command) return '실행할 명령이 필요합니다';
		if (input.transport === 'http') return mcpUrlError(input.url ?? '');
		return '';
	});

	async function save() {
		if (formError) return;
		saving = true;
		try {
			const s = await app.saveMcp(editing?.id ?? null, input);
			toast(`${s.name} 을(를) 저장했습니다${s.enabled ? ' — 연결해 도구 목록을 받는 중' : ''}`, 'success');
			editing = undefined;
		} catch (e) {
			toastError(e);
		} finally {
			saving = false;
		}
	}

	// ---- Claude Desktop 설정 가져오기 ----
	let importOpen = $state(false);
	let importText = $state('');
	const parsed = $derived(importText.trim() ? parseClaudeDesktopConfig(importText) : { servers: [], errors: [] });
	async function importAll() {
		let ok = 0;
		for (const s of parsed.servers) {
			try {
				await app.saveMcp(null, s);
				ok++;
			} catch (e) {
				toast(`${s.name}: ${errorText(e)}`, 'error');
			}
		}
		if (ok) toast(`서버 ${ok}개를 등록했습니다. 도구는 꺼진 채로 시작합니다`, 'success');
		importOpen = false;
		importText = '';
	}

	// ---- 도구 켜기: 정의를 보고 고정 ----
	let reviewing = $state<{ server: McpServerInfo; tool: McpToolInfo } | null>(null);
	async function toggle(server: McpServerInfo, tool: McpToolInfo, on: boolean) {
		try {
			await app.toggleMcpTool(server.id, tool.name, on);
			if (on) toast(`${tool.exposed} 를 켰습니다 (이 정의로 고정)`, 'success');
		} catch (e) {
			toastError(e);
		} finally {
			reviewing = null;
		}
	}
	const pretty = (v: unknown) => JSON.stringify(v, null, 2);

	// ---- 그 밖 ----
	let busy = $state('');
	async function refresh(s: McpServerInfo) {
		busy = s.id;
		try {
			await app.refreshMcp(s.id);
			toast(`${s.name}: 연결해 도구 목록을 새로 받았습니다`, 'success');
		} catch (e) {
			toastError(e);
		} finally {
			busy = '';
		}
	}
	let log = $state<{ name: string; lines: string[] } | null>(null);
	let removing = $state<McpServerInfo | null>(null);
	async function confirmRemove() {
		const s = removing;
		removing = null;
		if (s) await toastRun(() => app.deleteMcp(s.id), `${s.name} 을(를) 삭제했습니다`);
	}

	const items = (s: McpServerInfo): MenuItem[] => [
		{ label: '편집', icon: IconPencil, onSelect: () => open(s) },
		{ label: '다시 연결 (도구 새로 받기)', icon: IconRefresh, disabled: !s.enabled, onSelect: () => void refresh(s) },
		{
			label: '로그',
			icon: IconFileText,
			onSelect: async () => {
				try {
					log = { name: s.name, lines: await app.mcpLog(s.id) };
				} catch (e) {
					toastError(e);
				}
			}
		},
		{ label: '삭제', icon: IconTrash, danger: true, onSelect: () => (removing = s) }
	];
</script>

<div class="actions">
	<Button icon={IconFileImport} onclick={() => (importOpen = true)}>Claude Desktop 설정 가져오기</Button>
	<Button variant="primary" icon={IconPlus} onclick={() => open(null)}>서버 추가</Button>
</div>

<p class="hint">
	MCP 서버의 <strong>도구</strong>만 씁니다. 새 도구는 꺼진 채로 나타나며, 켤 때 그 정의를 고정합니다. 서버가 정의를 바꾸면 그 도구를 끄고
	다시 확인을 받습니다. 결과는 바깥에서 온 데이터로 다뤄 그 답의 쓰기를 다시 확인합니다. 서버는 쓸 때 연결하고 10분 쓰지 않으면 끊습니다.
	에이전트 편집기에서 서버를 켜야 그 에이전트가 씁니다.
</p>

{#if app.mcpServers.length === 0}
	<EmptyState icon={IconPlug} title="등록한 MCP 서버가 없어요" body="서버를 추가하거나 Claude Desktop 설정을 가져오세요." />
{/if}

{#each app.mcpServers as s (s.id)}
	<section class="server" aria-label={s.name}>
		<div class="head">
			<span class="dot {s.status}" title={STATUS[s.status]}></span>
			<span class="sname">{s.name}</span>
			<span class="meta"
				>{s.transport === 'stdio' ? 'stdio' : 'HTTP'}{s.protocolVersion ? ` · 프로토콜 ${s.protocolVersion}` : ''}{s.serverInfo
					? ` · ${s.serverInfo.name} ${s.serverInfo.version}`
					: ''}{s.enabled ? '' : ' · 꺼짐'}</span
			>
			<span class="grow"></span>
			<span class="status">{busy === s.id ? '연결 중…' : STATUS[s.status]}</span>
			<Menu items={items(s)}>
				{#snippet trigger({ toggle: t, props })}
					<IconButton icon={IconDots} label="{s.name} 메뉴" size="sm" onclick={t} {...props} />
				{/snippet}
			</Menu>
		</div>
		<p class="sub">
			<code>{s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</code>
			{#if s.envKeys.length}<span> · env {s.envKeys.join(', ')}</span>{/if}
			{#if s.headerKeys.length}<span> · 헤더 {s.headerKeys.join(', ')}</span>{/if}
			<span> · {s.trust === 'ask' ? '매번 확인' : '읽기 도구는 바로'}</span>
		</p>
		{#if s.error}<p class="err">{s.error}</p>{/if}
		{#if s.tools.length === 0}
			<p class="hint">아직 받은 도구가 없습니다. 메뉴의 '다시 연결'로 받아 오세요.</p>
		{:else}
			<ul class="tools">
				{#each s.tools as t (t.name)}
					<li>
						<span class="tinfo">
							<span class="tname"
								>{t.title}
								<code>{t.name}</code>
								{#if t.readOnly}<span class="badge">읽기 전용 표시</span>{/if}
								{#if t.changed}<span class="badge warn"><IconAlertTriangle size="0.75rem" aria-hidden="true" /> 정의 바뀜 — 다시 확인</span>{/if}</span
							>
							<span class="tdesc">{t.description.split('\n')[0]}</span>
						</span>
						{#if t.enabled}
							<Button size="sm" variant="ghost" onclick={() => toggle(s, t, false)}>끄기</Button>
						{:else}
							<Button size="sm" onclick={() => (reviewing = { server: s, tool: t })}>{t.changed ? '다시 확인…' : '켜기…'}</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/each}

<!-- 서버 양식 -->
<Dialog open={editing !== undefined} title={editing ? `${editing.name} 편집` : 'MCP 서버 추가'} width={600} onclose={() => (editing = undefined)}>
	<form
		id="mcp-form"
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="이름" hint="도구 이름 앞부분이 됩니다 (mcp__이름__도구). 만든 뒤에는 바꿀 수 없습니다.">
			<input bind:value={form.name} maxlength="20" disabled={!!editing} autocomplete="off" />
		</Field>
		<Field label="연결 방식">
			<select bind:value={form.transport}>
				<option value="stdio">stdio (이 PC 에서 명령 실행)</option>
				<option value="http">HTTP (원격 서버)</option>
			</select>
		</Field>
		{#if form.transport === 'stdio'}
			<Field label="명령" hint="예: npx, uvx, node. 셸을 거치지 않고 실행합니다.">
				<input bind:value={form.command} spellcheck="false" />
			</Field>
			<Field label="인자 (한 줄에 하나)">
				<textarea class="mono" bind:value={form.args} rows="3" spellcheck="false"></textarea>
			</Field>
			<Field label="환경 변수 (KEY=값, 한 줄에 하나)" hint="암호화해 저장하고 다시 보여 주지 않습니다. 저장된 키의 값을 비워 두면 그대로 둡니다.">
				<textarea class="mono" bind:value={form.env} rows="3" spellcheck="false"></textarea>
			</Field>
		{:else}
			<Field label="주소" hint="https 만 (이 PC 의 localhost 는 http 도). 다른 출처로의 리다이렉트는 따라가지 않습니다.">
				<input bind:value={form.url} spellcheck="false" placeholder="https://…/mcp" />
			</Field>
			<Field label="헤더 (이름: 값, 한 줄에 하나)" hint="토큰 등. 암호화해 저장하고 다시 보여 주지 않습니다. 저장된 이름의 값을 비워 두면 그대로 둡니다.">
				<textarea class="mono" bind:value={form.headers} rows="3" spellcheck="false"></textarea>
			</Field>
		{/if}
		<Field label="신뢰 정책">
			<select bind:value={form.trust}>
				<option value="ask">{TRUST.ask}</option>
				<option value="readonly-auto">{TRUST['readonly-auto']}</option>
			</select>
		</Field>
		<label class="check"><input type="checkbox" bind:checked={form.enabled} /> 서버 켜기</label>
		{#if form.transport === 'stdio'}
			<p class="hint">stdio 서버는 사용자 권한으로 실행되는 프로그램입니다. 믿을 수 있는 서버만 등록하세요.</p>
		{/if}
		{#if formError && form.name}<p class="err">{formError}</p>{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => (editing = undefined)}>취소</Button>
		<Button variant="primary" type="submit" form="mcp-form" disabled={saving || !!formError}>저장</Button>
	{/snippet}
</Dialog>

<!-- Claude Desktop 설정 -->
<Dialog open={importOpen} title="Claude Desktop 설정 가져오기" width={600} onclose={() => (importOpen = false)}>
	<div class="form">
		<Field label="claude_desktop_config.json 내용" hint={'{"mcpServers": {...}} 를 붙여 넣으세요. 도구는 모두 꺼진 채로 등록합니다.'}>
			<textarea class="mono" bind:value={importText} rows="8" spellcheck="false"></textarea>
		</Field>
		{#if parsed.servers.length}
			<ul class="plain">
				{#each parsed.servers as s (s.name)}
					<li><strong>{s.name}</strong> · {s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}</li>
				{/each}
			</ul>
		{/if}
		{#each parsed.errors as e (e)}<p class="err">{e}</p>{/each}
	</div>
	{#snippet footer()}
		<Button onclick={() => (importOpen = false)}>취소</Button>
		<Button variant="primary" disabled={parsed.servers.length === 0} onclick={importAll}>{parsed.servers.length}개 등록</Button>
	{/snippet}
</Dialog>

<!-- 도구 켜기: 고정할 정의 확인 -->
<Dialog open={reviewing !== null} title={reviewing ? `${reviewing.tool.exposed} 켜기` : ''} width={680} onclose={() => (reviewing = null)}>
	{#if reviewing}
		{@const r = reviewing}
		<div class="review">
			<p class="hint">
				아래 정의(설명·입력 형식·표시)를 모델에 그대로 보냅니다. 설명에 이상한 지시가 없는지 확인하세요. 서버가 나중에 이 정의를 바꾸면 이
				도구는 꺼지고 다시 확인을 받습니다.
			</p>
			{#if r.tool.changed && r.tool.pinned}
				<div class="cols">
					<div>
						<h3>이전에 켠 정의</h3>
						<pre>{pretty(r.tool.pinned)}</pre>
					</div>
					<div>
						<h3>지금 정의</h3>
						<pre>{pretty(r.tool.definition)}</pre>
					</div>
				</div>
			{:else}
				<pre>{pretty(r.tool.definition)}</pre>
			{/if}
			{#if r.server.trust === 'readonly-auto' && r.tool.readOnly}
				<p class="hint">이 서버는 '읽기 도구는 바로' 정책이라, 이 도구는 확인 없이 실행됩니다.</p>
			{/if}
		</div>
	{/if}
	{#snippet footer()}
		<Button onclick={() => (reviewing = null)}>취소</Button>
		<Button variant="primary" onclick={() => reviewing && toggle(reviewing.server, reviewing.tool, true)}>이 정의로 켜기</Button>
	{/snippet}
</Dialog>

<Dialog open={log !== null} title={log ? `${log.name} 로그` : ''} width={680} onclose={() => (log = null)}>
	<pre class="log">{log?.lines.length ? log.lines.join('\n') : '(아직 없음)'}</pre>
</Dialog>

<ConfirmDialog open={removing !== null} title="MCP 서버 삭제" onconfirm={confirmRemove} onclose={() => (removing = null)}>
	<p>{removing?.name} 을(를) 삭제할까요? 연결을 끊고, 이 서버를 켠 에이전트에서도 뺍니다. 저장한 env·헤더도 삭제합니다.</p>
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
	.server {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.grow {
		flex: 1;
	}
	.dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--c-text-4);
		flex: none;
	}
	.dot.connected {
		background: var(--c-success);
	}
	.dot.connecting {
		background: var(--c-waiting);
	}
	.dot.error {
		background: var(--c-danger);
	}
	.sname {
		font-weight: var(--w-bold);
		font-family: var(--font-mono);
	}
	.meta,
	.status,
	.sub {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.sub {
		overflow-wrap: anywhere;
	}
	.err {
		font-size: var(--t-sm);
		color: var(--c-danger);
	}
	.tools {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
	}
	.tools li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-1) var(--s-2);
		border-radius: var(--r-2);
	}
	.tools li:hover {
		background: var(--c-hover);
	}
	.tinfo {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.tname {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
	.tname code {
		font-size: var(--t-xs);
		color: var(--c-text-4);
	}
	.tdesc {
		font-size: var(--t-xs);
		color: var(--c-text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		padding: 0 var(--s-1);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-pill);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.badge.warn {
		color: var(--c-waiting);
		border-color: var(--c-waiting);
	}
	.form {
		display: grid;
		gap: var(--s-3);
	}
	.mono,
	pre {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
	pre {
		margin: 0;
		padding: var(--s-2);
		max-height: 45vh;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		border: 1px solid var(--c-line);
		border-radius: var(--r-2);
		background: var(--c-surface-1);
	}
	.review {
		display: grid;
		gap: var(--s-2);
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-2);
	}
	h3 {
		font-size: var(--t-sm);
		color: var(--c-text-2);
		margin-bottom: var(--s-1);
	}
	.plain {
		margin: 0;
		padding-left: var(--s-4);
		font-size: var(--t-sm);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
	.log {
		max-height: 60vh;
	}
</style>
