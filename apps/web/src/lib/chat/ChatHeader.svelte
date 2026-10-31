<script lang="ts">
	// 대화 헤더: 아바타·이름·직무 + ⋯ 메뉴(이름 바꾸기·토론·기억 추출·요약·삭제) + 오른쪽 패널 토글
	// 그룹방의 참여자·연쇄 상한은 오른쪽 패널에서 바꾼다
	import { goto } from '$app/navigation';
	import { app } from '#lib/app.svelte.js';
	import DebateForm from '#lib/components/DebateForm.svelte';
	import { jobTitle } from '#lib/shell/agent-line.js';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import Dialog from '#lib/ui/Dialog.svelte';
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
	import { toast, toastError } from '#lib/ui/toast.svelte.js';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconLayoutSidebarRight from '@tabler/icons-svelte-runes/icons/layout-sidebar-right';
	import IconMessages from '@tabler/icons-svelte-runes/icons/messages';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArchive from '@tabler/icons-svelte-runes/icons/archive';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import IconPinnedOff from '@tabler/icons-svelte-runes/icons/pinned-off';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconFolder from '@tabler/icons-svelte-runes/icons/folder';
	import IconTerminal from '@tabler/icons-svelte-runes/icons/terminal-2';
	import WorkspaceDialog from './WorkspaceDialog.svelte';
	import ArtifactDialog from './ArtifactDialog.svelte';
	import SubchatDialog from './SubchatDialog.svelte';
	import TeamPickerDialog from './TeamPickerDialog.svelte';
	import IconGitBranch from '@tabler/icons-svelte-runes/icons/git-branch';
	import { exportCurrent, toggleArchive, togglePin } from './room-actions.js';
	import { untrack } from 'svelte';

	const room = $derived(app.room);
	const members = $derived(app.roomAgents);
	const solo = $derived(members.length === 1 ? members[0] : undefined);
	const lounge = $derived(room?.kind === 'lounge');

	let dialog = $state<'' | 'rename' | 'debate' | 'summary' | 'delete' | 'reference'>('');
	// 서브 채팅: 부모 링크·참조 사본
	const parentAlive = $derived(!!room?.parentRoomId && app.rooms.some((r) => r.id === room.parentRoomId));
	let reference = $state('');
	async function showReference() {
		try {
			reference = room ? await app.roomReference(room.id) : '';
			dialog = 'reference';
		} catch (e) {
			toastError(e);
		}
	}
	let title = $state('');
	let busy = $state(false);

	async function run(task: () => Promise<void>) {
		busy = true;
		try {
			await task();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	const rename = () =>
		run(async () => {
			const t = title.trim();
			if (t && t !== room?.title) await app.updateRoom({ title: t });
			dialog = '';
		});

	const remove = () =>
		run(async () => {
			const id = room?.id ?? '';
			await app.deleteRoom(id);
			dialog = '';
			toast('채팅을 삭제했습니다', 'success');
			await goto('/');
		});

	const extract = () => run(async () => toast(await app.extractMemories(), 'success'));
	const notify = (task: () => Promise<string>) => run(async () => toast(await task(), 'success'));

	let folderOpen = $state(false);

	// 입력창의 /dir · /summary 가 연다
	$effect(() => {
		const d = app.roomDialog;
		if (!d) return;
		untrack(() => {
			if (d === 'workspace') folderOpen = true;
			else if (d === 'debate') dialog = 'debate';
			else dialog = 'summary';
			app.roomDialog = '';
		});
	});
	const folderName = $derived(room?.workspace ? room.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? room.workspace : '');

	const items: MenuItem[] = $derived([
		...(!lounge
			? [{ label: room?.workspace ? '작업 폴더…' : '작업 폴더 지정…', icon: IconFolder, onSelect: () => (folderOpen = true) }]
			: []),
		...(!lounge && !room?.parentRoomId
			? [
					{
						label: '서브 채팅 열기 (지금까지 참조)',
						icon: IconGitBranch,
						onSelect: () => (app.subchatDraft = room ? { roomId: room.id } : null)
					}
				]
			: []),
		{
			label: '이름 바꾸기',
			icon: IconPencil,
			onSelect: () => {
				title = room?.title ?? '';
				dialog = 'rename';
			}
		},
		...(members.length > 1 && !lounge
			? [{ label: `${app.label('participant', '참여자')}·연쇄 상한`, icon: IconUsers, onSelect: () => app.togglePanel(true) }]
			: []),
		...(!lounge
			? [
					{
						label: `${app.label('debate', '토론')}·협업 시작`,
						icon: IconMessages,
						disabled: app.streaming,
						onSelect: () => (dialog = 'debate')
					}
				]
			: []),
		{
			label: busy ? '기억 추출 중…' : '지금 기억 추출',
			icon: IconBrain,
			hint: '플랜 사용량',
			disabled: busy || app.streaming || !app.account?.planUsage,
			onSelect: () => void extract()
		},
		...(app.summary ? [{ label: '이전 채팅 요약 보기', icon: IconFileText, onSelect: () => (dialog = 'summary') }] : []),
		...(!lounge
			? [
					{
						label: room?.pinned ? '고정 해제' : '맨 위에 고정',
						icon: room?.pinned ? IconPinnedOff : IconPin,
						onSelect: () => void notify(togglePin)
					},
					{
						label: room?.archived ? '보관 해제' : '보관하기',
						icon: IconArchive,
						onSelect: () => void notify(toggleArchive)
					}
				]
			: []),
		{ label: '마크다운으로 내보내기', icon: IconDownload, onSelect: () => void run(exportCurrent) },
		...(!lounge ? [{ label: '채팅 삭제', icon: IconTrash, danger: true, onSelect: () => (dialog = 'delete') }] : [])
	]);
</script>

{#if room}
	<header class="room-head">
		<div class="titles">
			{#if solo}
				{@const job = jobTitle(solo, app.persona(solo.personaId))}
				<div class="name">{solo.name}{#if job}<span class="job"> · {job}</span>{/if}</div>
				<div class="sub">{room.title}</div>
			{:else}
				<div class="name">{lounge ? '라운지' : room.title}</div>
				<div class="sub">
					{members.map((a) => a.name).join(', ') || '에이전트 없음'}{#if !lounge} · 연쇄 {room.chainLimit}{/if}
				</div>
			{/if}
		</div>
		{#if folderName}
			<button class="folder" title="{room.workspace}{room.shellEnabled ? ' · 명령 실행 허용' : ''}" onclick={() => (folderOpen = true)}>
				<IconFolder size="0.85rem" aria-hidden="true" />
				{folderName}
				{#if room.shellEnabled}<IconTerminal size="0.8rem" aria-label="명령 실행 허용" />{/if}
			</button>
		{/if}
		<Menu {items}>
			{#snippet trigger({ toggle, props })}
				<IconButton icon={IconDots} label="채팅 메뉴" onclick={toggle} {...props} />
			{/snippet}
		</Menu>
		<IconButton
			icon={IconLayoutSidebarRight}
			label="패널 (Ctrl+.)"
			active={app.panelOpen}
			onclick={() => app.togglePanel()}
		/>
	</header>
{/if}

{#if room?.parentRoomId}
	<div class="sub-bar" role="note">
		<IconGitBranch size="0.85rem" aria-hidden="true" />
		<span>
			{#if parentAlive}
				<a href="/rooms/{room.parentRoomId}{room.parentMessageId ? `?m=${room.parentMessageId}` : ''}">'{room.parentTitle}'</a>
			{:else}
				'{room.parentTitle}'(삭제한 채팅)
			{/if}
			의 {room.parentMessageId ? '이 메시지까지' : '채팅'}를 참조하는 서브 채팅 · 새 기억 저장 안 함
		</span>
		<button type="button" class="link" onclick={showReference}>참조 보기</button>
	</div>
{/if}

<Dialog open={dialog === 'reference'} title="참조한 부모 채팅 (사본)" width={640} onclose={() => (dialog = '')}>
	<p class="hint">만들 때 복사한 내용입니다. 에이전트는 이것을 배경으로만 봅니다.</p>
	<div class="summary">{reference || '(비어 있음)'}</div>
</Dialog>

<SubchatDialog />
<ArtifactDialog />
<TeamPickerDialog />

<Dialog open={dialog === 'rename'} title="채팅 이름 바꾸기" onclose={() => (dialog = '')}>
	<form
		id="rename-form"
		onsubmit={(e) => {
			e.preventDefault();
			void rename();
		}}
	>
		<Field label="이름">
			<input bind:value={title} maxlength="100" />
		</Field>
	</form>
	{#snippet footer()}
		<Button onclick={() => (dialog = '')}>취소</Button>
		<Button variant="primary" type="submit" form="rename-form" disabled={busy || !title.trim()}>저장</Button>
	{/snippet}
</Dialog>

<Dialog
	open={dialog === 'debate'}
	title="{app.label('debate', '토론')}·협업 시작"
	width={560}
	onclose={() => {
		dialog = '';
		app.debateDraft = null;
	}}
>
	{#key `${room?.id}-${app.debateDraft?.mode ?? ''}-${app.debateDraft?.topic ?? ''}`}
		<DebateForm
			invite={!!app.debateDraft}
			initialMode={app.debateDraft?.mode}
			initialTopic={app.debateDraft?.topic}
			onclose={() => {
				dialog = '';
				app.debateDraft = null;
			}}
		/>
	{/key}
</Dialog>

<Dialog open={dialog === 'summary'} title="이전 채팅 요약" width={560} onclose={() => (dialog = '')}>
	<p class="hint">오래된 채팅은 이 요약으로 줄여 에이전트에게 함께 보냅니다.</p>
	<div class="summary">{app.summary?.summary ?? ''}</div>
</Dialog>

<ConfirmDialog open={dialog === 'delete'} title="채팅 삭제" disabled={busy} onconfirm={remove} onclose={() => (dialog = '')}>
	<p>'{room?.title}' 채팅과 그 안의 메시지·도구 기록·토론·리마인더를 삭제합니다. 기억은 남습니다.</p>
</ConfirmDialog>

<WorkspaceDialog open={folderOpen} onclose={() => (folderOpen = false)} />

<style>
	.sub-bar {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-1) var(--s-4);
		border-bottom: 1px solid var(--c-line);
		font-size: var(--t-xs);
		color: var(--c-text-3);
	}
	.sub-bar span {
		flex: 1;
		min-width: 0;
	}
	.sub-bar a {
		color: var(--c-text-2);
	}
	.sub-bar .link {
		border: none;
		background: none;
		padding: 0;
		color: var(--c-text-2);
		text-decoration: underline;
		font-size: var(--t-xs);
	}
	.folder {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		max-width: 14rem;
		padding: 0.1rem var(--s-2);
		border: 1px solid var(--c-line-strong);
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--c-text-2);
		font-size: var(--t-xs);
		font-family: var(--font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.room-head {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--c-line);
		min-height: 3.5rem;
	}
	.titles {
		flex: 1;
		min-width: 0;
	}
	.name,
	.sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name {
		font-weight: var(--w-bold);
	}
	.job {
		color: var(--c-text-3);
		font-weight: var(--w-regular);
	}
	.sub {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.hint {
		font-size: var(--t-sm);
		color: var(--c-text-3);
	}
	.summary {
		white-space: pre-wrap;
		font-size: var(--t-sm);
		color: var(--c-text-2);
		max-height: 50vh;
		overflow-y: auto;
	}
</style>
