import type { ReactNode } from 'react';
import type { Conversation } from '../../types/conversation';
import { fmtRelative, recencyBand, recencyBandLabel, type RecencyBand } from '../formatters';

export type AppShellProps = {
	conversations: Conversation[];
	activeConversationId?: string | null;
	children: ReactNode;
};

const BAND_ORDER: RecencyBand[] = ['today', 'this-week', 'earlier'];

function groupByBand(conversations: Conversation[], now: number): Map<RecencyBand, Conversation[]> {
	const groups = new Map<RecencyBand, Conversation[]>();
	for (const band of BAND_ORDER) groups.set(band, []);
	for (const c of conversations) {
		const band = recencyBand(c.updated_at, now);
		groups.get(band)!.push(c);
	}
	return groups;
}

export function AppShell({ conversations, activeConversationId, children }: AppShellProps) {
	const now = Date.now();
	const grouped = groupByBand(conversations, now);
	return (
		<div className="app-shell">
			{/* Hidden checkbox drives the mobile drawer toggle (CSS-only, no JS). */}
			<input type="checkbox" id="sidebar-toggle" className="sidebar-toggle" />
			<label htmlFor="sidebar-toggle" className="sidebar-overlay" aria-hidden="true" />
			<aside className="sidebar" aria-label="Conversations">
				<div className="sidebar-header">
					<a href="/" className="sidebar-brand">
						Interface
					</a>
					<form action="/conversations" method="post" className="sidebar-new-chat">
						<button type="submit" aria-label="New chat" title="New chat">
							New chat
						</button>
					</form>
				</div>
				<div className="sidebar-search">
					<input type="search" placeholder="Search conversations…" disabled aria-label="Search" />
				</div>
				<nav className="sidebar-nav">
					{conversations.length === 0 ? (
						<div className="sidebar-empty">No conversations yet.</div>
					) : (
						BAND_ORDER.map((band) => {
							const items = grouped.get(band) ?? [];
							if (items.length === 0) return null;
							return (
								<section key={band} className="sidebar-group">
									<div className="sidebar-group-label">{recencyBandLabel(band)}</div>
									<ul className="sidebar-list">
										{items.map((c) => {
											const active = c.id === activeConversationId;
											return (
												<li key={c.id}>
													<a
														href={`/c/${c.id}`}
														className={`sidebar-item${active ? ' active' : ''}`}
														aria-current={active ? 'page' : undefined}
													>
														<span className="sidebar-item-title">{c.title}</span>
														<span className="sidebar-item-meta">{fmtRelative(c.updated_at, now)}</span>
													</a>
												</li>
											);
										})}
									</ul>
								</section>
							);
						})
					)}
				</nav>
				<div className="sidebar-footer">
					<a href="/settings" className="sidebar-footer-link">
						Settings
					</a>
				</div>
			</aside>
			<main className="app-main">
				<div className="app-main-header">
					<label htmlFor="sidebar-toggle" className="sidebar-toggle-button" aria-label="Toggle sidebar">
						☰
					</label>
				</div>
				<div className="app-main-content">{children}</div>
			</main>
		</div>
	);
}
