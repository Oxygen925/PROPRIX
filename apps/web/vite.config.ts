import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// daemon 주소. dev 에서는 /api·/auth 를 프록시해 쿠키가 UI origin 에 붙게 한다
const daemon = process.env.PROPRIX_DAEMON_URL ?? 'http://127.0.0.1:47800';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// SPA: daemon(또는 Tauri)이 정적 파일로 서빙하고 모든 경로를 index.html 로 돌린다
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true,
		proxy: {
			'/api': { target: daemon, ws: true },
			'/auth': { target: daemon }
		}
	}
});
