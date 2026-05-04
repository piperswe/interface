// Indirection over `Date.now()` and `crypto.randomUUID()` so tests can pin
// time and ID generation. Production paths import the singletons; tests can
// either swap in their own implementations via `setClock` / `setUuidSource`
// or temporarily override and restore via `withClock` / `withUuidSource`.

export type Clock = () => number;
export type UuidSource = () => string;

let _now: Clock = () => Date.now();
let _uuid: UuidSource = () => crypto.randomUUID();

export function now(): number {
	return _now();
}

export function uuid(): string {
	return _uuid();
}

export function setClock(fn: Clock | null): void {
	_now = fn ?? (() => Date.now());
}

export function setUuidSource(fn: UuidSource | null): void {
	_uuid = fn ?? (() => crypto.randomUUID());
}
