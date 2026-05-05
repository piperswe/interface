const PING_INTERVAL_MS = 25_000;

type Sub = {
	controller: ReadableStreamDefaultController<Uint8Array>;
	nextId: number;
};

// Manages the set of live SSE subscribers for one DO. Holds the encoder, the
// keep-alive interval, and the helpers that pack/send SSE frames. The DO
// constructs one of these and threads it into the generation loop via
// `broadcast`.
export class SubscriberSet {
	#subs = new Set<Sub>();
	#encoder = new TextEncoder();
	#pingInterval: ReturnType<typeof setInterval> | null = null;

	get size(): number {
		return this.#subs.size;
	}

	add(sub: Sub): void {
		this.#subs.add(sub);
		this.#startPingIfNeeded();
	}

	delete(sub: Sub): void {
		this.#subs.delete(sub);
		this.#stopPingIfEmpty();
	}

	encode(s: string): Uint8Array {
		return this.#encoder.encode(s);
	}

	#sseFrame(event: string, data: unknown, id?: number): Uint8Array {
		const idLine = id != null ? `id: ${id}\n` : '';
		return this.#encoder.encode(`event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
	}

	enqueueTo(sub: Sub, event: string, data: unknown): boolean {
		try {
			const id = sub.nextId++;
			sub.controller.enqueue(this.#sseFrame(event, data, id));
			return true;
		} catch {
			this.#subs.delete(sub);
			return false;
		}
	}

	broadcast(event: string, data: unknown): void {
		if (this.#subs.size === 0) return;
		const dead: Sub[] = [];
		for (const sub of this.#subs) {
			try {
				const id = sub.nextId++;
				sub.controller.enqueue(this.#sseFrame(event, data, id));
			} catch {
				dead.push(sub);
			}
		}
		for (const c of dead) this.#subs.delete(c);
		this.#stopPingIfEmpty();
	}

	closeAll(): void {
		for (const sub of this.#subs) {
			try {
				sub.controller.close();
			} catch {
				/* ignore */
			}
		}
		this.#subs.clear();
		this.#stopPingIfEmpty();
	}

	#startPingIfNeeded(): void {
		if (this.#pingInterval || this.#subs.size === 0) return;
		const frame = this.#encoder.encode(`: ping\n\n`);
		this.#pingInterval = setInterval(() => {
			if (this.#subs.size === 0) {
				this.#stopPingIfEmpty();
				return;
			}
			const dead: Sub[] = [];
			for (const sub of this.#subs) {
				try {
					sub.controller.enqueue(frame);
				} catch {
					dead.push(sub);
				}
			}
			for (const c of dead) this.#subs.delete(c);
			this.#stopPingIfEmpty();
		}, PING_INTERVAL_MS);
	}

	#stopPingIfEmpty(): void {
		if (this.#subs.size === 0 && this.#pingInterval) {
			clearInterval(this.#pingInterval);
			this.#pingInterval = null;
		}
	}
}
