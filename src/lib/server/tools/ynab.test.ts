import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYnabTools } from './ynab';

const ctx = { assistantMessageId: 'a', conversationId: 'c', env, modelId: 'p/m' };

function findTool(name: string) {
	const tool = createYnabTools('test-token').find((t) => t.definition.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' },
		status: 200,
		...init,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createYnabTools', () => {
	it('exposes the expected tool names', () => {
		const names = createYnabTools('t').map((tool) => tool.definition.name);
		expect(names).toEqual([
			'ynab_list_budgets',
			'ynab_get_user',
			'ynab_list_accounts',
			'ynab_list_categories',
			'ynab_get_month',
			'ynab_list_payees',
			'ynab_list_transactions',
			'ynab_create_transaction',
			'ynab_update_transaction',
			'ynab_update_category_budgeted',
		]);
	});

	it('calls the YNAB API with the access token', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: { user: { id: 'user-123' } } }));
		const tool = findTool('ynab_get_user');
		const result = await tool.execute(ctx, {});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('user-123');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.ynab.com/v1/user');
		const headers = new Headers((init?.headers as HeadersInit) ?? {});
		expect(headers.get('Authorization')).toBe('Bearer test-token');
	});
});

describe('ynab_list_budgets', () => {
	it('returns a slim budget list', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					default_plan: { id: 'b-default', name: 'Default' },
					plans: [
						{
							currency_format: { currency_symbol: '$', iso_code: 'USD' },
							first_month: '2025-01-01',
							id: 'b1',
							last_modified_on: '2026-05-01T00:00:00Z',
							last_month: '2026-12-01',
							name: 'My Plan',
						},
					],
				},
			}),
		);
		const result = await findTool('ynab_list_budgets').execute(ctx, {});
		const parsed = JSON.parse(result.content as string) as {
			default_budget_id: string;
			budgets: Array<{ id: string; name: string; currency: { iso_code: string } }>;
		};
		expect(parsed.default_budget_id).toBe('b-default');
		expect(parsed.budgets[0]).toMatchObject({ currency: { iso_code: 'USD' }, id: 'b1', name: 'My Plan' });
		expect(parsed.budgets[0]).not.toHaveProperty('accounts');
	});
});

describe('ynab_list_accounts', () => {
	it('errors when budget_id is missing', async () => {
		const result = await findTool('ynab_list_accounts').execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/budget_id/);
	});

	it('returns slim account info', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					accounts: [
						{
							balance: 123450,
							balance_formatted: '$123.45',
							cleared_balance: 100000,
							closed: false,
							deleted: false,
							id: 'a1',
							name: 'Checking',
							on_budget: true,
							transfer_payee_id: 'p1',
							type: 'checking',
							uncleared_balance: 23450,
						},
					],
				},
			}),
		);
		const result = await findTool('ynab_list_accounts').execute(ctx, { budget_id: 'last-used' });
		const parsed = JSON.parse(result.content as string) as Array<{ id: string; balance_milliunits: number }>;
		expect(parsed[0]).toMatchObject({ balance_milliunits: 123450, id: 'a1' });
	});

	it('surfaces YNAB API errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { detail: 'Unauthorized', id: '401' } }), {
				headers: { 'content-type': 'application/json' },
				status: 401,
				statusText: 'Unauthorized',
			}),
		);
		const result = await findTool('ynab_list_accounts').execute(ctx, { budget_id: 'x' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/401/);
	});
});

describe('ynab_list_categories', () => {
	it('hides hidden and deleted entries by default', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					category_groups: [
						{
							categories: [
								{
									activity: -25000,
									balance: 25000,
									budgeted: 50000,
									category_group_id: 'g1',
									deleted: false,
									hidden: false,
									id: 'c1',
									name: 'Groceries',
								},
								{
									activity: 0,
									balance: 0,
									budgeted: 0,
									category_group_id: 'g1',
									deleted: false,
									hidden: true,
									id: 'c2',
									name: 'Hidden',
								},
							],
							deleted: false,
							hidden: false,
							id: 'g1',
							name: 'Visible',
						},
						{
							categories: [],
							deleted: false,
							hidden: true,
							id: 'g2',
							name: 'HiddenGroup',
						},
						{
							categories: [],
							deleted: true,
							hidden: false,
							id: 'g3',
							name: 'Deleted',
						},
					],
				},
			}),
		);
		const result = await findTool('ynab_list_categories').execute(ctx, { budget_id: 'b1' });
		const parsed = JSON.parse(result.content as string) as Array<{ name: string; categories: Array<{ name: string }> }>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe('Visible');
		expect(parsed[0].categories.map((c) => c.name)).toEqual(['Groceries']);
	});
});

describe('ynab_list_transactions', () => {
	it('rejects multiple scope filters', async () => {
		const result = await findTool('ynab_list_transactions').execute(ctx, {
			account_id: 'a1',
			budget_id: 'b1',
			category_id: 'c1',
		});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/at most one/);
	});

	it('hits the by-account endpoint and forwards filters', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					transactions: [
						{
							account_id: 'a1',
							account_name: 'Checking',
							amount: -12340,
							approved: true,
							category_name: 'Groceries',
							cleared: 'cleared',
							date: '2026-04-30',
							deleted: false,
							id: 't1',
							subtransactions: [],
						},
						{
							account_id: 'a1',
							account_name: 'Checking',
							amount: -5000,
							approved: true,
							cleared: 'cleared',
							date: '2026-04-25',
							deleted: true,
							id: 't2',
							subtransactions: [],
						},
					],
				},
			}),
		);
		const result = await findTool('ynab_list_transactions').execute(ctx, {
			account_id: 'a1',
			budget_id: 'b1',
			limit: 10,
			since_date: '2026-04-01',
			type: 'unapproved',
		});
		expect(result.isError).toBeFalsy();
		const url = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
		expect(url).toContain('/plans/b1/accounts/a1/transactions');
		expect(url).toContain('since_date=2026-04-01');
		expect(url).toContain('type=unapproved');
		const parsed = JSON.parse(result.content as string) as { count: number; transactions: Array<{ id: string }> };
		expect(parsed.count).toBe(1);
		expect(parsed.transactions[0].id).toBe('t1');
	});

	it('falls back to the unfiltered endpoint when no scope is provided', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ data: { transactions: [] } }));
		await findTool('ynab_list_transactions').execute(ctx, { budget_id: 'b1' });
		const url = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
		expect(url).toContain('/plans/b1/transactions');
		expect(url).not.toContain('/accounts/');
	});
});

describe('ynab_create_transaction', () => {
	it('converts decimal amounts to milliunits', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					transaction: {
						account_id: 'a1',
						account_name: 'Checking',
						amount: -12340,
						approved: true,
						cleared: 'uncleared',
						date: '2026-05-01',
						deleted: false,
						id: 't-new',
						subtransactions: [],
					},
					transaction_ids: ['t-new'],
				},
			}),
		);
		const result = await findTool('ynab_create_transaction').execute(ctx, {
			account_id: 'a1',
			amount: -12.34,
			budget_id: 'b1',
			date: '2026-05-01',
			payee_name: 'Coffee Shop',
		});
		expect(result.isError).toBeFalsy();
		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		const body = JSON.parse(init.body as string) as { transaction: { amount: number; payee_name: string; approved: boolean } };
		expect(body.transaction.amount).toBe(-12340);
		expect(body.transaction.payee_name).toBe('Coffee Shop');
		expect(body.transaction.approved).toBe(true);
	});

	it('passes amount_milliunits through unchanged', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					transaction: {
						account_id: 'a1',
						account_name: 'Checking',
						amount: -7777,
						approved: true,
						cleared: 'uncleared',
						date: '2026-05-01',
						deleted: false,
						id: 't-new',
						subtransactions: [],
					},
					transaction_ids: ['t-new'],
				},
			}),
		);
		await findTool('ynab_create_transaction').execute(ctx, {
			account_id: 'a1',
			amount_milliunits: -7777,
			budget_id: 'b1',
		});
		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		const body = JSON.parse(init.body as string) as { transaction: { amount: number } };
		expect(body.transaction.amount).toBe(-7777);
	});

	it('errors when neither amount form is supplied', async () => {
		const result = await findTool('ynab_create_transaction').execute(ctx, {
			account_id: 'a1',
			budget_id: 'b1',
		});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/amount/);
	});
});

describe('ynab_update_category_budgeted', () => {
	it('PATCHes the category with milliunits', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				data: {
					category: {
						activity: 0,
						balance: 200000,
						budgeted: 200000,
						category_group_id: 'g1',
						deleted: false,
						hidden: false,
						id: 'c1',
						name: 'Groceries',
					},
				},
			}),
		);
		const result = await findTool('ynab_update_category_budgeted').execute(ctx, {
			amount: 200,
			budget_id: 'b1',
			category_id: 'c1',
			month: '2026-05-01',
		});
		expect(result.isError).toBeFalsy();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain('/plans/b1/months/2026-05-01/categories/c1');
		expect(init.method).toBe('PATCH');
		const body = JSON.parse(init.body as string) as { category: { budgeted: number } };
		expect(body.category.budgeted).toBe(200000);
	});
});
