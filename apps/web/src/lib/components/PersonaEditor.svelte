<script lang="ts">
	// 페르소나 편집기 (전체 화면): 기본(이름·이모지·색·이미지·설명) · 성격·말투 · 미리보기 · 연동·내보내기
	import { app } from '#lib/app.svelte.js';
	import { nextPersonaColor } from './persona-color';
	import Avatar from '#lib/components/Avatar.svelte';
	import { download } from '#lib/download.js';
	import { avatarDataUrl } from '#lib/image.js';
	import EditorShell from '#lib/manage/EditorShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Markdown from '#lib/ui/Markdown.svelte';
	import { errorText, toast, toastError } from '#lib/ui/toast.svelte.js';
	import { PERSONA_BODY_MAX, type Persona, PersonaInput } from '@proprix/shared';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconMoodSmile from '@tabler/icons-svelte-runes/icons/mood-smile';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import { untrack } from 'svelte';

	let { persona, onclose, dirty = $bindable(false) }: { persona: Persona | null; onclose: () => void; dirty?: boolean } = $props();

	// 편집 중인 값: 처음 값만 복사한다 (대상이 바뀌면 부모가 {#key} 로 다시 만든다)
	let form = $state(
		untrack(() => ({
			name: persona?.name ?? '',
			emoji: persona?.emoji ?? '🙂',
			color: persona?.color ?? nextPersonaColor(app.personas.map((p) => p.color)),
			description: persona?.description ?? '',
			body: persona?.body ?? '',
			petCharacterId: persona?.petCharacterId ?? '',
			avatarImage: persona?.avatarImage ?? ''
		}))
	);

	// 저장 안 한 변경: 목록에서 다른 항목을 고를 때 부모가 묻는다
	const saved = untrack(() => JSON.stringify(form));
	$effect(() => {
		dirty = JSON.stringify(form) !== saved;
	});

	const sections = [
		{ id: 'basic', label: '기본' },
		{ id: 'body', label: '성격·말투' },
		{ id: 'preview', label: '미리보기' },
		{ id: 'link', label: '연동·내보내기' }
	];

	let error = $state('');
	let saving = $state(false);
	let previewText = $state('');
	let previewReply = $state('');
	let previewing = $state(false);
	let imageInput: HTMLInputElement | undefined = $state();

	const parsed = $derived(PersonaInput.safeParse(form));

	async function save() {
		if (!parsed.success) {
			error = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
			return;
		}
		saving = true;
		error = '';
		try {
			await app.savePersona(persona?.id ?? null, parsed.data);
			toast(persona ? '저장했습니다' : '페르소나를 만들었습니다', 'success');
			onclose();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}

	// 표정 묶음: 편집기의 저장과 따로 바로 적용된다
	const savedCharacter = $derived(persona ? (app.persona(persona.id)?.character ?? null) : null);
	let packInput: HTMLInputElement | undefined = $state();
	let packBusy = $state(false);

	async function onPack(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !persona) return;
		packBusy = true;
		try {
			await app.uploadCharacter(persona.id, file);
			toast('표정 묶음을 적용했습니다', 'success');
		} catch (err) {
			toastError(err);
		} finally {
			packBusy = false;
		}
	}

	async function removePack() {
		if (!persona) return;
		packBusy = true;
		try {
			await app.removeCharacter(persona.id);
			toast('표정 묶음을 뺐습니다', 'success');
		} catch (err) {
			toastError(err);
		} finally {
			packBusy = false;
		}
	}

	async function onImage(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			form.avatarImage = await avatarDataUrl(file);
		} catch (err) {
			toastError(err);
		}
	}

	async function preview() {
		if (!parsed.success || !previewText.trim() || !app.model) return;
		previewing = true;
		previewReply = '';
		try {
			const r = await app.preview(parsed.data, parsed.data.name, '', previewText.trim(), app.model);
			previewReply = r.outcome === 'completed' ? r.text : `${r.text}\n\n(${r.code || r.outcome})`;
		} catch (e) {
			previewReply = errorText(e);
		} finally {
			previewing = false;
		}
	}

	async function exportAs(format: 'json' | 'markdown') {
		if (!persona) return;
		try {
			await download(
				`/personas/${persona.id}/export${format === 'markdown' ? '?format=markdown' : ''}`,
				format === 'markdown' ? 'persona.md' : `${persona.name}.json`
			);
		} catch (e) {
			toastError(e);
		}
	}
</script>

<EditorShell embedded title={persona ? `${persona.name} 편집` : '새 페르소나'} {sections} {saving} {error} {onclose} onsave={save}>
	<section id="sec-basic">
		<h2>기본</h2>
		<div class="ident">
			<Avatar emoji={form.emoji} color={form.color} image={form.avatarImage} personaId={persona?.id ?? ''} size={4} motion="full" />
			<div class="image-actions">
				<Button size="sm" icon={IconPhoto} onclick={() => imageInput?.click()}>
					{form.avatarImage ? '이미지 바꾸기' : '이미지 올리기'}
				</Button>
				{#if form.avatarImage}
					<Button size="sm" variant="ghost" icon={IconTrash} onclick={() => (form.avatarImage = '')}>이미지 빼기</Button>
				{/if}
				<p class="hint">png·jpeg·webp. 가운데를 정사각형으로 잘라 256px 로 줄입니다. 없으면 기본 캐릭터에 이모지와 색을 씁니다.</p>
			</div>
			<input bind:this={imageInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onchange={onImage} />
		</div>
		<div class="image-actions">
			<Button size="sm" icon={IconMoodSmile} disabled={!persona || packBusy} onclick={() => packInput?.click()}>
				{savedCharacter ? '표정 zip 바꾸기' : '표정 zip 올리기'}
			</Button>
			{#if persona && savedCharacter}
				<Button size="sm" variant="ghost" icon={IconDownload} onclick={() => persona && download(`/personas/${persona.id}/character/export`, 'character.zip')}>
					표정 zip 내보내기
				</Button>
				<Button size="sm" variant="ghost" icon={IconTrash} disabled={packBusy} onclick={removePack}>표정 zip 빼기</Button>
			{/if}
			<p class="hint">
				상태에 따라 이미지가 바뀌고, 올리면 단일 이미지보다 먼저 쓰며 바로 적용됩니다. 단일 이미지는 움직이지 않습니다.
				{#if !persona}먼저 페르소나를 저장하세요.{/if}
			</p>
			<input bind:this={packInput} type="file" accept=".zip,application/zip" hidden onchange={onPack} />
		</div>
		<div class="row">
			<label class="field grow"><span>이름</span><input bind:value={form.name} maxlength="40" /></label>
			<label class="field emoji"><span>이모지</span><input bind:value={form.emoji} maxlength="8" /></label>
			<label class="field"><span>색</span><input type="color" bind:value={form.color} /></label>
		</div>
		<label class="field">
			<span>설명 <span class="hint">목록에 보이는 한 줄</span></span>
			<input bind:value={form.description} maxlength="200" />
		</label>
	</section>

	<section id="sec-body">
		<h2>성격·말투 <span class="count">{form.body.length} / {PERSONA_BODY_MAX}</span></h2>
		<textarea
			bind:value={form.body}
			rows="14"
			maxlength={PERSONA_BODY_MAX}
			placeholder={'- 성격: 차분하고 호기심이 많다.\n- 말투: 존댓말, 짧고 담백하게.'}
			aria-label="성격·말투"
		></textarea>
		<p class="hint">자유 형식 마크다운. 규칙·권한은 여기서 바꿀 수 없고 성격과 말투만 반영됩니다.</p>
	</section>

	<section id="sec-preview">
		<h2>미리보기</h2>
		<p class="hint">저장하지 않은 지금 내용으로 한 번 채팅해 봅니다. 이력·기억 없이, 플랜 사용량을 씁니다.</p>
		<form
			class="row"
			onsubmit={(e) => {
				e.preventDefault();
				void preview();
			}}
		>
			<input class="grow" bind:value={previewText} placeholder="미리보기 메시지" maxlength="2000" aria-label="미리보기 메시지" />
			<Button type="submit" disabled={previewing || !parsed.success || !previewText.trim() || !app.model}>
				{previewing ? '받는 중…' : '전송'}
			</Button>
		</form>
		{#if previewReply}
			<div class="reply">
				<Avatar emoji={form.emoji} color={form.color} image={form.avatarImage} size={1.3} />
				<Markdown text={previewReply} />
			</div>
		{/if}
	</section>

	<section id="sec-link">
		<h2>연동·내보내기</h2>
		<label class="field">
			<span>desktop_pet 캐릭터 id <span class="hint">선택 — 펫 연동용</span></span>
			<input bind:value={form.petCharacterId} maxlength="64" placeholder="windowling" />
		</label>
		{#if persona}
			<div class="row">
				<Button size="sm" icon={IconDownload} onclick={() => exportAs('json')}>JSON 내보내기</Button>
				<Button size="sm" icon={IconDownload} onclick={() => exportAs('markdown')}>persona.md 내보내기</Button>
			</div>
			<p class="hint">저장된 내용을 내보냅니다. JSON 은 이미지까지, persona.md 는 desktop_pet 형식(본문)입니다.</p>
		{:else}
			<p class="hint">저장한 뒤 내보낼 수 있습니다.</p>
		{/if}
	</section>
</EditorShell>

<style>
	.ident {
		display: flex;
		align-items: center;
		gap: var(--s-4);
	}
	.image-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.image-actions .hint {
		flex-basis: 100%;
	}
	.grow {
		flex: 1;
		min-width: 12rem;
	}
	.emoji input {
		width: 4.5rem !important;
		text-align: center;
	}
	input[type='color'] {
		width: 3rem;
		height: 2.4rem;
		padding: 0.15rem;
	}
	.count {
		margin-left: var(--s-2);
		font-size: var(--t-xs);
		font-weight: var(--w-regular);
		color: var(--c-text-4);
	}
	.reply {
		display: flex;
		gap: var(--s-2);
		padding: var(--s-3);
		border-radius: var(--r-3);
		background: var(--c-surface-2);
	}
</style>
