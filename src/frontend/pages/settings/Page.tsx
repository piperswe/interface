import type { McpServerRow } from '../../../mcp/types';
import type { ProviderKeyStatus } from '../../../settings';

export type SettingsPageProps = {
	theme: 'system' | 'light' | 'dark';
	providerKeys: ProviderKeyStatus[];
	mcpServers: McpServerRow[];
};

export function SettingsPage({ theme, providerKeys, mcpServers }: SettingsPageProps) {
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
		</div>
	);
}
