import type { McpServerRow } from '../../../mcp/types';
import type { ProviderKeyStatus } from '../../../settings';

export type SettingsPageProps = {
	theme: 'system' | 'light' | 'dark';
	providerKeys: ProviderKeyStatus[];
	mcpServers: McpServerRow[];
	contextCompactionThreshold: number;
	contextCompactionSummaryTokens: number;
	modelListRaw: string;
};

export function SettingsPage({ theme, providerKeys, mcpServers, contextCompactionThreshold, contextCompactionSummaryTokens, modelListRaw }: SettingsPageProps) {
	return (
		<div className="settings-layout">
			<h1 className="settings-title">Settings</h1>

			<section className="settings-section" aria-labelledby="appearance">
				<h2 id="appearance">Appearance</h2>
				<form action="/settings" method="post">
					<input type="hidden" name="key" value="theme" />
					<label htmlFor="theme-select" style={{ display: 'block', marginBottom: '0.5rem' }}>
						Theme
					</label>
					<div className="row" style={{ display: 'flex', gap: '0.5rem' }}>
						<select id="theme-select" name="value" defaultValue={theme}>
							<option value="system">System</option>
							<option value="light">Light</option>
							<option value="dark">Dark</option>
						</select>
						<button type="submit">Save</button>
					</div>
				</form>
			</section>

			<section className="settings-section" aria-labelledby="provider-keys">
				<h2 id="provider-keys">Provider keys</h2>
				<p style={{ color: 'var(--muted)', marginTop: 0 }}>
					Provider API keys are stored as Worker secrets. Edit with{' '}
					<code>npx wrangler secret put NAME</code>.
				</p>
				<dl>
					{providerKeys.map((s) => (
						<div key={s.name} style={{ display: 'contents' }}>
							<dt>
								<code>{s.name}</code>
							</dt>
							<dd>
								<span className={`badge ${s.configured ? 'ok' : 'missing'}`}>
									{s.configured ? 'configured' : 'not configured'}
								</span>
							</dd>
						</div>
					))}
				</dl>
			</section>

			<section className="settings-section" aria-labelledby="mcp-servers">
				<h2 id="mcp-servers">MCP servers</h2>
				<p style={{ color: 'var(--muted)', marginTop: 0 }}>
					HTTP and SSE MCP servers are queried for tools at the start of each
					generation. Stdio transport ships in a later phase.
				</p>
				{mcpServers.length === 0 ? (
					<div className="empty">No MCP servers configured.</div>
				) : (
					<ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
						{mcpServers.map((s) => (
							<li
								key={s.id}
								style={{
									border: '1px solid var(--border)',
									borderRadius: 6,
									padding: '0.5rem 0.75rem',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									gap: '0.5rem',
									flexWrap: 'wrap',
								}}
							>
								<div style={{ minWidth: 0, flex: 1 }}>
									<div style={{ fontWeight: 500 }}>
										{s.name}{' '}
										<span className={`badge ${s.enabled ? 'ok' : 'missing'}`}>
											{s.enabled ? 'enabled' : 'disabled'}
										</span>
									</div>
									<div style={{ color: 'var(--muted)', fontSize: '0.85em', wordBreak: 'break-all' }}>
										{s.transport.toUpperCase()} · {s.url ?? s.command ?? '—'}
									</div>
								</div>
								<form
									action="/settings/mcp-servers/delete"
									method="post"
									onSubmit={(e) => {
										if (!confirm(`Delete MCP server "${s.name}"?`)) e.preventDefault();
									}}
								>
									<input type="hidden" name="id" value={s.id} />
									<button type="submit">Delete</button>
								</form>
							</li>
						))}
					</ul>
				)}
				<details style={{ marginTop: '0.75rem' }}>
					<summary style={{ cursor: 'pointer', minHeight: 'var(--tap-target)', display: 'flex', alignItems: 'center' }}>
						Add server
					</summary>
					<form
						action="/settings/mcp-servers"
						method="post"
						style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}
					>
						<label>
							Name
							<input type="text" name="name" required style={{ display: 'block', width: '100%' }} />
						</label>
						<label>
							Transport
							<select name="transport" defaultValue="http" style={{ display: 'block', width: '100%' }}>
								<option value="http">HTTP</option>
								<option value="sse">SSE</option>
							</select>
						</label>
						<label>
							URL
							<input type="url" name="url" required style={{ display: 'block', width: '100%' }} />
						</label>
						<label>
							Auth headers (JSON, optional)
							<input
								type="text"
								name="auth_json"
								placeholder='{"Authorization":"Bearer …"}'
								style={{ display: 'block', width: '100%' }}
							/>
						</label>
						<button type="submit">Save</button>
					</form>
				</details>
			</section>

			<section className="settings-section" aria-labelledby="model-list">
				<h2 id="model-list">Model list</h2>
				<p style={{ color: 'var(--muted)', marginTop: 0 }}>
					Models available in the composer dropdown. One per line as <code>slug|label</code>.
					Leave blank to restore defaults.
				</p>
				<form action="/settings" method="post">
					<input type="hidden" name="key" value="model_list" />
					<textarea
						name="value"
						rows={5}
						defaultValue={modelListRaw}
						placeholder="anthropic/claude-sonnet-4.6|Claude Sonnet 4.6"
						style={{ display: 'block', width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
					/>
					<button type="submit" style={{ marginTop: '0.5rem' }}>Save</button>
				</form>
			</section>

			<section className="settings-section" aria-labelledby="context-compaction">
				<h2 id="context-compaction">Context compaction</h2>
				<p style={{ color: 'var(--muted)', marginTop: 0 }}>
					When estimated token usage exceeds this percentage of the model's context
					window, older messages are summarized to make room. 0 = disabled.
				</p>
				<form action="/settings" method="post">
					<input type="hidden" name="key" value="context_compaction_threshold" />
					<div className="row" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
						<label htmlFor="threshold-input">Threshold</label>
						<input
							id="threshold-input"
							type="number"
							name="value"
							min={0}
							max={100}
							step={1}
							defaultValue={contextCompactionThreshold}
							style={{ width: '5rem' }}
						/>
						<span style={{ color: 'var(--muted)' }}>%</span>
						<button type="submit">Save</button>
					</div>
				</form>
				<form action="/settings" method="post" style={{ marginTop: '0.75rem' }}>
					<input type="hidden" name="key" value="context_compaction_summary_tokens" />
					<div className="row" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
						<label htmlFor="summary-tokens-input">Summary budget</label>
						<input
							id="summary-tokens-input"
							type="number"
							name="value"
							min={256}
							step={256}
							defaultValue={contextCompactionSummaryTokens}
							style={{ width: '6rem' }}
						/>
						<span style={{ color: 'var(--muted)' }}>tokens</span>
						<button type="submit">Save</button>
					</div>
				</form>
			</section>
		</div>
	);
}
