import * as ynab from 'ynab';
import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

// Zod schemas for validating LLM-supplied tool arguments. The JSON
// schema declared on each Tool's `definition.inputSchema` is what the
// LLM sees; these run on the parsed JSON it produces.
const listBudgetsArgs = z.object({ include_accounts: z.boolean().optional() });
const budgetOnlyArgs = z.object({ budget_id: z.string() });
const listCategoriesArgs = z.object({
	budget_id: z.string(),
	include_hidden: z.boolean().optional(),
});
const getMonthArgs = z.object({ budget_id: z.string(), month: z.string() });
const listTransactionsArgs = z.object({
	account_id: z.string().optional(),
	budget_id: z.string(),
	category_id: z.string().optional(),
	limit: z.number().optional(),
	payee_id: z.string().optional(),
	since_date: z.string().optional(),
	type: z.enum(['uncategorized', 'unapproved']).optional(),
});
const cleared = z.enum(['cleared', 'uncleared', 'reconciled']);
const flagColor = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
const createTransactionArgs = z.object({
	account_id: z.string(),
	amount: z.number().optional(),
	amount_milliunits: z.number().optional(),
	approved: z.boolean().optional(),
	budget_id: z.string(),
	category_id: z.string().optional(),
	cleared: cleared.optional(),
	date: z.string().optional(),
	flag_color: flagColor.optional(),
	import_id: z.string().optional(),
	memo: z.string().optional(),
	payee_id: z.string().optional(),
	payee_name: z.string().optional(),
});
const updateTransactionArgs = z.object({
	account_id: z.string().optional(),
	amount: z.number().optional(),
	amount_milliunits: z.number().optional(),
	approved: z.boolean().optional(),
	budget_id: z.string(),
	category_id: z.string().optional(),
	cleared: cleared.optional(),
	date: z.string().optional(),
	flag_color: flagColor.optional(),
	memo: z.string().optional(),
	payee_id: z.string().optional(),
	payee_name: z.string().optional(),
	transaction_id: z.string(),
});
const updateMonthCategoryArgs = z.object({
	amount: z.number().optional(),
	amount_milliunits: z.number().optional(),
	budget_id: z.string(),
	category_id: z.string(),
	month: z.string(),
});

// YNAB amounts use "milliunits": 1000 milliunits == 1 unit of the plan's
// currency (so $1.23 == 1230). For 2-decimal currencies — the common case —
// we accept user-friendly decimals (e.g. -12.34) on writes and convert.
// Read tools surface the original milliunits plus pre-formatted strings the
// API returns so the model has both forms available.
const MILLIUNITS_PER_CURRENCY = 1000;

function decimalToMilliunits(amount: number): number {
	return Math.round(amount * MILLIUNITS_PER_CURRENCY);
}

function makeApi(token: string): ynab.api {
	return new ynab.API(token);
}

// On a non-2xx response the SDK awaits `response.json()` and throws the
// parsed body — typically `{ error: { id, name, detail } }` per YNAB's
// API spec. Surface those fields, falling back to generic Error handling.
function formatYnabError(e: unknown): string {
	if (e && typeof e === 'object' && 'error' in e) {
		const inner = (e as { error?: { id?: string; name?: string; detail?: string } }).error;
		if (inner) {
			const id = inner.id ?? '';
			const detail = inner.detail ?? inner.name ?? '';
			return `YNAB API error ${id}${detail ? `: ${detail}` : ''}`.trim();
		}
	}
	if (e instanceof ynab.ResponseError) {
		return `YNAB API ${e.response.status} ${e.response.statusText || ''}`.trim();
	}
	if (e instanceof Error) return e.message;
	return String(e);
}

async function call<T>(fn: () => Promise<T>): Promise<T | { __error: string }> {
	try {
		return await fn();
	} catch (e) {
		return { __error: formatYnabError(e) };
	}
}

function isError<T>(v: T | { __error: string }): v is { __error: string } {
	return typeof v === 'object' && v !== null && '__error' in (v as object);
}

function ok(content: unknown): ToolExecutionResult {
	return { content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) };
}

function err(message: string, errorCode: 'invalid_input' | 'execution_failure' = 'execution_failure'): ToolExecutionResult {
	return { content: message, errorCode, isError: true };
}

const BUDGET_ID_DESCRIPTION =
	'YNAB budget id (UUID). Pass "default" to use the default budget if enabled, or "last-used" for the most recently accessed budget.';

const budgetIdSchema = {
	description: BUDGET_ID_DESCRIPTION,
	type: 'string',
} as const;

// Trim accounts to the fields the model actually needs; full Account objects
// include a lot of debt/escrow detail that's noise for most prompts.
type SlimAccount = {
	id: string;
	name: string;
	type: string;
	on_budget: boolean;
	closed: boolean;
	balance_milliunits: number;
	cleared_balance_milliunits: number;
	uncleared_balance_milliunits: number;
	balance_formatted?: string;
	note?: string;
};

function slimAccount(a: ynab.Account): SlimAccount {
	return {
		balance_formatted: a.balance_formatted,
		balance_milliunits: a.balance,
		cleared_balance_milliunits: a.cleared_balance,
		closed: a.closed,
		id: a.id,
		name: a.name,
		note: a.note,
		on_budget: a.on_budget,
		type: a.type,
		uncleared_balance_milliunits: a.uncleared_balance,
	};
}

type SlimCategory = {
	id: string;
	name: string;
	category_group_name?: string;
	hidden: boolean;
	budgeted_milliunits: number;
	activity_milliunits: number;
	balance_milliunits: number;
	balance_formatted?: string;
	goal_type?: string | null;
	goal_target_milliunits?: number;
	goal_under_funded_milliunits?: number | null;
	note?: string;
};

function slimCategory(c: ynab.Category): SlimCategory {
	return {
		activity_milliunits: c.activity,
		balance_formatted: c.balance_formatted,
		balance_milliunits: c.balance,
		budgeted_milliunits: c.budgeted,
		category_group_name: c.category_group_name,
		goal_target_milliunits: c.goal_target,
		goal_type: c.goal_type ?? null,
		goal_under_funded_milliunits: c.goal_under_funded ?? null,
		hidden: c.hidden,
		id: c.id,
		name: c.name,
		note: c.note,
	};
}

type SlimTransaction = {
	id: string;
	date: string;
	amount_milliunits: number;
	amount_formatted?: string;
	memo?: string;
	cleared: string;
	approved: boolean;
	flag_color?: string | null;
	account_id: string;
	account_name: string;
	payee_id?: string;
	payee_name?: string | null;
	category_id?: string;
	category_name?: string | null;
	transfer_account_id?: string;
	import_id?: string;
	subtransactions?: Array<{
		id: string;
		amount_milliunits: number;
		memo?: string;
		payee_id?: string;
		category_id?: string;
		transfer_account_id?: string;
	}>;
};

// `getTransactionsByCategory` / `getTransactionsByPayee` return
// HybridTransactions instead of TransactionDetails — same fields minus
// `subtransactions` (each subtransaction comes back as its own row).
type AnyTransaction = ynab.TransactionDetail | ynab.HybridTransaction;

function slimTransaction(t: AnyTransaction): SlimTransaction {
	const subs = (t as ynab.TransactionDetail).subtransactions;
	return {
		account_id: t.account_id,
		account_name: t.account_name,
		amount_formatted: t.amount_formatted,
		amount_milliunits: t.amount,
		approved: t.approved,
		category_id: t.category_id,
		category_name: t.category_name ?? null,
		cleared: t.cleared,
		date: t.date,
		flag_color: t.flag_color ?? null,
		id: t.id,
		import_id: t.import_id,
		memo: t.memo,
		payee_id: t.payee_id,
		payee_name: t.payee_name ?? null,
		subtransactions: subs?.length
			? subs.map((s) => ({
					amount_milliunits: s.amount,
					category_id: s.category_id,
					id: s.id,
					memo: s.memo,
					payee_id: s.payee_id,
					transfer_account_id: s.transfer_account_id,
				}))
			: undefined,
		transfer_account_id: t.transfer_account_id,
	};
}

function listBudgetsTool(token: string): Tool {
	return {
		definition: {
			description:
				'List the YNAB budgets ("plans") accessible to the authenticated user. Returns id, name, last modified date, currency, and date format. Use this first to discover the budget id needed by other ynab_* tools.',
			inputSchema: {
				properties: {
					include_accounts: {
						description: "Include each budget's accounts in the response. Defaults to false to keep results compact.",
						type: 'boolean',
					},
				},
				type: 'object',
			},
			name: 'ynab_list_budgets',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(listBudgetsArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const api = makeApi(token);
			const result = await call(() => api.plans.getPlans(args.include_accounts ?? false));
			if (isError(result)) return err(result.__error);
			const budgets = result.data.plans.map((p) => ({
				accounts: args.include_accounts ? p.accounts?.map(slimAccount) : undefined,
				currency: p.currency_format ? { iso_code: p.currency_format.iso_code, symbol: p.currency_format.currency_symbol } : undefined,
				first_month: p.first_month,
				id: p.id,
				last_modified_on: p.last_modified_on,
				last_month: p.last_month,
				name: p.name,
			}));
			return ok({ budgets, default_budget_id: result.data.default_plan?.id });
		},
	};
}

function getUserTool(token: string): Tool {
	return {
		definition: {
			description:
				'Return information about the authenticated YNAB user (currently just the user id). Use this to verify the access token is working.',
			inputSchema: { properties: {}, type: 'object' },
			name: 'ynab_get_user',
		},
		async execute(): Promise<ToolExecutionResult> {
			const api = makeApi(token);
			const result = await call(() => api.user.getUser());
			if (isError(result)) return err(result.__error);
			return ok(result.data.user);
		},
	};
}

function listAccountsTool(token: string): Tool {
	return {
		definition: {
			description:
				'List all accounts in a YNAB budget, including balance and on/off-budget status. Balances are returned in milliunits (1000 milliunits = 1 unit of the budget currency).',
			inputSchema: {
				properties: { budget_id: budgetIdSchema },
				required: ['budget_id'],
				type: 'object',
			},
			name: 'ynab_list_accounts',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(budgetOnlyArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const api = makeApi(token);
			const result = await call(() => api.accounts.getAccounts(args.budget_id));
			if (isError(result)) return err(result.__error);
			return ok(result.data.accounts.map(slimAccount));
		},
	};
}

function listCategoriesTool(token: string): Tool {
	return {
		definition: {
			description:
				'List all categories in a YNAB budget grouped by category group, with current month assigned/activity/balance amounts in milliunits. Hidden and deleted groups are filtered out by default.',
			inputSchema: {
				properties: {
					budget_id: budgetIdSchema,
					include_hidden: {
						description: 'Include hidden category groups. Defaults to false.',
						type: 'boolean',
					},
				},
				required: ['budget_id'],
				type: 'object',
			},
			name: 'ynab_list_categories',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(listCategoriesArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const includeHidden = args.include_hidden ?? false;
			const api = makeApi(token);
			const result = await call(() => api.categories.getCategories(args.budget_id));
			if (isError(result)) return err(result.__error);
			const groups = result.data.category_groups
				.filter((g) => !g.deleted && (includeHidden || !g.hidden))
				.map((g) => ({
					categories: g.categories.filter((c) => !c.deleted && (includeHidden || !c.hidden)).map(slimCategory),
					hidden: g.hidden,
					id: g.id,
					name: g.name,
				}));
			return ok(groups);
		},
	};
}

function getMonthTool(token: string): Tool {
	return {
		definition: {
			description:
				'Get a single budget month, including totals (income, budgeted, activity, to-be-budgeted) and per-category amounts for that month. The month is specified in ISO format (YYYY-MM-01) or "current" for the current month.',
			inputSchema: {
				properties: {
					budget_id: budgetIdSchema,
					month: {
						description: 'Month in YYYY-MM-01 format, or "current" for the current month.',
						type: 'string',
					},
				},
				required: ['budget_id', 'month'],
				type: 'object',
			},
			name: 'ynab_get_month',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(getMonthArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const api = makeApi(token);
			const result = await call(() => api.months.getPlanMonth(args.budget_id, args.month));
			if (isError(result)) return err(result.__error);
			const m = result.data.month;
			return ok({
				activity_milliunits: m.activity,
				age_of_money: m.age_of_money,
				budgeted_milliunits: m.budgeted,
				categories: m.categories.filter((c) => !c.deleted).map(slimCategory),
				income_milliunits: m.income,
				month: m.month,
				note: m.note,
				to_be_budgeted_milliunits: m.to_be_budgeted,
			});
		},
	};
}

function listPayeesTool(token: string): Tool {
	return {
		definition: {
			description: 'List all payees in a YNAB budget. Useful when you need a payee_id to assign to a transaction.',
			inputSchema: {
				properties: { budget_id: budgetIdSchema },
				required: ['budget_id'],
				type: 'object',
			},
			name: 'ynab_list_payees',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(budgetOnlyArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const api = makeApi(token);
			const result = await call(() => api.payees.getPayees(args.budget_id));
			if (isError(result)) return err(result.__error);
			const payees = result.data.payees
				.filter((p) => !p.deleted)
				.map((p) => ({
					id: p.id,
					name: p.name,
					transfer_account_id: p.transfer_account_id ?? null,
				}));
			return ok(payees);
		},
	};
}

function listTransactionsTool(token: string): Tool {
	return {
		definition: {
			description:
				'List transactions in a YNAB budget. Optionally filter by account, category, or payee, and limit to transactions on or after `since_date`. Pending transactions are excluded. Amounts are in milliunits.',
			inputSchema: {
				properties: {
					account_id: { description: 'Filter to a specific account id.', type: 'string' },
					budget_id: budgetIdSchema,
					category_id: { description: 'Filter to a specific category id.', type: 'string' },
					limit: {
						description: 'Cap the number of returned transactions (most recent first). Defaults to 50 to keep responses compact.',
						maximum: 500,
						minimum: 1,
						type: 'integer',
					},
					payee_id: { description: 'Filter to a specific payee id.', type: 'string' },
					since_date: {
						description: 'Only include transactions on or after this ISO date (YYYY-MM-DD).',
						type: 'string',
					},
					type: {
						description: 'Only return transactions matching this special type.',
						enum: ['uncategorized', 'unapproved'],
						type: 'string',
					},
				},
				required: ['budget_id'],
				type: 'object',
			},
			name: 'ynab_list_transactions',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(listTransactionsArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const budgetId = args.budget_id;
			if (!budgetId) return err('budget_id is required', 'invalid_input');
			const filterCount = (args.account_id ? 1 : 0) + (args.category_id ? 1 : 0) + (args.payee_id ? 1 : 0);
			if (filterCount > 1) {
				return err('Specify at most one of account_id, category_id, payee_id — YNAB requires a single scope per request.');
			}
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
			const api = makeApi(token);
			// `getTransactionsBy{Category,Payee}` return HybridTransactionsResponse,
			// the others return TransactionsResponse — both have `data.transactions`
			// with shapes `slimTransaction` accepts. Type the call as the union so
			// downstream code doesn't have to discriminate.
			type TxResponse = { data: { transactions: AnyTransaction[] } };
			const fetchTransactions = (): Promise<TxResponse> => {
				if (args.account_id) {
					return api.transactions.getTransactionsByAccount(budgetId, args.account_id, args.since_date, args.type);
				}
				if (args.category_id) {
					return api.transactions.getTransactionsByCategory(budgetId, args.category_id, args.since_date, args.type);
				}
				if (args.payee_id) {
					return api.transactions.getTransactionsByPayee(budgetId, args.payee_id, args.since_date, args.type);
				}
				return api.transactions.getTransactions(budgetId, args.since_date, args.type);
			};
			const result = await call(fetchTransactions);
			if (isError(result)) return err(result.__error);
			// Single-pass filter+sort, then slice+map. The previous chain ran
			// four separate iterations over the array; this version mutates
			// the filtered array in place.
			const live = result.data.transactions.filter((t) => !t.deleted);
			live.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
			const txs = live.slice(0, limit).map(slimTransaction);
			return ok({ count: txs.length, transactions: txs });
		},
	};
}

function createTransactionTool(token: string): Tool {
	return {
		definition: {
			description:
				"Create a new transaction in a YNAB budget. Provide the amount as a decimal in the budget's currency (e.g. -12.34 for a $12.34 outflow); pass `amount_milliunits` instead for currencies without 2 decimal digits or to specify the exact server amount. Outflows are negative, inflows are positive. Requires a YNAB Personal Access Token with write scope.",
			inputSchema: {
				properties: {
					account_id: { description: 'Account id the transaction belongs to.', type: 'string' },
					amount: {
						description:
							'Amount in the budget currency as a decimal (e.g. -12.34 for an outflow of $12.34). Required unless `amount_milliunits` is supplied.',
						type: 'number',
					},
					amount_milliunits: {
						description: 'Amount in milliunits (1000 = 1 unit). Use this for non-2-decimal currencies or when an exact integer amount is needed.',
						type: 'integer',
					},
					approved: {
						description: 'Whether to mark the transaction approved. Defaults to true.',
						type: 'boolean',
					},
					budget_id: budgetIdSchema,
					category_id: { description: 'Category id to assign the transaction to.', type: 'string' },
					cleared: {
						description: 'Cleared status. Defaults to "uncleared".',
						enum: ['cleared', 'uncleared', 'reconciled'],
						type: 'string',
					},
					date: {
						description: 'Transaction date in YYYY-MM-DD. Defaults to today. Future dates are not allowed.',
						type: 'string',
					},
					flag_color: {
						enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
						type: 'string',
					},
					import_id: {
						description: 'Optional import id to deduplicate against later imports (max 36 chars).',
						type: 'string',
					},
					memo: { description: 'Optional memo / note.', type: 'string' },
					payee_id: { description: 'Payee id (use ynab_list_payees to find one).', type: 'string' },
					payee_name: {
						description: 'Payee name. If `payee_id` is omitted, YNAB will resolve to an existing payee or create a new one.',
						type: 'string',
					},
				},
				required: ['budget_id', 'account_id'],
				type: 'object',
			},
			name: 'ynab_create_transaction',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(createTransactionArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const budgetId = args.budget_id;
			if (!budgetId) return err('budget_id is required', 'invalid_input');
			if (args.amount == null && args.amount_milliunits == null) {
				return err('Missing required parameter: provide either `amount` or `amount_milliunits`.', 'invalid_input');
			}
			const milliunits = args.amount_milliunits ?? decimalToMilliunits(args.amount as number);
			if (!Number.isFinite(milliunits)) {
				return err('Invalid amount: must be a finite number.');
			}
			const date = args.date ?? ynab.utils.getCurrentDateInISOFormat();
			const api = makeApi(token);
			const result = await call(() =>
				api.transactions.createTransaction(budgetId, {
					transaction: {
						account_id: args.account_id,
						amount: Math.round(milliunits),
						approved: args.approved ?? true,
						category_id: args.category_id,
						cleared: args.cleared as ynab.TransactionClearedStatus | undefined,
						date,
						flag_color: args.flag_color as ynab.TransactionFlagColor | undefined,
						import_id: args.import_id,
						memo: args.memo,
						payee_id: args.payee_id,
						payee_name: args.payee_name,
					},
				}),
			);
			if (isError(result)) return err(result.__error);
			const created = result.data.transaction ?? result.data.transactions?.[0];
			if (!created) return err('YNAB accepted the request but returned no transaction.');
			return ok({ created: slimTransaction(created), duplicate_import_ids: result.data.duplicate_import_ids });
		},
	};
}

function updateTransactionTool(token: string): Tool {
	return {
		definition: {
			description:
				'Update an existing transaction. Only the fields you supply are changed. Provide either `amount` (decimal currency) or `amount_milliunits` to change the amount.',
			inputSchema: {
				properties: {
					account_id: { type: 'string' },
					amount: {
						description: 'Amount in budget currency as a decimal.',
						type: 'number',
					},
					amount_milliunits: { description: 'Amount in milliunits.', type: 'integer' },
					approved: { type: 'boolean' },
					budget_id: budgetIdSchema,
					category_id: { type: 'string' },
					cleared: { enum: ['cleared', 'uncleared', 'reconciled'], type: 'string' },
					date: { description: 'YYYY-MM-DD.', type: 'string' },
					flag_color: {
						enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
						type: 'string',
					},
					memo: { type: 'string' },
					payee_id: { type: 'string' },
					payee_name: { type: 'string' },
					transaction_id: { description: 'Id of the transaction to update.', type: 'string' },
				},
				required: ['budget_id', 'transaction_id'],
				type: 'object',
			},
			name: 'ynab_update_transaction',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(updateTransactionArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const budgetId = args.budget_id;
			const transactionId = args.transaction_id;
			if (!budgetId || !transactionId) return err('budget_id and transaction_id are required', 'invalid_input');
			const api = makeApi(token);

			// YNAB's PUT replaces the whole transaction, so missing fields
			// would clear server-side state. Skip the GET only when the
			// caller supplied every replacement-required field — otherwise
			// fall back to fetching the existing record and merging.
			const hasAmount = args.amount_milliunits != null || args.amount != null;
			const fullPayload =
				args.account_id !== undefined && args.date !== undefined && hasAmount && args.cleared !== undefined && args.approved !== undefined;

			let payload: ynab.ExistingTransaction;
			if (fullPayload) {
				const milliunits = args.amount_milliunits != null ? Math.round(args.amount_milliunits) : decimalToMilliunits(args.amount as number);
				payload = {
					account_id: args.account_id,
					amount: milliunits,
					approved: args.approved,
					category_id: args.category_id,
					cleared: args.cleared as ynab.TransactionClearedStatus,
					date: args.date,
					flag_color: (args.flag_color ?? null) as ynab.TransactionFlagColor | null,
					memo: args.memo,
					payee_id: args.payee_id,
					payee_name: args.payee_name,
				};
			} else {
				const existingResult = await call(() => api.transactions.getTransactionById(budgetId, transactionId));
				if (isError(existingResult)) return err(existingResult.__error);
				const existing = existingResult.data.transaction;
				const milliunits =
					args.amount_milliunits != null
						? Math.round(args.amount_milliunits)
						: args.amount != null
							? decimalToMilliunits(args.amount)
							: existing.amount;
				payload = {
					account_id: args.account_id ?? existing.account_id,
					amount: milliunits,
					approved: args.approved ?? existing.approved,
					category_id: args.category_id ?? existing.category_id,
					cleared: (args.cleared ?? existing.cleared) as ynab.TransactionClearedStatus,
					date: args.date ?? existing.date,
					flag_color: (args.flag_color ?? existing.flag_color ?? null) as ynab.TransactionFlagColor | null,
					memo: args.memo ?? existing.memo,
					payee_id: args.payee_id ?? existing.payee_id,
					payee_name: args.payee_name ?? existing.payee_name ?? undefined,
				};
			}
			const result = await call(() => api.transactions.updateTransaction(budgetId, transactionId, { transaction: payload }));
			if (isError(result)) return err(result.__error);
			return ok({ updated: slimTransaction(result.data.transaction) });
		},
	};
}

function updateMonthCategoryTool(token: string): Tool {
	return {
		definition: {
			description:
				'Set the assigned (budgeted) amount for a category in a specific month. Use `amount` for a decimal in the budget\'s currency (e.g. 200 for $200), or `amount_milliunits` for an exact integer amount. The month accepts YYYY-MM-01 or "current".',
			inputSchema: {
				properties: {
					amount: { description: 'Amount in budget currency as a decimal.', type: 'number' },
					amount_milliunits: { description: 'Amount in milliunits.', type: 'integer' },
					budget_id: budgetIdSchema,
					category_id: { type: 'string' },
					month: { description: 'YYYY-MM-01 or "current".', type: 'string' },
				},
				required: ['budget_id', 'month', 'category_id'],
				type: 'object',
			},
			name: 'ynab_update_category_budgeted',
		},
		async execute(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(updateMonthCategoryArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const budgetId = args.budget_id;
			const month = args.month;
			const categoryId = args.category_id;
			if (!budgetId || !month || !categoryId) return err('budget_id, month, and category_id are required', 'invalid_input');
			if (args.amount == null && args.amount_milliunits == null) {
				return err('Missing required parameter: provide either `amount` or `amount_milliunits`.', 'invalid_input');
			}
			const milliunits = args.amount_milliunits ?? decimalToMilliunits(args.amount as number);
			if (!Number.isFinite(milliunits)) {
				return err('Invalid amount: must be a finite number.');
			}
			const api = makeApi(token);
			const result = await call(() =>
				api.categories.updateMonthCategory(budgetId, month, categoryId, {
					category: { budgeted: Math.round(milliunits) },
				}),
			);
			if (isError(result)) return err(result.__error);
			return ok({ updated: slimCategory(result.data.category) });
		},
	};
}

// Returns every YNAB tool. The caller decides whether to register them based
// on whether YNAB_TOKEN is configured for the worker.
export function createYnabTools(token: string): Tool[] {
	return [
		listBudgetsTool(token),
		getUserTool(token),
		listAccountsTool(token),
		listCategoriesTool(token),
		getMonthTool(token),
		listPayeesTool(token),
		listTransactionsTool(token),
		createTransactionTool(token),
		updateTransactionTool(token),
		updateMonthCategoryTool(token),
	];
}
