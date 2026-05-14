// `Map` / `Set` subclasses with a hard size cap. When an insert would push
// the collection past `maxSize`, the oldest entry (by insertion order) is
// evicted first — a cheap FIFO bound that keeps long-lived Worker isolates
// from accumulating per-isolate caches indefinitely.
//
// Several modules kept hand-rolling this same eviction snippet
// (`if (size >= MAX) delete(keys().next().value)`); centralising it here
// removes that duplication and the off-by-one risk that comes with it.

export class BoundedMap<K, V> extends Map<K, V> {
	readonly #maxSize: number;

	constructor(maxSize: number) {
		super();
		this.#maxSize = maxSize;
	}

	set(key: K, value: V): this {
		if (!this.has(key) && this.size >= this.#maxSize) {
			const oldest = this.keys().next().value;
			if (oldest !== undefined) this.delete(oldest);
		}
		return super.set(key, value);
	}
}

export class BoundedSet<T> extends Set<T> {
	readonly #maxSize: number;

	constructor(maxSize: number) {
		super();
		this.#maxSize = maxSize;
	}

	add(value: T): this {
		if (!this.has(value) && this.size >= this.#maxSize) {
			const oldest = this.values().next().value;
			if (oldest !== undefined) this.delete(oldest);
		}
		return super.add(value);
	}
}
