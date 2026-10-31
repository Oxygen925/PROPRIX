<script lang="ts">
	// 에이전트별 사이트 계정 (P12c): 리서치가 그 사이트를 읽을 때 자동으로 로그인한다.
	// 비밀번호는 보내기만 하고 다시 받지 않는다 (입력칸은 저장하면 비운다)
	import { app } from '#lib/app.svelte.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { errorText, toast, toastError } from '#lib/ui/toast.svelte.js';
	import type { SiteAccount } from '@proprix/shared';

	let { agentId }: { agentId: string } = $props();

	const STATUS: Record<SiteAccount['status'], { label: string; tone: 'neutral' | 'done' | 'danger' | 'waiting' }> = {
		unknown: { label: '아직 확인 안 함', tone: 'neutral' },
		ok: { label: '로그인 됨', tone: 'done' },
		failed: { label: '자동 로그인 멈춤', tone: 'danger' },
		needs_attention: { label: '자동 로그인 불가', tone: 'waiting' }
	};
	const OUTCOME: Record<string, string> = {
		ok: '로그인에 성공했습니다',
		no_form: '로그인 칸을 찾지 못했습니다',
		redirect_host: '등록 도메인 밖이거나 https 가 아닌 곳으로 이어져 입력하지 않았습니다',
		captcha: 'CAPTCHA 가 있어 자동 로그인할 수 없습니다',
		two_factor: '2단계 인증이 있어 자동 로그인할 수 없습니다',
		wrong_credentials: '아이디나 비밀번호가 맞지 않는 것 같습니다',
		no_password: '저장된 비밀번호를 읽지 못했습니다',
		error: '로그인 중 오류가 났습니다'
	};

	let list = $state<SiteAccount[]>([]);
	let editing = $state<SiteAccount | 'new' | null>(null);
	let form = $state({ domain: '', loginUrl: '', username: '', password: '' });
	let error = $state('');
	let busy = $state(false);
	let testing = $state('');

	const load = () =>
		app
			.siteAccounts(agentId)
			.then((l) => (list = l))
			.catch(toastError);

	// 처음과, 로그인 시도로 상태가 바뀌었을 때
	$effect(() => {
		void app.siteAccountChanged;
		void load();
	});

	function open(a: SiteAccount | 'new') {
		editing = a;
		error = '';
		form =
			a === 'new'
				? { domain: '', loginUrl: '', username: '', password: '' }
				: { domain: a.domain, loginUrl: a.loginUrl, username: a.username, password: '' };
	}

	async function save() {
		busy = true;
		error = '';
		try {
			const id = editing === 'new' || !editing ? null : editing.id;
			await app.saveSiteAccount(agentId, id, {
				...form,
				domain: form.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
			});
			form.password = '';
			editing = null;
			await load();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}

	async function test(a: SiteAccount) {
		testing = a.id;
		try {
			const r = await app.testSiteAccount(a.id);
			toast(OUTCOME[r.outcome] ?? r.outcome, r.outcome === 'ok' ? 'success' : 'error');
			await load();
		} catch (e) {
			toastError(e);
		} finally {
			testing = '';
		}
	}

	async function remove(a: SiteAccount) {
		try {
			await app.deleteSiteAccount(a.id);
			await load();
		} catch (e) {
			toastError(e);
		}
	}
</script>

<p class="hint">
	리서치가 이 도메인을 읽을 때 쓰는 계정입니다. 로그인 상태는 이 에이전트에게만 있고, 다른 에이전트·다른 도메인과 섞이지 않습니다.
	비밀번호는 이 PC 에 암호화해 저장하며 모델에게 보내지 않습니다.
</p>
<p class="warn">
	자동 로그인을 금지하는 사이트가 있고, 계정이 제한될 수 있습니다. 회원 전용 내용의 요약은 모델로 전송되고 결과 글에 저장됩니다.
	2단계 인증이나 CAPTCHA 가 있는 사이트는 자동 로그인할 수 없습니다.
</p>

{#if list.length}
	<ul class="rows">
		{#each list as a (a.id)}
			<li>
				<span class="text">
					<strong>{a.domain}</strong>
					<span class="sub">{a.username}{a.lastError ? ` · ${OUTCOME[a.lastError] ?? a.lastError}` : ''}</span>
				</span>
				<Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
				<Button size="sm" disabled={testing === a.id || !app.browser?.installed} onclick={() => test(a)}>
					{testing === a.id ? '시험 중…' : '로그인 시험'}
				</Button>
				<Button size="sm" onclick={() => open(a)}>편집</Button>
				<Button size="sm" onclick={() => remove(a)}>삭제</Button>
			</li>
		{/each}
	</ul>
{/if}

{#if editing}
	<div class="form">
		<label>도메인 <input bind:value={form.domain} placeholder="example.com" spellcheck="false" /></label>
		<label>로그인 주소 <input bind:value={form.loginUrl} placeholder="https://example.com/login" spellcheck="false" /></label>
		<label>아이디 <input bind:value={form.username} autocomplete="off" spellcheck="false" /></label>
		<label>
			비밀번호{editing !== 'new' ? ' (비우면 그대로)' : ''}
			<input type="password" bind:value={form.password} autocomplete="new-password" />
		</label>
		{#if error}<p class="err" role="alert">{error}</p>{/if}
		<div class="actions">
			<Button onclick={() => (editing = null)}>취소</Button>
			<Button variant="primary" disabled={busy} onclick={save}>저장</Button>
		</div>
	</div>
{:else}
	<div><Button size="sm" onclick={() => open('new')}>계정 추가</Button></div>
{/if}

<style>
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.warn {
		padding: var(--s-2) var(--s-3);
		border-radius: var(--r-3);
		background: var(--c-waiting-bg);
		font-size: var(--t-sm);
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-2);
	}
	.rows li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.text {
		flex: 1;
		min-width: 10rem;
		display: grid;
	}
	.sub {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.form {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3);
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
	}
	.form label {
		display: grid;
		gap: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.err {
		font-size: var(--t-sm);
		color: var(--c-danger);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
	}
</style>
