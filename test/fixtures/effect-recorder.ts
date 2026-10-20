// Preload for trace-sink-lazy-replay.test.ts (`bun --preload <this> <script>`). The same recorder goal-host-vessel's
// import-effects test uses: every API through which a module can reach the network, start a process, open a listener or
// write a file is replaced BEFORE any other module loads; each call is RECORDED and then REFUSED (throws or rejects), so
// the code under test has no live effect even when it tries to. Writes to stdout/stderr pass; reads are not intercepted.
// The record is printed as ONE stderr line `EFFECTS <json>` on globalThis.__effectRecorder.report(outcome), or at exit.
/* eslint-disable @typescript-eslint/no-explicit-any */
const fsMod = require("node:fs") as Record<string, any>;
const fspMod = require("node:fs/promises") as Record<string, any>;
const realWriteSync = fsMod.writeSync.bind(fsMod) as (fd: number, s: string) => number;

interface Effect { kind: "net" | "write" | "spawn" | "listen"; api: string; target: string }
const effects: Effect[] = [];
const str = (x: unknown): string => {
  if (typeof x === "string") return x;
  if (x instanceof URL) return x.href;
  if (x && typeof x === "object" && "url" in (x as object)) return String((x as { url: unknown }).url);
  if (Array.isArray(x)) return x.map(String).join(" ");
  if (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string") return (x as { name: string }).name;
  try { return JSON.stringify(x) ?? String(x); } catch { return String(x); }
};
const refuse = (kind: Effect["kind"], api: string, target: unknown): Error => {
  effects.push({ kind, api, target: str(target).slice(0, 300) });
  return new Error(`effect-recorder: refused ${api} ${str(target).slice(0, 120)}`);
};
const syncRefuser = (kind: Effect["kind"], api: string) => (...a: any[]) => { throw refuse(kind, api, a[0]); };
const asyncRefuser = (kind: Effect["kind"], api: string) => (...a: any[]) => Promise.reject(refuse(kind, api, a[0]));
const cbRefuser = (kind: Effect["kind"], api: string) => (...a: any[]) => {
  const err = refuse(kind, api, a[0]);
  const cb = a.reverse().find((x) => typeof x === "function");
  if (cb) queueMicrotask(() => cb(err)); else throw err;
};
const set = (obj: any, name: string, fn: unknown): void => {
  if (!obj) return;
  try { obj[name] = fn; } catch { /* fall through */ }
  if (obj[name] !== fn) Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
};

// Network.
set(globalThis, "fetch", asyncRefuser("net", "fetch"));
set(globalThis, "WebSocket", function WebSocket(url: unknown) { throw refuse("net", "WebSocket", url); });
set(Bun, "connect", syncRefuser("net", "Bun.connect"));
set(Bun, "udpSocket", syncRefuser("net", "Bun.udpSocket"));
for (const m of ["node:net", "node:tls"]) {
  const mod = require(m) as Record<string, any>;
  for (const n of ["connect", "createConnection"]) set(mod, n, syncRefuser("net", `${m}.${n}`));
  if (mod.Socket?.prototype) set(mod.Socket.prototype, "connect", syncRefuser("net", `${m}.Socket.connect`));
  for (const n of ["createServer"]) set(mod, n, syncRefuser("listen", `${m}.${n}`));
}
for (const m of ["node:http", "node:https"]) {
  const mod = require(m) as Record<string, any>;
  for (const n of ["request", "get"]) set(mod, n, syncRefuser("net", `${m}.${n}`));
  set(mod, "createServer", syncRefuser("listen", `${m}.createServer`));
}
// Listeners.
set(Bun, "serve", syncRefuser("listen", "Bun.serve"));
set(Bun, "listen", syncRefuser("listen", "Bun.listen"));
// Processes.
set(Bun, "spawn", syncRefuser("spawn", "Bun.spawn"));
set(Bun, "spawnSync", syncRefuser("spawn", "Bun.spawnSync"));
set(Bun, "$", syncRefuser("spawn", "Bun.$"));
{
  const cp = require("node:child_process") as Record<string, any>;
  for (const n of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) set(cp, n, syncRefuser("spawn", `child_process.${n}`));
}
// Writes: Bun.write, BunFile write methods, node:fs (sync, callback, promises).
{
  const realWrite = Bun.write.bind(Bun), out = Bun.stdout, err = Bun.stderr;
  set(Bun, "write", (dest: unknown, ...a: any[]) => dest === out || dest === err || dest === 1 || dest === 2 ? (realWrite as any)(dest, ...a) : Promise.reject(refuse("write", "Bun.write", dest)));
}
{
  const realFile = Bun.file.bind(Bun);
  set(Bun, "file", (p: unknown, o?: unknown) => {
    const f = realFile(p as string, o as never) as any;
    if (isStdio(p)) return f;
    for (const n of ["write", "writer", "delete", "unlink"]) {
      try { set(f, n, n === "writer" ? syncRefuser("write", `BunFile.${n}`).bind(null, p) : asyncRefuser("write", `BunFile.${n}`).bind(null, p)); } catch { /* immutable */ }
    }
    return f;
  });
}
const WRITE_FNS = ["writeFile", "appendFile", "mkdir", "mkdtemp", "rename", "unlink", "rm", "rmdir", "copyFile", "cp", "symlink", "link", "truncate", "utimes", "chmod", "chown"];
const isWriteFlag = (flags: unknown): boolean => typeof flags === "number" ? (flags & 3) !== 0 || (flags & 64) !== 0 : typeof flags === "string" && /[wa+]/.test(flags);
const isStdio = (fd: unknown): boolean => fd === 1 || fd === 2;
for (const n of WRITE_FNS) {
  set(fsMod, `${n}Sync`, syncRefuser("write", `fs.${n}Sync`));
  set(fsMod, n, cbRefuser("write", `fs.${n}`));
  set(fspMod, n, asyncRefuser("write", `fs/promises.${n}`));
}
if (fsMod.promises && fsMod.promises !== fspMod) for (const n of WRITE_FNS) set(fsMod.promises, n, asyncRefuser("write", `fs.promises.${n}`));
{
  const realW = fsMod.write, realWS = fsMod.writeSync, realOpen = fsMod.open, realOpenSync = fsMod.openSync, realPOpen = fspMod.open;
  set(fsMod, "writeSync", (fd: unknown, ...a: any[]) => { if (isStdio(fd)) return realWS(fd, ...a); throw refuse("write", "fs.writeSync", `fd ${String(fd)}`); });
  set(fsMod, "write", (fd: unknown, ...a: any[]) => { if (isStdio(fd)) return realW(fd, ...a); return cbRefuser("write", "fs.write")(`fd ${String(fd)}`, ...a); });
  set(fsMod, "openSync", (p: unknown, flags?: unknown, ...a: any[]) => { if (isWriteFlag(flags)) throw refuse("write", "fs.openSync", p); return realOpenSync(p, flags, ...a); });
  set(fsMod, "open", (p: unknown, flags?: unknown, ...a: any[]) => { if (isWriteFlag(flags)) return cbRefuser("write", "fs.open")(p, ...a); return realOpen(p, flags, ...a); });
  set(fspMod, "open", (p: unknown, flags?: unknown, ...a: any[]) => { if (isWriteFlag(flags)) return Promise.reject(refuse("write", "fs/promises.open", p)); return realPOpen(p, flags, ...a); });
  set(fsMod, "createWriteStream", syncRefuser("write", "fs.createWriteStream"));
}

let reported = false;
function report(outcome: string, err?: unknown): void {
  if (reported) return;
  reported = true;
  const error = err === undefined ? undefined : String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 400);
  realWriteSync(2, `EFFECTS ${JSON.stringify({ outcome, error, effects })}\n`);
}
(globalThis as any).__effectRecorder = { report, effects };
process.on("exit", () => report("exit"));
