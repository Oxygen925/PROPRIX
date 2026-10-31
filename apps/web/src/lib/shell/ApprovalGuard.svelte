<script lang="ts">
	// 설치한 테마를 쓰는 동안 확인 대기 중인 도구 호출을 테마와 분리된 창으로 하나씩 묻는다 (approval-guard.ts)
	import { app } from '#lib/app.svelte.js';
	import { SHELL_LIMITS } from '@proprix/shared';
	import { openApprovalGuard } from './approval-guard.js';

	const custom = $derived(app.themes.some((t) => t.id === app.theme));
	const call = $derived(custom ? app.pendingCalls[0] : undefined);
	const callId = $derived(call?.id);

	// 호출이 바뀔 때만 다시 그린다 (대기 건수만 바뀌어도 누르던 창이 다시 뜨지 않게)
	$effect(() => {
		const id = callId;
		if (!id) return;
		const c = app.pendingCalls.find((p) => p.id === id);
		if (!c) return;
		const info = app.tools.find((t) => t.name === c.name);
		const who = app.look(c.agentId).name;
		const title = app.toolTitle(c.name);
		const shell = c.name === 'shell_run' || c.name === 'skill_run_script';
		return openApprovalGuard(
			{
				title,
				who,
				name: c.name,
				detail: c.preview || c.args,
				note: shell ? SHELL_LIMITS : '',
				allowLabel: info?.alwaysConfirm ? '실행 허용' : '한 번 허용',
				alwaysLabel: info?.alwaysConfirm ? '' : `${who}에게 항상 허용`,
				waiting: app.pendingCalls.length
			},
			(d) => app.decide(id, d.approve, d.always)
		);
	});
</script>
