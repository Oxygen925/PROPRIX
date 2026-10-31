<script lang="ts">
	// 방의 작업 폴더: 경로(앱은 폴더 선택 창) · 더할 규칙 · 명령 실행 켜기와 그 한계
	import { app } from '#lib/app.svelte.js';
	import { inApp, pickFolder } from '#lib/native.js';
	import Button from '#lib/ui/Button.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import { SHELL_LIMITS } from '@proprix/shared';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import { untrack } from 'svelte';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	const room = $derived(app.room);
	let path = $state('');
	let deny = $state('');
	let readonly = $state('');
	let shell = $state(false);
	let saving = $state(false);

	// 열 때마다 지금 값으로
	$effect(() => {
		if (!open) return;
		untrack(() => {
			path = room?.workspace ?? '';
			deny = (room?.workspaceRules.deny ?? []).join('\n');
			readonly = (room?.workspaceRules.readonly ?? []).join('\n');
			shell = room?.shellEnabled ?? false;
		});
	});

	const lines = (s: string) =>
		s
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);

	async function browse() {
		const picked = await pickFolder('작업 폴더 고르기');
		if (picked) path = picked;
	}

	async function save(clear = false) {
		saving = true;
		try {
			const changed = clear || path.trim() !== (room?.workspace ?? '');
			await app.updateRoom({
				...(changed ? { workspace: clear ? '' : path.trim() } : {}),
				workspaceRules: { deny: lines(deny), readonly: lines(readonly) },
				// 폴더를 바꾸면 daemon 이 명령 실행을 끈다 → 바꾼 뒤 다시 켜야 한다
				...(changed ? {} : { shellEnabled: shell })
			});
			if (changed && shell && !clear) await app.updateRoom({ shellEnabled: true });
			toast(clear ? '작업 폴더를 해제했습니다' : '작업 폴더를 저장했습니다', 'success');
			onclose();
		} catch (e) {
			toastError(e);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog {open} title="작업 폴더" width={600} {onclose}>
	<p class="hint">
		이 채팅의 에이전트가 이 폴더와 하위 폴더에서만 파일을 읽고 편집합니다. 편집·삭제는 정확한 변경 내용(diff)을 보고 허용하며,
		되돌릴 수 있습니다. 에이전트 편집기에서 '작업 폴더' 도구를 켜야 씁니다.
	</p>
	<Field label="폴더">
		<div class="pick">
			<input bind:value={path} placeholder={'예: C:\\work\\project'} spellcheck="false" />
			{#if inApp}<Button icon={IconFolder} onclick={browse}>고르기</Button>{/if}
		</div>
	</Field>
	<details class="rules">
		<summary>규칙</summary>
		<p class="hint">
			기본 규칙(끌 수 없음): .env·키(.pem·.key·id_rsa 등)·자격 증명 파일은 읽기도 막고, .git·node_modules 안은 바꾸지 않으며,
			바이너리·읽기 전용·5MB 넘는 파일·UTF-8 이 아닌 파일은 편집하지 않습니다. 아래에 한 줄에 하나씩 더할 수 있습니다 (예:
			<code>private/**</code>, <code>*.lock</code>).
		</p>
		<div class="two">
			<Field label="막기 (읽기·쓰기)"><textarea bind:value={deny} rows="4" spellcheck="false"></textarea></Field>
			<Field label="읽기 전용"><textarea bind:value={readonly} rows="4" spellcheck="false"></textarea></Field>
		</div>
	</details>
	<label class="check">
		<input type="checkbox" bind:checked={shell} />
		<span>이 채팅에서 명령 실행 허용 <span class="hint">(PowerShell · 매번 확인 · 에이전트의 '명령 실행' 도구도 켜야 함)</span></span>
	</label>
	{#if shell}<p class="limits" role="note">{SHELL_LIMITS}</p>{/if}
	{#snippet footer()}
		{#if room?.workspace}<Button variant="ghost" disabled={saving} onclick={() => save(true)}>해제</Button>{/if}
		<span class="grow"></span>
		<Button onclick={onclose}>취소</Button>
		<Button variant="primary" disabled={saving || !path.trim()} onclick={() => save()}>저장</Button>
	{/snippet}
</Dialog>

<style>
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.pick {
		display: flex;
		gap: var(--s-2);
	}
	.pick input {
		flex: 1;
		font-family: var(--font-mono);
	}
	.rules summary {
		cursor: pointer;
		color: var(--c-text-2);
	}
	.rules[open] {
		display: grid;
		gap: var(--s-2);
	}
	.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-3);
	}
	.two textarea {
		width: 100%;
		font-family: var(--font-mono);
		font-size: var(--t-sm);
	}
	.check {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
	}
	.check input {
		margin-top: 0.3em;
	}
	.limits {
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-waiting-line);
		border-radius: var(--r-2);
		background: var(--c-waiting-bg);
		color: var(--c-waiting);
		font-size: var(--t-sm);
	}
	.grow {
		flex: 1;
	}
</style>
