import { expect, test } from "bun:test";
import { checkUrl } from "./policy";
import { fetchRobots, RobotsCache } from "./robots";

const publicIp = async () => ["8.8.8.8"];
const check = (u: string) => checkUrl(u, [], publicIp);

function server(routes: Record<string, () => Response>) {
  const hits: string[] = [];
  const raw = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    const url = String(input);
    hits.push(url);
    return routes[url]?.() ?? new Response("없음", { status: 404 });
  }) as typeof fetch;
  return { hits, raw };
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

test("robots.txt 리다이렉트: 공개 주소는 따라가고, 내부 주소로는 요청하지 않는다", async () => {
  const ok = server({
    "https://a.example/robots.txt": redirect("/moved.txt"),
    "https://a.example/moved.txt": () => new Response("User-agent: *\nDisallow: /x"),
  });
  const res = await fetchRobots("https://a.example/robots.txt", ok.raw, check);
  expect(await res.text()).toContain("Disallow");

  for (const target of ["http://127.0.0.1:47810/api/health", "http://[::ffff:7f00:1]/", "file:///c:/x"]) {
    const bad = server({ "https://a.example/robots.txt": redirect(target) });
    await expect(fetchRobots("https://a.example/robots.txt", bad.raw, check)).rejects.toThrow("리다이렉트 거부");
    expect(bad.hits).toEqual(["https://a.example/robots.txt"]);
  }
});

test("robots.txt 리다이렉트: 고리는 멈추고, 받지 못한 것으로 보아 거부한다", async () => {
  const loop = server({ "https://a.example/robots.txt": redirect("https://a.example/robots.txt") });
  await expect(fetchRobots("https://a.example/robots.txt", loop.raw, check)).rejects.toThrow("너무 많습니다");
  expect(loop.hits.length).toBe(6);

  const cache = new RobotsCache(() => fetchRobots("https://a.example/robots.txt", loop.raw, check));
  expect(await cache.allows(new URL("https://a.example/x"))).toBe(false);
});

test("robots.txt 를 받지 못하면: 4xx 는 허용, 5xx·429·네트워크 오류는 거부하고 5분 뒤 다시 확인한다", async () => {
  let now = 0;
  const allows = (status: number) =>
    new RobotsCache(
      async () => new Response("x", { status }),
      () => now,
    ).allows(new URL("https://a.example/x"));
  expect(await allows(404)).toBe(true);
  expect(await allows(403)).toBe(true);
  expect(await allows(500)).toBe(false);
  expect(await allows(503)).toBe(false);
  expect(await allows(429)).toBe(false);

  let down = true;
  let hits = 0;
  const cache = new RobotsCache(
    async () => {
      hits++;
      if (down) throw new Error("연결 실패");
      return new Response("User-agent: *\nDisallow: /secret");
    },
    () => now,
  );
  const page = new URL("https://a.example/x");
  expect(await cache.allows(page)).toBe(false);
  now += 4 * 60_000;
  expect(await cache.allows(page)).toBe(false);
  expect(hits).toBe(1);
  down = false;
  now += 2 * 60_000;
  expect(await cache.allows(page)).toBe(true);
  expect(hits).toBe(2);
  // 정상 응답은 1시간 캐시
  now += 30 * 60_000;
  expect(await cache.allows(new URL("https://a.example/secret"))).toBe(false);
  expect(hits).toBe(2);
});
