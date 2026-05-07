// Typed wrapper around `SqlStorage.exec(...).toArray()`. The DO SQL API
// returns `SqlStorageValue[]` rows that the call site immediately re-casts
// to a row-shape interface. Centralising the double-cast (`as unknown as
// T[]`) keeps the noise out of every query and gives readers one place to
// reason about row typing.
//
// This is *not* a runtime validator. The cast asserts the row shape; the
// caller is responsible for matching the SELECT columns to T.
export function execRows<T>(sql: SqlStorage, query: string, ...bindings: SqlStorageValue[]): T[] {
	return sql.exec(query, ...bindings).toArray() as unknown as T[];
}
