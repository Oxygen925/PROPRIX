<script lang="ts">
	// 개인정보 안내 (SIWC 약관: 데이터를 처리하기 전에 보여 준다). 전문은 저장소의 PRIVACY.md
	import { app, PRIVACY_URL } from '#lib/app.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';

	let autoExtract = $state(false);
</script>

<Dialog open={app.privacy !== null} title="개인정보 안내" dismissable={app.privacy !== 'update'} onclose={() => app.closePrivacy()}>
	<p>개발자는 서버를 운영하지 않으며, 사용 통계나 대화 내용을 수집하지 않습니다.</p>
	<ul>
		<li><strong>이 PC:</strong> 채팅·기억·설정은 데이터 폴더에 저장합니다. 로그인 토큰과 비밀번호는 암호화하지만, 일일 백업은 암호화하지 않습니다.</li>
		<li><strong>OpenAI:</strong> 메시지와 첨부, 페르소나, 관련 기억, 대화 요약, 도구 실행 결과를 ChatGPT 플랜으로 처리하려고 보냅니다. 채팅에 이어 요약·자동 제목도 자동으로 호출합니다.</li>
		<li><strong>그 밖의 곳:</strong> 리서치는 방문하는 웹사이트에, 도구는 직접 등록한 MCP 서버에 접속합니다. 리서치 브라우저와 임베딩 모델은 켤 때 내려받습니다. 새 버전 확인은 GitHub 에 묻습니다 (설정에서 끌 수 있음).</li>
		<li><strong>삭제:</strong> 앱을 지워도 데이터는 남습니다. 데이터 폴더를 삭제하면 모두 지워집니다.</li>
	</ul>
	{#if app.privacy !== 'view'}
		<label class="consent">
			<input type="checkbox" bind:checked={autoExtract} />
			<span>
				<strong>기억 자동 추출 사용 (선택):</strong> 대화가 조용해지면 앱이 백그라운드에서 ChatGPT 플랜으로 대화를 OpenAI 에 보내 기억을 뽑습니다.
				끄면 직접 누를 때만 추출합니다. 설정에서 언제든 바꿀 수 있습니다.
			</span>
		</label>
	{/if}
	<p><a href={PRIVACY_URL} target="_blank" rel="noreferrer">전문 보기</a></p>
	{#snippet footer()}
		{#if app.privacy === 'signin'}
			<Button onclick={() => app.closePrivacy()}>취소</Button>
			<Button variant="primary" onclick={() => app.acceptPrivacy(autoExtract)}>확인하고 계속</Button>
		{:else if app.privacy === 'update'}
			<Button variant="primary" onclick={() => app.closePrivacy(autoExtract)}>확인</Button>
		{:else}
			<Button onclick={() => app.closePrivacy()}>닫기</Button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.consent {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		margin-top: var(--s-3);
	}
</style>
