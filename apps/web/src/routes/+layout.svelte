<script lang="ts">
	// 앱 셸: 연결 화면 → 사이드바 · 본문 · 오른쪽 에이전트 패널 (Grok Bot 방식, 다크 전용)
	import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
	import '#lib/styles/tokens.css';
	import '#lib/styles/base.css';
	import { goto, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.js';
	import favicon from '#lib/assets/favicon.svg';
	import ApprovalGuard from '#lib/shell/ApprovalGuard.svelte';
	import PrivacyDialog from '#lib/shell/PrivacyDialog.svelte';
	import { inApp, routeExternalLinks } from '#lib/native.js';
	import Banner from '#lib/shell/Banner.svelte';
	import QuickSwitch from '#lib/shell/QuickSwitch.svelte';
	import ResearchPanel from '#lib/research/ResearchPanel.svelte';
	import RightPanel from '#lib/shell/RightPanel.svelte';
	import ConversationList from '#lib/shell/ConversationList.svelte';
	import Rail from '#lib/shell/Rail.svelte';
	import ResearchList from '#lib/shell/ResearchList.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Toaster from '#lib/ui/Toaster.svelte';
	import { USAGE_URL } from '@proprix/shared';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => {
		void app.init();
		// 앱: 외부 링크(출처·사용량 등)는 시스템 브라우저로
		const unroute = inApp ? routeExternalLinks() : () => {};
		return () => {
			unroute();
			app.dispose();
		};
	});

	// 화면 전환: 짧은 교차 페이드 (같은 화면 안의 이동·동작 줄이기 설정이면 생략)
	onNavigate((nav) => {
		if (!document.startViewTransition || nav.from?.url.pathname === nav.to?.url.pathname) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		return new Promise((resolve) => {
			const t = document.startViewTransition(async () => {
				resolve();
				await nav.complete.catch(() => {}); // 다른 이동으로 취소되면 전환만 끝낸다
			});
			t.ready.catch(() => {});
			t.finished.catch(() => {});
		});
	});

	// SIWC UI 가이드: 첫 로그인에만 안내
	const showWelcome = $derived(!!app.account?.signedIn && !app.account.welcomeShown);
	// 켠 테마의 안내 (테마가 정한 문구를 항상 보인다)
	const themeNotice = $derived(app.themes.find((t) => t.id === app.theme)?.notice ?? '');
	const inRoom = $derived(page.route.id === '/rooms/[id]');
	const inResearch = $derived(page.route.id === '/research/[id]');
	const showPanel = $derived(app.panelOpen && ((inRoom && !!app.room) || inResearch));
	// 목록 패널: 대화·리서치 화면에만. 좁은 창에서는 처음에 닫혀 있고, 레일로 열며, 고르면 닫힌다
	const hasList = $derived(inRoom || (page.route.id ?? '').startsWith('/research'));
	let listOpen = $state(true);
	const NARROW = '(max-width: 900px)';
	const NO_PANEL_ROOM = '(max-width: 1248px)'; // 이보다 좁으면 작업대 패널은 대화를 덮는다
	onMount(() => {
		// 창 폭에 맞춰 접고 편다: 작업대 패널 먼저, 더 좁으면 목록 패널 (누르면 다시 열 수 있다)
		const narrow = matchMedia(NARROW);
		const noRoom = matchMedia(NO_PANEL_ROOM);
		const fitList = () => (listOpen = !narrow.matches);
		const fitPanel = () => app.fitPanel(!noRoom.matches);
		fitList();
		fitPanel();
		narrow.addEventListener('change', fitList);
		noRoom.addEventListener('change', fitPanel);
		return () => {
			narrow.removeEventListener('change', fitList);
			noRoom.removeEventListener('change', fitPanel);
		};
	});
	$effect(() => {
		void page.url.pathname;
		if (matchMedia(NARROW).matches) listOpen = false;
	});
	let switching = $state(false);

	// 지금 보는 1인 방의 에이전트, 없으면 최근 활동한 에이전트와 새 대화
	async function newChat() {
		const a = app.roomAgents.length === 1 ? app.roomAgents[0] : app.agentsByActivity[0];
		if (!a) return;
		const room = await app.newRoom([a.id]);
		await goto(`/rooms/${room.id}`);
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing || !(e.ctrlKey || e.metaKey) || app.connection !== 'ready') return;
		const k = e.key.toLowerCase();
		if (k === 'k') {
			e.preventDefault();
			switching = true;
		} else if (k === 'n') {
			e.preventDefault();
			void newChat();
		} else if (e.key === '.') {
			e.preventDefault();
			app.togglePanel();
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>PROPRIX</title>
</svelte:head>

<svelte:window onkeydown={onKey} />

{#if app.connection !== 'ready'}
	<main class="gate">
		<div class="card">
			<div class="logo">PROPRIX</div>
			{#if app.connection === 'loading'}
				<p>연결하는 중…</p>
			{:else if app.connection === 'offline'}
				<p>daemon 에 연결할 수 없습니다.</p>
				<p class="sub">개발 중이면 <code>bun run dev</code> 로 실행하세요.</p>
				<Button onclick={() => location.reload()}>다시 연결</Button>
			{:else}
				<p>daemon {app.version} 이 실행 중입니다.</p>
				<p class="sub">터미널에 출력된 1회용 링크(<code>/auth/bootstrap?code=…</code>)로 한 번 접속하면 30일 동안 이 브라우저에서 다시 묻지 않습니다.</p>
			{/if}
		</div>
	</main>
{:else}
	<div class="shell" class:with-panel={showPanel} class:with-list={hasList && listOpen}>
		<Rail onsearch={() => (switching = true)} ontogglelist={() => (listOpen = !listOpen)} />
		{#if hasList && listOpen}
			{#if inRoom}<ConversationList />{:else}<ResearchList />{/if}
		{/if}
		<div class="main" data-ui="main">
			<Banner />
			<div class="content">{@render children()}</div>
			{#if themeNotice}<p class="theme-notice">{themeNotice}</p>{/if}
		</div>
		{#if showPanel}{#if inResearch}<ResearchPanel />{:else}<RightPanel />{/if}{/if}
	</div>
	<QuickSwitch open={switching} onclose={() => (switching = false)} />
{/if}

<Toaster />
<PrivacyDialog />
<ApprovalGuard />

<Dialog open={showWelcome} title="You're using your ChatGPT plan" dismissable={false} onclose={() => app.markWelcomeShown()}>
	<p>Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.</p>
	{#snippet footer()}
		<Button variant="primary" onclick={() => app.markWelcomeShown()}>Got it</Button>
	{/snippet}
</Dialog>

<Dialog
	open={!showWelcome && app.llm.paused}
	title="Usage limit reached"
	role="alertdialog"
	dismissable={false}
	onclose={() => {}}
>
	<p>Review your plan or this app's limit in ChatGPT settings.</p>
	<p class="sub">PROPRIX 는 새 요청을 멈췄습니다. 한도를 확인한 뒤 다시 시도하세요.</p>
	{#snippet footer()}
		<a class="usage" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
		<Button variant="primary" onclick={() => app.resumeLlm()}>다시 시도</Button>
	{/snippet}
</Dialog>

<style>
	.gate {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--s-4);
	}
	.card {
		display: grid;
		gap: var(--s-2);
		justify-items: center;
		text-align: center;
		max-width: 26.25rem;
		padding: var(--s-6) var(--s-5);
		border: 1px solid var(--c-line);
		border-radius: var(--r-4);
		background: var(--c-surface-1);
	}
	.logo {
		font-size: var(--t-xl);
		font-weight: var(--w-bold);
		letter-spacing: 0.06em;
		margin-bottom: var(--s-2);
	}
	.sub {
		color: var(--c-text-3);
		font-size: var(--t-sm);
	}
	.shell {
		display: grid;
		grid-template-columns: var(--rail-w) minmax(0, 1fr) 0;
		height: 100vh;
		overflow: hidden;
		transition: grid-template-columns var(--dur) var(--ease);
	}
	.shell.with-panel {
		grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--panel-w);
	}
	.shell.with-list {
		grid-template-columns: var(--rail-w) var(--sidebar-w) minmax(0, 1fr) 0;
	}
	.shell.with-list.with-panel {
		grid-template-columns: var(--rail-w) var(--sidebar-w) minmax(0, 1fr) var(--panel-w);
	}
	.shell :global(.panel) {
		width: var(--panel-w);
	}
	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.usage {
		align-self: center;
		margin-right: auto;
	}
	@media (max-width: 1248px) {
		.shell.with-panel {
			grid-template-columns: var(--rail-w) minmax(0, 1fr) 0;
		}
		.shell.with-list.with-panel {
			grid-template-columns: var(--rail-w) var(--sidebar-w) minmax(0, 1fr) 0;
		}
		.shell.with-panel :global(.panel) {
			position: fixed;
			right: 0;
			top: 0;
			bottom: 0;
			width: var(--panel-w);
			z-index: 30;
		}
	}
	.theme-notice {
		flex: none;
		margin: 0;
		padding: 0.125rem var(--s-3);
		border-top: 1px solid var(--c-line);
		font-size: var(--t-xs);
		color: var(--c-text-4);
		text-align: right;
	}
</style>
