// 페이지 안에서 돌리는 본문 추출 (P11a): Readability 로 본문을 고르고 간단한 마크다운(제목·문단·목록·인용·표)과
// 본문 안의 링크 목록으로 바꾼다. daemon 은 DOM 타입이 없어 페이지 쪽 코드는 글자로 둔다
import READABILITY from "@mozilla/readability/Readability.js" with { type: "text" };

export interface Extracted {
  title: string;
  byline: string;
  published: string;
  text: string;
  links: { url: string; text: string }[];
}

const SCRIPT = `(function (max) {
  function clean(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
  function abs(h) { try { return new URL(h, location.href).href.split('#')[0]; } catch (e) { return ''; } }
  var art = null;
  try { art = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse(); } catch (e) {}
  var root;
  if (art && art.content) { root = document.createElement('div'); root.innerHTML = art.content; }
  else { root = document.body || document.documentElement; }
  var out = [], links = [], seen = {};
  function link(a) {
    var u = abs(a.getAttribute('href'));
    if (!/^https?:/.test(u) || seen[u]) return;
    seen[u] = 1;
    links.push({ url: u, text: clean(a.textContent).slice(0, 120) });
  }
  function links_in(el) { if (el.querySelectorAll) el.querySelectorAll('a[href]').forEach(link); }
  function walk(el) {
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      var t = c.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|NAV|FOOTER|FORM|BUTTON|IFRAME|ASIDE)$/.test(t)) continue;
      if (/^H[1-6]$/.test(t)) { var h = clean(c.textContent); if (h) out.push('#'.repeat(+t[1]) + ' ' + h); links_in(c); continue; }
      if (t === 'P' || t === 'PRE') { var p = clean(c.textContent); if (p) out.push(p); links_in(c); continue; }
      if (t === 'BLOCKQUOTE') { var q = clean(c.textContent); if (q) out.push('> ' + q); links_in(c); continue; }
      if (t === 'LI') { var l = clean(c.textContent); if (l) out.push('- ' + l); links_in(c); continue; }
      if (t === 'TR') { var cells = []; c.querySelectorAll('th,td').forEach(function (d) { cells.push(clean(d.textContent)); }); if (cells.length) out.push('| ' + cells.join(' | ') + ' |'); continue; }
      if (t === 'A') link(c);
      walk(c);
    }
  }
  walk(root);
  var md = out.join('\\n\\n');
  // 문단 태그 없이 글이 놓인 페이지
  if (md.length < 200) md = clean(root.innerText || root.textContent);
  return {
    title: clean((art && art.title) || document.title),
    byline: clean(art && art.byline),
    published: clean(art && art.publishedTime),
    text: md.slice(0, max),
    links: links.slice(0, 200)
  };
})`;

export const TEXT_MAX = 30_000;

// Runtime.evaluate 에 넣을 식: Readability 를 정의하고 추출을 부른다
export const extractExpression = (max = TEXT_MAX) => `${READABILITY}\n;${SCRIPT}(${max})`;
