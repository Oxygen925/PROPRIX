<script lang="ts">
	// 본문 위 한 줄 안내: 연결 끊김 · 로그인 필요 · 플랜 권한 없음 · 모델 오류 · 새 버전 (하나만, 중요한 순서로)
	import { app, RELEASES_URL } from '#lib/app.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	import ChatGPTButton from './ChatGPTButton.svelte';
</script>

{#if !app.wsConnected}
	<div class="banner warn" role="status">daemon 과 연결이 끊겼습니다. 다시 연결하는 중…</div>
{:else if app.account && !app.account.signedIn}
	<div class="banner" role="status">
		{#if app.signingIn}
			<span>브라우저에서 ChatGPT 로그인을 마치세요…</span>
			<Button size="sm" variant="ghost" onclick={() => app.cancelSignIn()}>취소</Button>
		{:else}
			<span>ChatGPT 로 로그인하면 에이전트와 채팅할 수 있어요.</span>
			<ChatGPTButton size="sm" onclick={() => app.beginSignIn()} />
		{/if}
		{#if app.signInError}<span class="err">{app.signInError}</span>{/if}
	</div>
{:else if app.account?.signedIn && !app.account.planUsage}
	<div class="banner warn" role="status">
		<span>ChatGPT 플랜 사용 권한이 없습니다. 다시 로그인해 허용하세요.</span>
		<Button size="sm" onclick={() => app.signIn()}>다시 로그인</Button>
	</div>
{:else if app.modelsError}
	<div class="banner warn" role="status">
		<span>모델 목록을 불러오지 못했습니다 ({app.modelsError}).</span>
		<Button size="sm" variant="ghost" onclick={() => app.loadModels()}>다시 시도</Button>
	</div>
{:else if app.update}
	<div class="banner" role="status">
		<span>새 버전 {app.update} 이(가) 있습니다.</span>
		<a href={RELEASES_URL} target="_blank" rel="noreferrer">내려받기</a>
		<Button size="sm" variant="ghost" onclick={() => app.dismissUpdate()}>닫기</Button>
	</div>
{/if}

<style>
	.banner {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex-wrap: wrap;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid var(--c-line);
		background: var(--c-surface-1);
		font-size: var(--t-md);
		color: var(--c-text-2);
	}
	.warn {
		background: var(--c-waiting-bg);
		border-bottom-color: var(--c-waiting-line);
		color: var(--c-waiting);
	}
	.err {
		color: var(--c-danger);
		font-size: var(--t-sm);
	}
</style>
