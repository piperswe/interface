// Base64-encode raw bytes. Built in chunks because spreading a large
// `Uint8Array` into `String.fromCharCode` blows the call stack
// (`Maximum call stack size exceeded`) on big files / payloads.

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}
