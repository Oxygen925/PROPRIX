// 리서치 수집 규칙 (P11a): 주소 검사·robots.txt
import { expect, test } from "bun:test";
import { checkUrl, checkUrlShape, domainMatches, isPrivateIp } from "./policy";
import { parseRobots, RobotsCache, robotsAllows } from "./robots";

test("사설·로컬 IP 판별 (v4·v6·매핑)", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.9.9",
    "192.168.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
  ])
    expect(isPrivateIp(ip)).toBe(true);
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1"]) expect(isPrivateIp(ip)).toBe(false);
  for (const ip of ["::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1", "ff02::1"]) expect(isPrivateIp(ip)).toBe(true);
  expect(isPrivateIp("2606:4700::1111")).toBe(false);
  // new URL 이 점 표기를 hex 로 바꾼 모양, IPv4 를 담는 대역
  for (const ip of [
    "::ffff:7f00:1",
    "::FFFF:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:1",
    "::ffff:0:7f00:1",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "2002:7f00:1::",
    "2001:0:1::1",
    "2001:db8::1",
    "fec0::1",
  ])
    expect(isPrivateIp(ip)).toBe(true);
  for (const ip of ["::ffff:808:808", "64:ff9b::808:808", "2002:808:808::", "2001:4860:4860::8888"])
    expect(isPrivateIp(ip)).toBe(false);
  for (const url of ["http://[::ffff:127.0.0.1]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/"])
    expect(checkUrlShape(url, [])).toEqual({ ok: false, reason: "private" });
});

test("주소 모양: http(s) 만, localhost·IP 리터럴·자격 증명·차단 도메인(하위 포함)", () => {
  expect(checkUrlShape("https://example.com/a", []).ok).toBe(true);
  expect(checkUrlShape("file:///C:/x", [])).toMatchObject({ ok: false, reason: "scheme" });
  expect(checkUrlShape("http://localhost:3000", [])).toMatchObject({ ok: false, reason: "private" });
  expect(checkUrlShape("http://[::1]/", [])).toMatchObject({ ok: false, reason: "private" });
  expect(checkUrlShape("http://192.168.0.10/", [])).toMatchObject({ ok: false, reason: "private" });
  expect(checkUrlShape("https://user:pw@example.com/", [])).toMatchObject({ ok: false, reason: "invalid" });
  expect(checkUrlShape("https://news.bad.example/x", ["bad.example"])).toMatchObject({ ok: false, reason: "denied" });
  expect(domainMatches("notbad.example", ["bad.example"])).toBe(false);
});

test("DNS 로 푼 IP 가 사설망이면 막는다 (하나라도)", async () => {
  const resolve = async (host: string) => (host === "inside.test" ? ["93.184.216.34", "10.0.0.5"] : ["93.184.216.34"]);
  expect((await checkUrl("https://ok.test/", [], resolve)).ok).toBe(true);
  expect(await checkUrl("https://inside.test/", [], resolve)).toMatchObject({ ok: false, reason: "private" });
  expect(await checkUrl("https://nx.test/", [], async () => [])).toMatchObject({ ok: false, reason: "private" });
});

test("robots.txt: 우리 묶음 우선, 가장 긴 규칙, 같으면 Allow, * 와 $", () => {
  const rules = parseRobots(
    [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: PROPRIX-Research",
      "Disallow: /private",
      "Allow: /private/ok",
      "Disallow: /*.pdf$",
    ].join("\n"),
  );
  expect(robotsAllows(rules, "/")).toBe(true);
  expect(robotsAllows(rules, "/private/x")).toBe(false);
  expect(robotsAllows(rules, "/private/ok/1")).toBe(true);
  expect(robotsAllows(rules, "/doc.pdf")).toBe(false);
  expect(robotsAllows(rules, "/doc.pdf?x=1")).toBe(true);
  const star = parseRobots("User-agent: *\nDisallow: /admin\nDisallow:\n");
  expect(robotsAllows(star, "/admin/a")).toBe(false);
  expect(robotsAllows(star, "/blog")).toBe(true);
});

test("robots.txt: 네트워크 오류는 거부, 없으면(404) 허용, 받으면 호스트별로 캐시", async () => {
  let calls = 0;
  const cache = new RobotsCache(async (url) => {
    calls++;
    if (url.startsWith("https://down.test")) throw new Error("network");
    if (url.startsWith("https://missing.test")) return new Response("", { status: 404 });
    return new Response("User-agent: *\nDisallow: /no\n");
  });
  expect(await cache.allows(new URL("https://down.test/a"))).toBe(false);
  expect(await cache.allows(new URL("https://missing.test/no"))).toBe(true);
  expect(await cache.allows(new URL("https://site.test/no"))).toBe(false);
  expect(await cache.allows(new URL("https://site.test/yes"))).toBe(true);
  expect(calls).toBe(3);
});
