<script lang="ts">
	// 기억 그래프 (P10e, Obsidian graph view 방식): d3-force 배치 + SVG. 실선 = 내용 유사도, 점선 = 함께 쓰인 기억.
	// 휠로 확대, 빈 곳을 끌어 이동, 노드를 끌어 옮긴다. 가리키면 이웃을 강조하고, 누르면 onselect
	import type { Memory, MemoryEdge } from '@proprix/shared';
	import {
		forceCenter,
		forceCollide,
		forceLink,
		forceManyBody,
		forceSimulation,
		type Simulation,
		type SimulationLinkDatum,
		type SimulationNodeDatum
	} from 'd3-force';
	import { untrack } from 'svelte';

	let {
		memories,
		edges,
		selected = null,
		onselect
	}: { memories: Memory[]; edges: MemoryEdge[]; selected?: string | null; onselect: (id: string | null) => void } =
		$props();

	type Node = SimulationNodeDatum & { id: string; m: Memory; r: number };
	type Link = SimulationLinkDatum<Node> & { kind: MemoryEdge['kind']; weight: number };

	const HEIGHT = 520;
	const KIND_COLOR: Record<string, string> = {
		fact: 'var(--c-info)',
		preference: 'var(--c-done)',
		event: 'var(--c-waiting)',
		relationship: 'var(--c-working)'
	};

	let width = $state(800);
	let nodes: Node[] = [];
	let links: Link[] = [];
	let frame = $state(0); // 시뮬레이션이 움직일 때마다 올려 다시 그린다
	let sim: Simulation<Node, Link> | null = null;
	let view = $state({ x: 0, y: 0, k: 1 });
	let hovered = $state<string | null>(null);

	// 기억·간선이 바뀌면 다시 배치한다 (같은 기억은 자리를 이어받는다)
	$effect(() => {
		const ms = memories;
		const es = edges;
		untrack(() => {
			const prev = new Map(nodes.map((n) => [n.id, n]));
			nodes = ms.map((m) => {
				const p = prev.get(m.id);
				return { id: m.id, m, r: 4 + m.importance * 1.6, x: p?.x, y: p?.y, vx: p?.vx, vy: p?.vy };
			});
			const ids = new Set(nodes.map((n) => n.id));
			links = es.filter((e) => ids.has(e.a) && ids.has(e.b)).map((e) => ({ source: e.a, target: e.b, kind: e.kind, weight: e.weight }));
			sim?.stop();
			sim = forceSimulation(nodes)
				.force(
					'link',
					forceLink<Node, Link>(links)
						.id((n) => n.id)
						.distance((l) => (l.kind === 'similar' ? 70 : 110))
						.strength((l) => (l.kind === 'similar' ? 0.5 : 0.2))
				)
				.force('charge', forceManyBody().strength(-160))
				.force('center', forceCenter(width / 2, HEIGHT / 2))
				.force('collide', forceCollide<Node>().radius((n) => n.r + 3));
			// 동작 줄이기: 미리 돌린 뒤 멈춘 상태로
			if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
				sim.stop();
				sim.tick(300);
				frame++;
			} else sim.on('tick', () => frame++);
		});
		return () => sim?.stop();
	});

	const drawn = $derived.by(() => {
		void frame;
		return {
			nodes: nodes.map((n) => ({ id: n.id, m: n.m, r: n.r, x: n.x ?? 0, y: n.y ?? 0 })),
			links: links.map((l) => {
				const s = l.source as Node;
				const t = l.target as Node;
				return { key: `${l.kind}|${s.id}|${t.id}`, a: s.id, b: t.id, kind: l.kind, x1: s.x ?? 0, y1: s.y ?? 0, x2: t.x ?? 0, y2: t.y ?? 0 };
			})
		};
	});

	// 가리키거나 고른 노드의 이웃
	const focus = $derived(hovered ?? selected);
	const near = $derived.by(() => {
		const set = new Set<string>();
		if (!focus) return set;
		set.add(focus);
		for (const l of drawn.links) {
			if (l.a === focus) set.add(l.b);
			if (l.b === focus) set.add(l.a);
		}
		return set;
	});

	// ---- 확대·이동·끌기 ----
	let svg = $state<SVGSVGElement>();
	let drag: { kind: 'pan'; sx: number; sy: number; ox: number; oy: number } | { kind: 'node'; n: Node; moved: boolean } | null =
		null;

	const local = (e: PointerEvent | WheelEvent) => {
		const r = svg?.getBoundingClientRect();
		return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
	};
	const toGraph = (p: { x: number; y: number }) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const p = local(e);
		const k = Math.min(4, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
		view = { k, x: p.x - ((p.x - view.x) * k) / view.k, y: p.y - ((p.y - view.y) * k) / view.k };
	}

	function onDown(e: PointerEvent, id?: string) {
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		const n = id ? nodes.find((x) => x.id === id) : undefined;
		if (n) {
			drag = { kind: 'node', n, moved: false };
			n.fx = n.x;
			n.fy = n.y;
			sim?.alphaTarget(0.3).restart();
		} else drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
		e.stopPropagation();
	}

	function onMove(e: PointerEvent) {
		if (!drag) return;
		if (drag.kind === 'pan') view = { ...view, x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy };
		else {
			const g = toGraph(local(e));
			drag.n.fx = g.x;
			drag.n.fy = g.y;
			drag.moved = true;
			if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
				drag.n.x = g.x;
				drag.n.y = g.y;
				frame++;
			}
		}
	}

	function onUp(e: PointerEvent) {
		if (drag?.kind === 'node') {
			if (!drag.moved) onselect(drag.n.id === selected ? null : drag.n.id);
			drag.n.fx = null;
			drag.n.fy = null;
			sim?.alphaTarget(0);
		} else if (drag?.kind === 'pan' && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 3) {
			onselect(null); // 빈 곳을 누르기만 하면 고른 것을 푼다
		}
		drag = null;
	}

	const short = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);
</script>

<div class="wrap" bind:clientWidth={width}>
	<svg
		bind:this={svg}
		width={width}
		height={HEIGHT}
		role="application"
		aria-label="기억 그래프"
		onwheel={onWheel}
		onpointerdown={(e) => onDown(e)}
		onpointermove={onMove}
		onpointerup={onUp}
		onpointercancel={onUp}
	>
		<g transform="translate({view.x} {view.y}) scale({view.k})">
			{#each drawn.links as l (l.key)}
				<line
					x1={l.x1}
					y1={l.y1}
					x2={l.x2}
					y2={l.y2}
					class="link {l.kind}"
					class:dim={!!focus && !(near.has(l.a) && near.has(l.b) && (l.a === focus || l.b === focus))}
				/>
			{/each}
			{#each drawn.nodes as n (n.id)}
				<g
					class="node"
					class:dim={!!focus && !near.has(n.id)}
					class:sel={n.id === selected}
					class:old={!!n.m.supersededBy}
					transform="translate({n.x} {n.y})"
					role="button"
					tabindex="0"
					aria-label={n.m.content}
					onpointerdown={(e) => onDown(e, n.id)}
					onpointerenter={() => (hovered = n.id)}
					onpointerleave={() => (hovered = null)}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onselect(n.id === selected ? null : n.id);
						}
					}}
				>
					<circle r={n.r} fill={KIND_COLOR[n.m.kind] ?? 'var(--c-text-3)'} />
					{#if near.has(n.id) || view.k >= 1.6}
						<text y={-n.r - 4} text-anchor="middle">{short(n.m.content)}</text>
					{/if}
				</g>
			{/each}
		</g>
	</svg>
	<div class="legend">
		<span><i style:background="var(--c-info)"></i>사실</span>
		<span><i style:background="var(--c-done)"></i>선호</span>
		<span><i style:background="var(--c-waiting)"></i>일정·사건</span>
		<span><i style:background="var(--c-working)"></i>관계</span>
		<span class="ln">— 비슷한 내용</span>
		<span class="ln">┄ 함께 쓰임</span>
	</div>
</div>

<style>
	.wrap {
		position: relative;
		border: 1px solid var(--c-line);
		border-radius: var(--r-3);
		background: var(--c-surface-1);
		overflow: hidden;
	}
	svg {
		display: block;
		touch-action: none;
		cursor: grab;
		user-select: none;
	}
	svg:active {
		cursor: grabbing;
	}
	.link {
		stroke: var(--c-line-stronger);
		stroke-width: 1.2;
		transition: opacity var(--dur-fast) var(--ease);
	}
	.link.co_used {
		stroke-dasharray: 3 3;
	}
	.node {
		cursor: pointer;
		transition: opacity var(--dur-fast) var(--ease);
	}
	.node circle {
		stroke: var(--c-surface-1);
		stroke-width: 1.5;
	}
	.node.sel circle {
		stroke: var(--c-text);
		stroke-width: 2;
	}
	.node.old circle {
		opacity: 0.45;
	}
	.node:focus {
		outline: none; /* 키보드 포커스는 아래 원 테두리로 */
	}
	.node:focus-visible circle {
		stroke: var(--c-text);
	}
	.dim {
		opacity: 0.15;
	}
	text {
		fill: var(--c-text-2);
		font-size: 10px;
		pointer-events: none;
		paint-order: stroke;
		stroke: var(--c-surface-1);
		stroke-width: 3px;
	}
	.legend {
		position: absolute;
		left: var(--s-3);
		bottom: var(--s-2);
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-3);
		font-size: var(--t-xs);
		color: var(--c-text-3);
		pointer-events: none;
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.legend i {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
	}
</style>
