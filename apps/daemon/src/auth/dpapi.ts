// Windows DPAPI (crypt32!CryptProtectData / CryptUnprotectData) — bun:ffi. 현재 사용자만 복호화할 수 있다.
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
// 다른 앱이 같은 사용자 권한으로 이 파일을 복호화하려면 이 값도 알아야 한다 (비밀은 아님 — 우발적 재사용 방지)
const ENTROPY = new TextEncoder().encode("PROPRIX-credentials-v1");

const crypt32 = dlopen("crypt32.dll", {
  CryptProtectData: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  CryptUnprotectData: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
});
const kernel32 = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } });

// DATA_BLOB (x64): DWORD cbData; [4바이트 패딩]; BYTE* pbData
function blob(data: Uint8Array): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(data.length, 0);
  if (data.length > 0) b.writeBigUInt64LE(BigInt(ptr(data)), 8);
  return b;
}

function takeBlob(out: Buffer): Uint8Array {
  const size = out.readUInt32LE(0);
  const p = Number(out.readBigUInt64LE(8));
  if (p === 0) return new Uint8Array(0);
  const copy = new Uint8Array(toArrayBuffer(p as never, 0, size)).slice();
  new Uint8Array(toArrayBuffer(p as never, 0, size)).fill(0);
  kernel32.symbols.LocalFree(p as never);
  return copy;
}

function call(fn: "CryptProtectData" | "CryptUnprotectData", input: Uint8Array): Uint8Array | null {
  if (input.length === 0) return null; // 빈 버퍼는 포인터를 만들 수 없다 (저장할 자격 증명은 항상 비어 있지 않음)
  const inBlob = blob(input);
  const entropy = blob(ENTROPY);
  const out = Buffer.alloc(16);
  const ok = crypt32.symbols[fn](ptr(inBlob), null, ptr(entropy), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(out));
  if (!ok) return null;
  return takeBlob(out);
}

export const dpapi = {
  seal(plain: Uint8Array): Uint8Array {
    const sealed = call("CryptProtectData", plain);
    if (!sealed) throw new Error("CryptProtectData 실패");
    return sealed;
  },
  open(sealed: Uint8Array): Uint8Array | null {
    return call("CryptUnprotectData", sealed);
  },
};
