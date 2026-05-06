import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createYnabTools } from './ynab';

const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

function findTool(name: string) {
	const tool = createYnabTools('test-token').find((t) => t.definition.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
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
							id: 'b1',
							name: 'My Plan',
							last_modified_on: '2026-05-01T00:00:00Z',
							first_month: '2025-01-01',
							last_month: '2026-12-01',
							currency_format: { iso_code: 'USD', currency_symbol: '$' },
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
		expect(parsed.budgets[0]).toMatchObject({ id: 'b1', name: 'My Plan', currency: { iso_code: 'USD' } });
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
							id: 'a1',
							name: 'Checking',
							type: 'checking',
							on_budget: true,
							closed: false,
							balance: 123450,
							cleared_balance: 100000,
							uncleared_balance: 23450,
							transfer_payee_id: 'p1',
							deleted: false,
							balance_formatted: '$123.45',
						},
					],
				},
			}),
		);
		const result = await findTool('ynab_list_accounts').execute(ctx, { budget_id: 'last-used' });
		const parsed = JSON.parse(result.content as string) as Array<{ id: string; balance_milliunits: number }>;
		expect(parsed[0]).toMatchObject({ id: 'a1', balance_milliunits: 123450 });
	});

	it('surfaces YNAB API errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { id: '401', detail: 'Unauthorized' } }), {
				status: 401,
				statusText: 'Unauthorized',
				headers: { 'content-type': 'application/json' },
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
							id: 'g1',
							name: 'Visible',
							hidden: false,
							deleted: false,
							categories: [
								{
									id: 'c1',
									category_group_id: 'g1',
									name: 'Groceries',
									hidden: false,
									budgeted: 50000,
									activity: -25000,
									balance: 25000,
									deleted: false,
								},
								{
									id: 'c2',
									category_group_id: 'g1',
									name: 'Hidden',
									hidden: true,
									budgeted: 0,
									activity: 0,
									balance: 0,
									deleted: false,
								},
							],
						},
						{
							id: 'g2',
							name: 'HiddenGroup',
							hidden: true,
							deleted: false,
							categories: [],
						},
						{
							id: 'g3',
							name: 'Deleted',
							hidden: false,
							deleted: true,
							categories: [],
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
			budget_id: 'b1',
			account_id: 'a1',
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
							id: 't1',
							date: '2026-04-30',
							amount: -12340,
							cleared: 'cleared',
							approved: true,
							account_id: 'a1',
							account_name: 'Checking',
							category_name: 'Groceries',
							subtransactions: [],
							deleted: false,
						},
						{
							id: 't2',
							date: '2026-04-25',
							amount: -5000,
							cleared: 'cleared',
							approved: true,
							account_id: 'a1',
							account_name: 'Checking',
							subtransactions: [],
							deleted: true,
						},
					],
				},
			}),
		);
		const result = await findTool('ynab_list_transactions').execute(ctx, {
			budget_id: 'b1',
			account_id: 'a1',
			since_date: '2026-04-01',
			type: 'unapproved',
			limit: 10,
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
					transaction_ids: ['t-new'],
					transaction: {
						id: 't-new',
						date: '2026-05-01',
						amount: -12340,
						cleared: 'uncleared',
						approved: true,
						account_id: 'a1',
						account_name: 'Checking',
						subtransactions: [],
						deleted: false,
					},
				},
			}),
		);
		const result = await findTool('ynab_create_transaction').execute(ctx, {
			budget_id: 'b1',
			account_id: 'a1',
			date: '2026-05-01',
			amount: -12.34,
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
					transaction_ids: ['t-new'],
					transaction: {
						id: 't-new',
						date: '2026-05-01',
						amount: -7777,
						cleared: 'uncleared',
						approved: true,
						account_id: 'a1',
						account_name: 'Checking',
						subtransactions: [],
						deleted: false,
					},
				},
			}),
		);
		await findTool('ynab_create_transaction').execute(ctx, {
			budget_id: 'b1',
			account_id: 'a1',
			amount_milliunits: -7777,
		});
		const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
		const body = JSON.parse(init.body as string) as { transaction: { amount: number } };
		expect(body.transaction.amount).toBe(-7777);
	});

	it('errors when neither amount form is supplied', async () => {
		const result = await findTool('ynab_create_transaction').execute(ctx, {
			budget_id: 'b1',
			account_id: 'a1',
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
						id: 'c1',
						category_group_id: 'g1',
						name: 'Groceries',
						hidden: false,
						budgeted: 200000,
						activity: 0,
						balance: 200000,
						deleted: false,
					},
				},
			}),
		);
		const result = await findTool('ynab_update_category_budgeted').execute(ctx, {
			budget_id: 'b1',
			month: '2026-05-01',
			category_id: 'c1',
			amount: 200,
		});
		expect(result.isError).toBeFalsy();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain('/plans/b1/months/2026-05-01/categories/c1');
		expect(init.method).toBe('PATCH');
		const body = JSON.parse(init.body as string) as { category: { budgeted: number } };
		expect(body.category.budgeted).toBe(200000);
	});
});
