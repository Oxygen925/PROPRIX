// 페르소나 표정 묶음 (M2, 사용자 결정 2026-10-31): zip 안의 character.json 이 표정과 이미지 파일을 잇는다.
// DB 를 쓰지 않고 <dataDir>/characters/<페르소나 id>/ 에만 둔다. 파일 이름은 받은 그대로 쓰지 않고 새로 정한다 (경로 탈출 방지).
// 일일 백업(.sqlite)에는 들어가지 않으므로 원본 zip 을 함께 두어 내보낼 수 있게 한다
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHARACTER_FORMAT,
  CHARACTER_LIMITS,
  CHARACTER_MANIFEST,
  CharacterManifest,
  type CharacterPack,
} from "@proprix/shared";
import { MB, parseManifest, readPackZip, replaceFolder } from "../storage/pack";

export class CharacterError extends Error {}

// 내용으로 형식을 본다 (확장자는 믿지 않는다). svg 등은 여기서 걸러진다
export function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  const text = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

interface Stored {
  version: string;
  thumbnail: string;
  expressions: Record<string, string[]>; // 표정 → 저장한 파일 이름
}

// zip 을 검증해 저장할 내용으로. 쓰는 이미지만 남긴다
export function parsePack(zip: Uint8Array): { stored: Stored; images: Map<string, Uint8Array> } {
  const files = readPackZip(zip, CHARACTER_MANIFEST, CHARACTER_LIMITS, CharacterError);
  const manifest = parseManifest(files, {
    manifest: CHARACTER_MANIFEST,
    format: CHARACTER_FORMAT,
    schema: CharacterManifest,
    Err: CharacterError,
    precheck: (json) => {
      const kind = (json as { kind?: unknown } | null)?.kind;
      if (kind === "live2d") throw new CharacterError("Live2D 묶음은 아직 지원하지 않습니다");
    },
  });
  const images = new Map<string, Uint8Array>();
  const saved = new Map<string, string>(); // zip 안 이름 → 저장 이름
  let total = 0;
  const take = (name: string): string => {
    const known = saved.get(name);
    if (known) return known;
    const bytes = files.get(name);
    if (!bytes) throw new CharacterError(`zip 에 없는 파일입니다: ${name.slice(0, 80)}`);
    if (bytes.length > CHARACTER_LIMITS.fileBytes)
      throw new CharacterError(`이미지 하나는 ${MB(CHARACTER_LIMITS.fileBytes)} 까지입니다: ${name.slice(0, 80)}`);
    const type = sniffImage(bytes);
    if (!type) throw new CharacterError(`png·jpeg·webp 이미지만 쓸 수 있습니다: ${name.slice(0, 80)}`);
    total += bytes.length;
    if (total > CHARACTER_LIMITS.imagesBytes)
      throw new CharacterError(`이미지 전체는 ${MB(CHARACTER_LIMITS.imagesBytes)} 까지입니다`);
    const stored = `${saved.size}.${type.ext}`;
    saved.set(name, stored);
    images.set(stored, bytes);
    return stored;
  };
  const expressions: Record<string, string[]> = {};
  for (const [mood, value] of Object.entries(manifest.expressions)) {
    const list = typeof value === "string" ? [value] : value;
    expressions[mood] = list.map(take);
  }
  const thumbnail = manifest.thumbnail ? take(manifest.thumbnail) : "";
  return { stored: { version: crypto.randomUUID(), thumbnail, expressions }, images };
}

const PACK = "pack.json";
const SOURCE = "source.zip";

export class CharacterStore {
  private readonly versions = new Map<string, string | null>();

  constructor(private readonly dir: string) {}

  private folder(personaId: string) {
    return join(this.dir, personaId);
  }

  private stored(personaId: string): Stored | null {
    try {
      return JSON.parse(readFileSync(join(this.folder(personaId), PACK), "utf8")) as Stored;
    } catch {
      return null;
    }
  }

  // 묶음이 있으면 버전 (없으면 null). 페르소나 목록마다 불리므로 기억해 둔다
  version(personaId: string): string | null {
    const known = this.versions.get(personaId);
    if (known !== undefined) return known;
    const v = this.stored(personaId)?.version ?? null;
    this.versions.set(personaId, v);
    return v;
  }

  // 검증을 통과해야만 바꾼다. 임시 폴더에 다 쓴 뒤 옮겨 실패해도 이전 묶음이 남는다
  save(personaId: string, zip: Uint8Array): string {
    const { stored, images } = parsePack(zip);
    replaceFolder(this.dir, this.folder(personaId), (tmp) => {
      for (const [name, bytes] of images) writeFileSync(join(tmp, name), bytes);
      writeFileSync(join(tmp, SOURCE), zip);
      writeFileSync(join(tmp, PACK), JSON.stringify(stored));
    });
    this.versions.set(personaId, stored.version);
    return stored.version;
  }

  // 화면에 줄 내용 (이미지는 data URL: 앱 창의 <img> 는 인증 헤더를 보낼 수 없다)
  pack(personaId: string): CharacterPack | null {
    const s = this.stored(personaId);
    if (!s) return null;
    const url = (name: string) => {
      const bytes = readFileSync(join(this.folder(personaId), name));
      return `data:${sniffImage(bytes)?.mime ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
    };
    return {
      version: s.version,
      thumbnail: s.thumbnail ? url(s.thumbnail) : "",
      expressions: Object.fromEntries(Object.entries(s.expressions).map(([m, names]) => [m, names.map(url)])),
    };
  }

  source(personaId: string): Uint8Array | null {
    const p = join(this.folder(personaId), SOURCE);
    return existsSync(p) ? readFileSync(p) : null;
  }

  remove(personaId: string): boolean {
    const had = existsSync(this.folder(personaId));
    rmSync(this.folder(personaId), { recursive: true, force: true });
    this.versions.set(personaId, null);
    return had;
  }
}
