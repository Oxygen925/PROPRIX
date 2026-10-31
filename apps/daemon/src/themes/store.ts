// 테마 묶음 (docs/theme-pack.md, 사용자 결정 2026-10-31): 앱 본체는 불러오는 기능만 갖고 테마는 따로 배포한다.
// CSS 를 받으므로 외부 주소·@import 등을 막고, url() 은 묶음 안의 파일만 data URL 로 바꿔 넣는다.
// DB 를 쓰지 않고 <dataDir>/themes/<테마 id>/ 에 둔다
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  THEME_FORMAT,
  THEME_LIMITS,
  THEME_MANIFEST,
  type ThemeBundle,
  type ThemeInfo,
  ThemeManifest,
} from "@proprix/shared";
import { MB, parseManifest, readPackZip, replaceFolder } from "../storage/pack";

export class ThemeError extends Error {}

const short = (s: string) => s.slice(0, 80);

// 내용으로 형식을 본다 (확장자는 믿지 않는다)
export function sniffAsset(b: Uint8Array): string | null {
  const text = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && text(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (text(0, 4) === "wOF2") return "font/woff2";
  if (text(0, 4) === "wOFF") return "font/woff";
  if (text(0, 4) === "OTTO") return "font/otf";
  if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return "font/ttf";
  const svg = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 200_000)));
  // 이미지로만 쓰이지만 스크립트·외부 참조가 든 svg 는 받지 않는다
  if (
    /<svg[\s>]/i.test(svg) &&
    !/<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/i.test(svg)
  )
    return "image/svg+xml";
  return null;
}

const FORBIDDEN: [RegExp, string][] = [
  [/\\/, "역슬래시 이스케이프"],
  [/@import|@namespace/i, "@import"],
  [/:\/\/|\bjavascript:|\bdata:/i, "외부 주소"],
  [/expression\s*\(|behavior\s*:|-moz-binding/i, "실행 구문"],
  [/image-set\s*\(|\bimage\s*\(|\bsrc\s*\(/i, "image()·image-set·src()"],
  [/<\/?style/i, "<style>"],
];

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// CSS 를 검사하고 url() 을 묶음 안 파일의 data URL 로 바꾼다
export function bundleCss(css: string, cssPath: string, files: ReadonlyMap<string, Uint8Array>): string {
  const clean = stripComments(css);
  for (const [re, what] of FORBIDDEN)
    if (re.test(clean)) throw new ThemeError(`${short(cssPath)}: 쓸 수 없는 CSS 입니다 (${what})`);
  const dir = cssPath.includes("/") ? cssPath.slice(0, cssPath.lastIndexOf("/") + 1) : "";
  const bundled = clean.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_, __, raw: string) => {
    const ref = raw.trim();
    if (ref.startsWith("#")) return `url(${ref})`; // svg 안 참조
    const name = (dir + ref)
      .split("/")
      .reduce<string[]>((parts, p) => {
        if (p === "..") parts.pop();
        else if (p !== ".") parts.push(p);
        return parts;
      }, [])
      .join("/");
    const bytes = files.get(name);
    if (!bytes) throw new ThemeError(`zip 에 없는 파일입니다: ${short(ref)}`);
    const mime = sniffAsset(bytes);
    if (!mime) throw new ThemeError(`이미지·글꼴만 쓸 수 있습니다: ${short(ref)}`);
    if (bytes.length > THEME_LIMITS.fileBytes)
      throw new ThemeError(`파일 하나는 ${MB(THEME_LIMITS.fileBytes)} 까지입니다: ${short(ref)}`);
    return `url("data:${mime};base64,${Buffer.from(bytes).toString("base64")}")`;
  });
  // 위 치환을 피한 url() (따옴표 안의 괄호 등)은 바깥 요청이 될 수 있다
  if (/url\(\s*(?!["']?(?:data:|#))/i.test(bundled))
    throw new ThemeError(`${short(cssPath)}: 쓸 수 없는 CSS 입니다 (url)`);
  return bundled;
}

// zip 을 검증해 화면에 줄 내용으로
export function parseTheme(zip: Uint8Array): ThemeBundle {
  const files = readPackZip(zip, THEME_MANIFEST, THEME_LIMITS, ThemeError);
  const m = parseManifest(files, {
    manifest: THEME_MANIFEST,
    format: THEME_FORMAT,
    schema: ThemeManifest,
    Err: ThemeError,
  });
  const css = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new ThemeError(`zip 에 없는 파일입니다: ${short(path)}`);
    return bundleCss(new TextDecoder().decode(bytes), path, files);
  };
  return {
    id: m.id,
    name: m.name,
    notice: m.notice,
    stage: m.stage,
    labels: m.labels,
    version: crypto.randomUUID(),
    css: css(m.css),
    fontCss: m.fontCss ? css(m.fontCss) : "",
  };
}

const BUNDLE = "bundle.json";
const SOURCE = "source.zip";
const info = ({ id, name, notice, stage, labels, version }: ThemeBundle): ThemeInfo => ({
  id,
  name,
  notice,
  stage,
  labels,
  version,
});

export class ThemeStore {
  constructor(private readonly dir: string) {}

  private folder(id: string) {
    return join(this.dir, id);
  }

  bundle(id: string): ThemeBundle | null {
    try {
      return JSON.parse(readFileSync(join(this.folder(id), BUNDLE), "utf8")) as ThemeBundle;
    } catch {
      return null;
    }
  }

  list(): ThemeInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((id) => !id.startsWith("."))
      .flatMap((id) => {
        const b = this.bundle(id);
        return b ? [info(b)] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // 검증을 통과해야만 바꾼다. 임시 폴더에 다 쓴 뒤 옮겨 실패해도 이전 테마가 남는다
  save(zip: Uint8Array): ThemeInfo {
    const bundle = parseTheme(zip);
    replaceFolder(this.dir, this.folder(bundle.id), (tmp) => {
      writeFileSync(join(tmp, BUNDLE), JSON.stringify(bundle));
      writeFileSync(join(tmp, SOURCE), zip);
    });
    return info(bundle);
  }

  remove(id: string): boolean {
    const had = existsSync(this.folder(id));
    rmSync(this.folder(id), { recursive: true, force: true });
    return had;
  }
}
