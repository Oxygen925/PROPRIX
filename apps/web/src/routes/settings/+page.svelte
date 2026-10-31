<script lang="ts">
	// 설정: 전역 지침 · 일일 예산 · 기억 검색 · 선제 메시지(알림·리마인더) · 자율 대화(라운지)
	// 저장 결과·오류는 토스트로 (긴 화면 어디서 바꿔도 보이게)
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app, type DisplayScale } from '#lib/app.svelte.js';
	import Avatar from '#lib/components/Avatar.svelte';
	import { FEATURE_LABEL, REPEAT_LABEL } from '#lib/labels.js';
	import { autostartEnabled, inApp, restartApp, setAutostart } from '#lib/native.js';
	import ChatGPTButton from '#lib/shell/ChatGPTButton.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ListDetail from '#lib/ui/ListDetail.svelte';
	import ListRow from '#lib/ui/ListRow.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { BEFORE_RESTORE, type BudgetFeature, GLOBAL_INSTRUCTIONS_MAX, type LoungeSettings, USAGE_URL } from '@proprix/shared';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import { onMount, untrack } from 'svelte';

	// 분류 (사용자 결정 2026-10-30: 긴 스크롤 대신 왼쪽에서 고른다). ?s= 로 바로 연다
	const CATEGORIES = [
		{ id: 'account', label: '계정' },
		{ id: 'model', label: '기본 모델' },
		{ id: 'instructions', label: '전역 지침' },
		{ id: 'proactive', label: '알림·선제 메시지' },
		{ id: 'budget', label: '일일 예산' },
		{ id: 'memory', label: '기억 검색' },
		{ id: 'lounge', label: '라운지' },
		{ id: 'research', label: '리서치' },
		{ id: 'backup', label: '백업·복구' },
		{ id: 'display', label: '화면' }
	];
	const cat = $derived(CATEGORIES.find((c) => c.id === page.url.searchParams.get('s'))?.id ?? 'account');
	const pick = (id: string) => goto(`/settings?s=${id}`, { replaceState: true });

	// 테마
	const activeTheme = $derived(app.themes.find((t) => t.id === app.theme));
	let themeInput = $state<HTMLInputElement | undefined>();
	function onThemeFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) void run(() => app.uploadTheme(file), '테마를 적용했습니다');
	}

	let running = $state(false);
	let autostart = $state(false);
	onMount(() => {
		void app.loadLounge();
		void app.loadReminders();
		void app.loadBackups().catch(() => {});
		void app.snapshotUsage().then((u) => (snapshots = u)).catch(() => {});
		void app.loadBrowser().catch(() => {});
		if (inApp) void autostartEnabled().then((v) => (autostart = v));
	});

	async function run(fn: () => Promise<unknown>, ok = '') {
		try {
			await fn();
			if (ok) toast(ok, 'success');
			await app.loadLounge();
		} catch (e) {
			toastError(e);
		}
	}

	// ---- 전역 지침 ----
	let instructions = $state(untrack(() => app.settings.instructions));
	const instructionsDirty = $derived(instructions !== app.settings.instructions);
	const saveInstructions = () => run(() => app.patchSettings({ instructions: instructions.trim() }), '전역 지침을 저장했습니다');

	// ---- 예산 ----
	const features = Object.keys(FEATURE_LABEL) as BudgetFeature[];
	const used = (f: string) => app.usage?.features.find((x) => x.feature === f)?.used ?? 0;
	function setLimit(f: BudgetFeature, raw: string, unlimited: boolean) {
		const n = Number(raw);
		if (!unlimited && (!Number.isInteger(n) || n < 1)) {
			toast('1 이상의 정수를 입력하세요.', 'error');
			return;
		}
		void run(() => app.patchSettings({ budgets: { [f]: unlimited ? null : n } }));
	}

	// ---- 기억 검색 ----
	const embeddingOptions = [
		{ id: 'off', label: '끔 (키워드 검색만)' },
		{ id: 'embeddinggemma', label: 'EmbeddingGemma 300M — 약 197MB, 정확도 높음 (권장)' },
		{ id: 'e5-small', label: 'multilingual-e5-small — 약 118MB, 빠름' }
	] as const;
	const embeddingState = $derived.by(() => {
		const e = app.embedding;
		if (!e || e.state === 'off') return '';
		if (e.state === 'loading') return '모델을 불러오는 중… (처음이면 내려받기 때문에 몇 분 걸릴 수 있음)';
		if (e.state === 'failed') return `불러오지 못해 키워드 검색만 씁니다: ${e.error}`;
		return `사용 중 · 색인 ${e.indexed} / ${e.total}`;
	});

	// ---- 선제 메시지 ----
	const proactive = $derived(app.settings.proactive);
	let permission = $state(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
	async function askPermission() {
		permission = await app.requestNotifications();
	}
	async function testNotification() {
		if (await app.testNotification())
			toast(inApp ? '시험 알림을 보냈습니다.' : '시험 알림을 보냈습니다. 안 보이면 Windows 알림·방해 금지(집중) 설정을 확인하세요.', 'success');
		else toast('시험 알림을 보내지 못했습니다. 알림 권한을 확인하세요.', 'error');
	}
	async function toggleAutostart(on: boolean) {
		await run(async () => {
			await setAutostart(on);
			autostart = await autostartEnabled();
		});
	}
	const hours = Array.from({ length: 24 }, (_, i) => i);
	const fmt = (t: number) => new Date(t).toLocaleString();

	// ---- 백업 ----
	const backup = $derived(app.settings.backup);
	let backingUp = $state(false);
	async function backupNow() {
		backingUp = true;
		await run(() => app.backupNow(), '백업을 만들었습니다');
		backingUp = false;
	}
	const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	async function copyDir() {
		try {
			await navigator.clipboard.writeText(app.backups?.dir ?? '');
			toast('경로를 복사했습니다', 'success');
		} catch {
			toast('복사하지 못했습니다', 'error');
		}
	}
	// 복구: 고르면 표시만 하고 다음 시작 때 적용한다
	let restoreTarget = $state<{ name: string; at: number; undo: boolean } | null>(null);
	const restore = $derived(app.backups?.restore ?? null);
	const pendingText = $derived.by(() => {
		const name = restore?.pending;
		if (!name) return '';
		if (name === BEFORE_RESTORE) return '복구 전 상태로';
		const item = app.backups?.items.find((b) => b.name === name);
		return item ? `${fmt(item.at)} 백업으로` : `${name} 으로`;
	});
	async function requestRestore() {
		const target = restoreTarget;
		restoreTarget = null;
		if (target) await run(() => app.requestRestore(target.name));
	}
	const restartNow = () => run(() => restartApp());

	// ---- 복구 보관함 (작업 폴더 파일 변경의 원본) ----
	let snapshots = $state<{ bytes: number; count: number } | null>(null);
	let clearing = $state(false);
	async function clearSnapshots() {
		clearing = false;
		await run(async () => {
			snapshots = await app.clearSnapshots();
		}, '복구 보관함을 비웠습니다');
	}

	// ---- 라운지 ----
	const lounge = $derived(app.settings.lounge);
	const statusLabel = { running: '진행 중', done: '끝남', stopped: '중지됨', failed: '중단됨' };
	const setLounge = (patch: Partial<LoungeSettings>) => void run(() => app.patchSettings({ lounge: patch }));
	// 숫자 입력: 범위 밖·정수가 아니면 저장하지 않고 원래 값으로 되돌린다
	function setLoungeNumber(key: 'perDay' | 'turns', input: HTMLInputElement, min: number, max: number) {
		const n = Number(input.value.trim());
		if (!Number.isInteger(n) || n < min || n > max) {
			toast(`${min}~${max} 사이의 정수를 넣으세요`, 'error');
			input.value = String(lounge[key]);
			return;
		}
		if (n !== lounge[key]) setLounge({ [key]: n });
	}
	function toggleAgent(id: string, on: boolean) {
		const cur = app.settings.lounge.agentIds;
		setLounge({ agentIds: on ? [...cur, id] : cur.filter((x) => x !== id) });
	}
	// ---- 리서치 (P11a) ----
	const mb = (n: number) => `${Math.round(n / 1_048_576)}MB`;
	let denyText = $state(untrack(() => app.settings.research.denyDomains.join('\n')));
	const denyDirty = $derived(denyText.trim() !== app.settings.research.denyDomains.join('\n'));
	function saveDeny() {
		const list = [
			...new Set(
				denyText
					.split(/[\s,]+/)
					.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
					.filter(Boolean)
			)
		];
		void run(async () => {
			await app.patchSettings({ research: { denyDomains: list } });
			denyText = list.join('\n');
		}, '차단 도메인을 저장했습니다');
	}

	async function runNow() {
		running = true;
		await run(() => app.runLoungeNow(), '라운지를 시작했습니다. 라운지 채팅에서 볼 수 있습니다.');
		running = false;
	}
</script>

<ListDetail label="설정 분류">
	{#snippet list()}
		<div class="list-title">설정</div>
		{#each CATEGORIES as c (c.id)}
			<ListRow title={c.label} active={cat === c.id} onclick={() => pick(c.id)} />
		{/each}
	{/snippet}
<div class="page">
	<h1>{CATEGORIES.find((c) => c.id === cat)?.label}</h1>

	{#if cat === 'display'}
	<section class="card" aria-labelledby="s-theme">
		<h2 id="s-theme">테마</h2>
		<p class="hint">켜는 테마는 이 기기에만 적용됩니다.</p>
		<div class="row">
			<select aria-labelledby="s-theme" value={app.theme} onchange={(e) => run(() => app.setTheme(e.currentTarget.value))}>
				<option value="studio">기본</option>
				{#each app.themes as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
			</select>
			<Button size="sm" onclick={() => themeInput?.click()}>테마 zip 올리기</Button>
			{#if activeTheme}<Button size="sm" variant="ghost" onclick={() => run(() => app.removeTheme(app.theme), '테마를 삭제했습니다')}>이 테마 삭제</Button>{/if}
			<input bind:this={themeInput} type="file" accept=".zip,application/zip" hidden onchange={onThemeFile} />
		</div>
		<p class="hint">테마는 화면 모양을 모두 바꿀 수 있으니 믿을 수 있는 파일만 올리세요. 외부 주소를 부르는 테마는 받지 않습니다.</p>
		{#if activeTheme?.notice}<p class="hint">{activeTheme.notice}</p>{/if}
	</section>
	<section class="card" aria-labelledby="s-display">
		<h2 id="s-display">화면 크기</h2>
		<p class="hint">이 기기에만 적용됩니다.</p>
		<div class="row">
			<select aria-labelledby="s-display" value={app.scale} onchange={(e) => app.setScale(e.currentTarget.value as DisplayScale)}>
				<option value="small">작게</option>
				<option value="normal">보통</option>
				<option value="large">크게</option>
			</select>
		</div>
		<div class="row">
			<label class="check">
				<input type="checkbox" checked={app.railLabels} onchange={(e) => app.setRailLabels(e.currentTarget.checked)} />
				왼쪽 아이콘에 이름 표시
			</label>
		</div>
		<div class="row">
			<label class="check">
				<input type="checkbox" checked={app.characterMotion} onchange={(e) => app.setCharacterMotion(e.currentTarget.checked)} />
				캐릭터 움직임 (시선·깜박임·표정)
			</label>
		</div>
	</section>
	{/if}

	<!-- 계정 (사용자 결정 2026-10-30: 사이드바 계정 메뉴를 설정 맨 위로) -->
	{#if cat === 'account'}
	<section class="card" aria-labelledby="s-account">
		<h2 id="s-account">계정</h2>
		{#if app.account?.signedIn}
			<div class="row">
				<span>ChatGPT 계정 <strong>{app.account.email || '로그인됨'}</strong></span>
				{#if app.account.mock}<span class="hint">모의 서버</span>{/if}
			</div>
			<p class="hint">
				{app.account.planUsage
					? 'ChatGPT 플랜으로 사용 중입니다. 사용량 한도는 ChatGPT 설정에서 관리합니다.'
					: '플랜 사용 권한이 없습니다. 로그아웃한 뒤 다시 로그인하세요.'}
			</p>
			<div class="row end">
				<a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
				<Button onclick={() => run(() => app.signOut())}>로그아웃</Button>
			</div>
		{:else}
			<p class="hint">로그인하지 않았습니다. 에이전트와 채팅하려면 ChatGPT 계정으로 로그인하세요.</p>
			<div class="row">
				<ChatGPTButton disabled={app.signingIn} onclick={() => app.beginSignIn()} />
			</div>
			{#if app.signInError}<p class="hint sub">{app.signInError}</p>{/if}
		{/if}
		<div class="row">
			<label class="field-inline">
				<input
					type="checkbox"
					checked={app.settings.updateCheck}
					onchange={(e) => {
						const updateCheck = e.currentTarget.checked;
						run(async () => {
							await app.patchSettings({ updateCheck });
							await app.checkUpdate();
						});
					}}
				/>
				<span>새 버전 알림</span>
			</label>
		</div>
		<p class="hint">GitHub 에 최신 버전을 물어봅니다. 설치는 직접 합니다.</p>
		<div class="row">
			<Button size="sm" variant="ghost" onclick={() => (app.privacy = 'view')}>개인정보 안내</Button>
		</div>
	</section>
	{/if}

	{#if cat === 'model'}
	<section class="card" aria-labelledby="s-model">
		<h2 id="s-model">기본 모델</h2>
		<p class="hint">지정 모델이 없는 에이전트와 그룹챗이 씁니다. 1인 채팅 입력창에서 고른 모델은 그 에이전트에만 적용됩니다.</p>
		<div class="row">
			<select
				value={app.model}
				disabled={app.models.length === 0}
				aria-label="기본 모델"
				onchange={(e) => app.setModel(e.currentTarget.value)}
			>
				{#each app.models as m (m.slug)}
					<option value={m.slug}>{m.displayName}</option>
				{:else}
					<option value="">로그인하면 모델 목록이 보입니다</option>
				{/each}
			</select>
		</div>
	</section>
	{/if}

	{#if cat === 'instructions'}
	<section class="card" aria-labelledby="s-instructions">
		<h2 id="s-instructions">전역 지침</h2>
		<p class="hint">
			모든 에이전트에게 늘 주는 지시입니다. 채팅·그룹·토론·위임·선제 메시지에 들어가고, 라운지(에이전트끼리 잡담)에는 넣지 않습니다.
			예: "존댓말로 짧게 답해", "코드는 TypeScript 로".
		</p>
		<textarea
			bind:value={instructions}
			rows="5"
			maxlength={GLOBAL_INSTRUCTIONS_MAX}
			placeholder="모든 에이전트가 따를 지시를 적으세요"
			aria-label="전역 지침"
		></textarea>
		<div class="row end">
			<span class="hint">{instructions.length} / {GLOBAL_INSTRUCTIONS_MAX}</span>
			<Button size="sm" disabled={!instructionsDirty} onclick={() => (instructions = app.settings.instructions)}>되돌리기</Button>
			<Button size="sm" variant="primary" disabled={!instructionsDirty} onclick={saveInstructions}>저장</Button>
		</div>
	</section>
	{/if}

	{#if cat === 'budget'}
	<section class="card" aria-labelledby="s-budget">
		<h2 id="s-budget">일일 예산</h2>
		<p class="hint">
			기능별 하루(자정 기준) LLM 요청 수 상한입니다. 모두 ChatGPT 플랜 사용량을 씁니다. 상한에 닿으면 그 기능은 다음 날까지
			요청하지 않습니다 (라우터는 순서대로 답하기, 요약·기억은 다음에 다시).
		</p>
		<table>
			<thead><tr><th>기능</th><th class="num">오늘</th><th>상한</th></tr></thead>
			<tbody>
				{#each features as f (f)}
					{@const limit = app.settings.budgets[f]}
					<tr>
						<td>
							<div>{FEATURE_LABEL[f].title}</div>
							<div class="hint">{FEATURE_LABEL[f].hint}</div>
						</td>
						<td class="num">{used(f)}</td>
						<td>
							<div class="limit">
								<label class="check">
									<input
										type="checkbox"
										checked={limit === null}
										onchange={(e) => setLimit(f, String(limit ?? 50), e.currentTarget.checked)}
									/>
									무제한
								</label>
								{#if limit !== null}
									<input
										type="number"
										min="1"
										max="10000"
										value={limit}
										onchange={(e) => setLimit(f, e.currentTarget.value, false)}
										aria-label="{FEATURE_LABEL[f].title} 상한"
									/>
								{/if}
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
	{/if}

	{#if cat === 'memory'}
	<section class="card" aria-labelledby="s-memory">
		<h2 id="s-memory">기억 자동 추출</h2>
		<div class="row">
			<label class="field-inline">
				<input
					type="checkbox"
					checked={app.settings.memory.autoExtract}
					onchange={(e) => run(() => app.patchSettings({ memory: { autoExtract: e.currentTarget.checked } }))}
				/>
				<span>대화가 조용해지면 기억 추출</span>
			</label>
		</div>
		<p class="hint">켜면 앱이 백그라운드에서 ChatGPT 플랜으로 대화를 OpenAI 에 보내 기억을 뽑습니다. 끄면 직접 누를 때만 추출합니다.</p>
		<h2>기억 검색</h2>
		<p class="hint">
			채팅마다 관련 기억을 찾을 때 키워드 검색에 로컬 임베딩(뜻이 비슷한 문장 검색)을 더합니다. 모델은 이 컴퓨터에서만 돌고, 켤 때
			Hugging Face 에서 한 번 내려받습니다. 실패하면 키워드 검색만 씁니다.
		</p>
		<div class="row">
			<label class="field-inline">
				<span>로컬 임베딩</span>
				<select
					value={app.settings.memory.embedding}
					onchange={(e) =>
						run(() =>
							app.patchSettings({
								memory: { embedding: e.currentTarget.value as (typeof embeddingOptions)[number]['id'] }
							})
						)}
				>
					{#each embeddingOptions as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
				</select>
			</label>
		</div>
		{#if embeddingState}<p class="hint">{embeddingState}</p>{/if}
		<p class="hint">
			Gemma is provided under and subject to the Gemma Terms of Use found at
			<a href="https://ai.google.dev/gemma/terms" target="_blank" rel="noreferrer">ai.google.dev/gemma/terms</a>.
			금지된 사용은 약관 3.2 항을 따릅니다.
		</p>
	</section>
	{/if}

	{#if cat === 'research'}
	<section class="card" aria-labelledby="s-research">
		<h2 id="s-research">리서치</h2>
		<p class="hint">
			리서치는 이 컴퓨터의 전용 브라우저(Chromium)로 웹 페이지를 읽습니다. 처음 쓸 때 한 번 내려받으며, 다른 프로그램과 공유하지 않고
			삭제할 수 있습니다. robots.txt 를 따르고, 로컬·사설망 주소와 아래 차단 도메인은 읽지 않습니다.
		</p>
		{#if app.browser}
			{@const b = app.browser}
			<div class="row">
				{#if b.installing}
					<span>
						{b.installing.stage === 'extract'
							? '압축 푸는 중…'
							: `내려받는 중 ${mb(b.installing.received)} / ${mb(b.installing.total)}`}
					</span>
					<span class="grow"></span>
					<Button size="sm" onclick={() => run(() => app.browserAction('cancel'))}>취소</Button>
				{:else if b.installed}
					<span>Chromium {b.version} · {mb(b.size)}</span>
					<span class="grow"></span>
					<Button size="sm" onclick={() => run(() => app.browserAction('remove'), '리서치 브라우저를 삭제했습니다')}>삭제</Button>
				{:else}
					<span>설치되지 않음 · 내려받기 약 {mb(b.downloadSize)}</span>
					<span class="grow"></span>
					<Button size="sm" variant="primary" onclick={() => run(() => app.browserAction('install'))}>설치</Button>
				{/if}
			</div>
			{#if b.error}<p class="hint sub">{b.error}</p>{/if}
		{/if}
		<label class="group">
			<span class="label">차단 도메인 (한 줄에 하나, 하위 도메인 포함)</span>
			<textarea rows="3" bind:value={denyText} placeholder="example.com"></textarea>
		</label>
		{#if denyDirty}
			<div class="row end"><Button size="sm" variant="primary" onclick={saveDeny}>저장</Button></div>
		{/if}
	</section>
	{/if}

	{#if cat === 'proactive'}
	<section class="card" aria-labelledby="s-proactive">
		<h2 id="s-proactive">알림·선제 메시지</h2>
		<p class="hint">
			에이전트가 먼저 말을 거는 메시지입니다: 채팅 중 부탁한 리마인더, 에이전트 편집기의 정기 체크인, 무응답 안부. 문구는 보낼 때
			만듭니다.
		</p>
		<div class="row">
			<label class="check">
				<input
					type="checkbox"
					checked={proactive.quietEnabled}
					onchange={(e) => run(() => app.patchSettings({ proactive: { quietEnabled: e.currentTarget.checked } }))}
				/>
				방해 금지
			</label>
			<select
				value={proactive.quietStart}
				disabled={!proactive.quietEnabled}
				aria-label="방해 금지 시작"
				onchange={(e) => run(() => app.patchSettings({ proactive: { quietStart: Number(e.currentTarget.value) } }))}
			>
				{#each hours as h (h)}<option value={h}>{h}시</option>{/each}
			</select>
			<span>부터</span>
			<select
				value={proactive.quietEnd}
				disabled={!proactive.quietEnabled}
				aria-label="방해 금지 끝"
				onchange={(e) => run(() => app.patchSettings({ proactive: { quietEnd: Number(e.currentTarget.value) } }))}
			>
				{#each hours as h (h)}<option value={h}>{h}시</option>{/each}
			</select>
			<span>전까지</span>
		</div>
		<p class="hint sub">리마인더는 방해 금지가 끝난 뒤 보내고, 체크인은 그날 건너뜁니다.</p>
		<div class="row">
			<label class="check">
				<input
					type="checkbox"
					checked={proactive.nudgeEnabled}
					onchange={(e) => run(() => app.patchSettings({ proactive: { nudgeEnabled: e.currentTarget.checked } }))}
				/>
				무응답 안부
			</label>
			<select
				value={proactive.nudgeDays}
				aria-label="안부 기준 일수"
				onchange={(e) => run(() => app.patchSettings({ proactive: { nudgeDays: Number(e.currentTarget.value) } }))}
			>
				{#each [1, 2, 3, 5, 7, 14, 30] as d (d)}<option value={d}>{d}일</option>{/each}
			</select>
			<span>동안 채팅이 없으면 마지막 채팅의 에이전트가 한 번</span>
		</div>

		<h3>알림</h3>
		{#if inApp}
			<div class="row">
				<label class="check">
					<input type="checkbox" checked={autostart} onchange={(e) => toggleAutostart(e.currentTarget.checked)} />
					Windows 시작 시 자동 실행 <span class="hint">(창 없이 트레이로 시작)</span>
				</label>
				<Button size="sm" onclick={testNotification}>테스트 알림</Button>
			</div>
		{:else if permission === 'granted'}
			<div class="row">
				<span class="hint">브라우저 알림 허용됨 (이 탭이 열려 있고, 다른 채팅을 보거나 창을 떠나 있을 때)</span>
				<Button size="sm" onclick={testNotification}>테스트 알림</Button>
			</div>
		{:else if permission === 'denied'}
			<p class="hint">브라우저 알림이 차단되어 있습니다. 브라우저 사이트 설정에서 허용할 수 있습니다.</p>
		{:else}
			<div class="row">
				<Button size="sm" onclick={askPermission}>브라우저 알림 허용</Button>
				<span class="hint">이 탭이 열려 있을 때 선제 메시지를 시스템 알림으로</span>
			</div>
		{/if}

		<h3>예약된 리마인더</h3>
		{#if app.reminders.length === 0}
			<p class="hint">없음. 채팅에서 "내일 9시에 알려줘"처럼 부탁하면 에이전트가 예약합니다.</p>
		{:else}
			<ul class="list">
				{#each app.reminders as r (r.id)}
					<li>
						<span class="v">{fmt(r.dueAt)} · {REPEAT_LABEL[r.repeat]} · {app.look(r.agentId).name} · {r.text}</span>
						<Button size="sm" variant="ghost" onclick={() => run(() => app.cancelReminder(r.id), '리마인더를 취소했습니다')}>
							취소
						</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	{/if}

	{#if cat === 'backup'}
	<section class="card" aria-labelledby="s-backup">
		<h2 id="s-backup">백업</h2>
		<p class="hint">
			하루 한 번 데이터 폴더에 채팅·기억·설정 사본(.sqlite)을 만들고 최근 것만 남깁니다. 로그인 정보와 Skill 폴더는 들어가지 않습니다. 채팅 하나는
			채팅 ⋯ 메뉴의 '마크다운으로 내보내기'로 받을 수 있습니다. 표정과 테마 파일은 같은 이름의 -files 폴더에 함께 복사합니다.
		</p>
		<div class="row">
			<label class="check">
				<input
					type="checkbox"
					checked={backup.enabled}
					onchange={(e) => run(() => app.patchSettings({ backup: { enabled: e.currentTarget.checked } }))}
				/>
				자동 백업
			</label>
			<label class="field-inline">
				<span>최근</span>
				<select
					value={backup.keep}
					aria-label="남길 백업 수"
					onchange={(e) => run(() => app.patchSettings({ backup: { keep: Number(e.currentTarget.value) } }))}
				>
					{#each [3, 7, 14, 30] as n (n)}<option value={n}>{n}</option>{/each}
				</select>
				<span>개 남기기</span>
			</label>
			<Button size="sm" disabled={backingUp} onclick={backupNow}>{backingUp ? '백업 중…' : '지금 백업'}</Button>
		</div>
		{#if app.backups}
			<div class="row">
				<span class="hint path" title={app.backups.dir}>{app.backups.dir}</span>
				<Button size="sm" variant="ghost" onclick={copyDir}>경로 복사</Button>
			</div>
			{#if restore?.pending}
				<div class="row" role="status">
					<span class="v">{pendingText} 복구를 예약했습니다. {inApp ? '앱' : 'daemon'}을 다시 시작하면 적용됩니다.</span>
					{#if inApp}<Button size="sm" onclick={restartNow}>지금 다시 시작</Button>{/if}
					<Button size="sm" variant="ghost" onclick={() => run(() => app.cancelRestore())}>취소</Button>
				</div>
			{/if}
			{#if app.backups.items.length}
				<ul class="list">
					{#each app.backups.items as b (b.name)}
						<li>
							<span class="v">{fmt(b.at)}</span><span class="hint">{sizeText(b.size)}</span>
							<Button size="sm" variant="ghost" onclick={() => (restoreTarget = { name: b.name, at: b.at, undo: false })}>복구</Button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="hint">아직 백업이 없습니다.</p>
			{/if}
			{#if restore?.before}
				{@const before = restore.before}
				<div class="row">
					<span class="v hint">복구 전 상태 · {fmt(before.at)}</span>
					<Button size="sm" variant="ghost" onclick={() => (restoreTarget = { name: BEFORE_RESTORE, at: before.at, undo: true })}>되돌리기</Button>
				</div>
			{/if}
		{/if}
	</section>

	<section class="card" aria-labelledby="s-snapshots">
		<h2 id="s-snapshots">복구 보관함</h2>
		<p class="hint">
			작업 폴더에서 에이전트가 파일을 편집하거나 삭제하기 직전의 원본입니다. 채팅의 '되돌리기'가 이것을 씁니다. 30일이 지나거나 채팅마다
			500MB 를 넘으면 오래된 것부터 삭제합니다. 명령 실행으로 바뀐 파일은 여기에 없습니다.
		</p>
		<div class="row">
			<span class="hint">{snapshots ? `원본 ${snapshots.count}개 · ${sizeText(snapshots.bytes)}` : '불러오는 중…'}</span>
			<Button size="sm" variant="ghost" disabled={!snapshots?.count} onclick={() => (clearing = true)}>비우기</Button>
		</div>
	</section>
	{/if}

	{#if cat === 'lounge'}
	<section class="card" aria-labelledby="s-lounge">
		<h2 id="s-lounge">라운지</h2>
		<p class="hint">
			사용자 없이 에이전트끼리 '라운지' 채팅에서 잡담합니다. 주제는 에이전트가 고르고, 공용 핵심 기억을 소재로 참고할 수 있습니다.
			도구는 쓰지 않습니다. 정해 둔 시간대 안에서 하루 횟수만큼 무작위 시각에 시작하며, 다른 응답이 진행 중이면 미룹니다.
		</p>
		<div class="row">
			<label class="check">
				<input type="checkbox" checked={lounge.enabled} onchange={(e) => setLounge({ enabled: e.currentTarget.checked })} />
				자동으로 시작
			</label>
		</div>
		<div class="group">
			<span class="label">참가 에이전트 (2명 이상)</span>
			<div class="row">
				{#each app.agents as a (a.id)}
					{@const on = lounge.agentIds.includes(a.id)}
					<label class="check who">
						<input
							type="checkbox"
							checked={on}
							disabled={!on && lounge.agentIds.length >= 6}
							onchange={(e) => toggleAgent(a.id, e.currentTarget.checked)}
						/>
						<Avatar agentId={a.id} size={1.1} />
						{a.name}
					</label>
				{/each}
			</div>
		</div>
		<div class="row">
			<label class="field-inline">
				<span>하루</span>
				<input
					class="num"
					type="number"
					inputmode="numeric"
					min="1"
					max="10"
					value={lounge.perDay}
					onchange={(e) => setLoungeNumber('perDay', e.currentTarget, 1, 10)}
				/>
				<span>회</span>
			</label>
			<label class="field-inline">
				<span>세션당</span>
				<input
					class="num"
					type="number"
					inputmode="numeric"
					min="2"
					max="20"
					value={lounge.turns}
					onchange={(e) => setLoungeNumber('turns', e.currentTarget, 2, 20)}
				/>
				<span>발언</span>
			</label>
			<label class="field-inline">
				<select
					value={lounge.startHour}
					aria-label="시작 시각"
					onchange={(e) => setLounge({ startHour: Number(e.currentTarget.value) })}
				>
					{#each hours as h (h)}<option value={h}>{h}시</option>{/each}
				</select>
				<span>부터</span>
				<select value={lounge.endHour} aria-label="끝 시각" onchange={(e) => setLounge({ endHour: Number(e.currentTarget.value) })}>
					{#each hours as h (h)}<option value={h + 1}>{h + 1}시</option>{/each}
				</select>
				<span>전까지</span>
			</label>
		</div>
		<div class="row">
			<label class="check">
				<input
					type="checkbox"
					checked={lounge.extractMemories}
					onchange={(e) => setLounge({ extractMemories: e.currentTarget.checked })}
				/>
				라운지 채팅에서도 기억 추출
			</label>
		</div>
		<div class="row">
			<Button
				size="sm"
				onclick={runNow}
				disabled={running || lounge.agentIds.length < 2 || !app.model || !app.account?.planUsage}
				title="켜짐·시간대·하루 횟수와 관계없이 지금 한 번 (예산은 지킴)"
			>
				지금 한 번 실행
			</Button>
			<span class="hint">오늘 자동 실행 {app.lounge?.sessionsToday ?? 0} / {lounge.perDay}회 · 세션당 요청 약 {lounge.turns}회</span>
		</div>
		{#if app.lounge?.recent.length}
			<h3>최근 세션</h3>
			<ul class="list">
				{#each app.lounge.recent as s (s.id)}
					<li>
						<span class="v">
							{fmt(s.startedAt)} · {s.agentIds.map((id) => app.look(id).name).join(', ')} · {s.spoken}/{s.turns} ·
							{statusLabel[s.status]}{s.manual ? ' · 수동' : ''}{s.errorCode && s.status !== 'done' ? ` (${s.errorCode})` : ''}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	{/if}
</div>
</ListDetail>

<ConfirmDialog
	open={restoreTarget !== null}
	title={restoreTarget?.undo ? '복구 되돌리기' : '백업 복구'}
	confirmLabel="복구 예약"
	onconfirm={requestRestore}
	onclose={() => (restoreTarget = null)}
>
	{#if restoreTarget}
		<p>
			{restoreTarget.undo ? '복구 직전 상태로' : `${fmt(restoreTarget.at)} 백업으로`} 채팅·기억·설정과 표정·테마를 되돌립니다. 그 뒤의 변경은 지금 앱에서 사라지지만,
			적용 직전 상태를 한 벌 남겨 '되돌리기'로 돌아올 수 있습니다. 다음 시작 때 적용합니다.
		</p>
		<ul>
			<li>로그인과 Skill 폴더는 바뀌지 않습니다. Skill 목록은 폴더와 어긋날 수 있습니다.</li>
			<li>그 사이 끝낸 리마인더·예약 작업이 다시 실행될 수 있습니다.</li>
			<li>복구한 시점에 없는 채팅의 파일 되돌리기 원본은 지워지며 되돌려도 돌아오지 않습니다.</li>
		</ul>
	{/if}
</ConfirmDialog>

<ConfirmDialog open={clearing} title="복구 보관함 비우기" confirmLabel="비우기" onconfirm={clearSnapshots} onclose={() => (clearing = false)}>
	<p>보관한 원본을 모두 삭제합니다. 지금까지의 파일 변경은 더 이상 되돌릴 수 없습니다.</p>
</ConfirmDialog>

<style>
	.list-title {
		padding: 0 var(--s-2) var(--s-2);
		font-weight: var(--w-bold);
	}
	.page {
		padding: var(--s-5);
		display: grid;
		grid-template-columns: minmax(0, 1fr); /* 긴 경로가 칸을 밀지 않게 */
		align-content: start;
		gap: var(--s-4);
		max-width: 50rem;
		margin: 0 auto;
	}
	h1 {
		font-size: var(--t-2xl);
		margin-bottom: var(--s-1);
	}
	.card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--s-3);
		padding: var(--s-4) var(--s-5) var(--s-5);
		border: 1px solid var(--c-line);
		border-radius: var(--r-4);
		background: var(--c-surface-1);
		font-size: var(--t-md);
	}
	h2 {
		font-size: var(--t-lg);
	}
	h3 {
		font-size: var(--t-md);
		color: var(--c-text-2);
		margin-top: var(--s-2);
	}
	.hint {
		color: var(--c-text-3);
		font-size: var(--t-sm);
		line-height: 1.5;
	}
	.hint.sub {
		margin-top: calc(var(--s-2) * -1);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-3);
	}
	.row.end {
		justify-content: flex-end;
	}
	.row.end .hint {
		margin-right: auto;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
	}
	.field-inline {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
	}
	.group {
		display: grid;
		gap: var(--s-2);
	}
	.grow {
		flex: 1;
	}
	.label {
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	textarea {
		width: 100%;
		resize: vertical;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--t-sm);
	}
	th,
	td {
		text-align: left;
		padding: var(--s-2) var(--s-3);
		border-bottom: 1px solid var(--c-line);
		vertical-align: middle;
	}
	th {
		color: var(--c-text-3);
		font-weight: var(--w-regular);
	}
	tr:last-child td {
		border-bottom: none;
	}
	.limit {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-height: 2.25rem;
	}
	.limit input[type='number'] {
		width: 6rem;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s-1);
		font-size: var(--t-sm);
		color: var(--c-text-2);
	}
	.list li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 2rem;
	}
	.v {
		flex: 1;
		min-width: 0;
	}
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
	}
	.num {
		width: 4.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
