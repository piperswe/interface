// Test helper: narrow `T | null | undefined` to `T` while raising a clear
// error when the value is nullish. Use this in place of `value!.foo` after
// `expect(value).toBeDefined()` so the narrowing is explicit to TypeScript
// and Biome's `noNonNullAssertion` rule stays happy.
//
//   const row = await getThing();
//   assertDefined(row);
//   expect(row.id).toBe('x'); // no `!` needed
export function assertDefined<T>(value: T, message?: string): asserts value is NonNullable<T> {
	if (value === null || value === undefined) {
		throw new Error(message ?? 'Expected value to be defined');
	}
}
