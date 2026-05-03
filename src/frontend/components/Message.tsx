import type { MessagePart, MessageRow, ThinkingPart, ToolResultPart, ToolUsePart } from '../../types/conversation';
import { Artifact } from './Artifact';
import { MetaPanel } from './MetaPanel';
import { ToolCallCard } from './ToolCall';

function TextPartView({ part }: { part: { text: string; textHtml?: string } }) {
	if (typeof part.textHtml === 'string' && part.textHtml.length > 0) {
		return <div className="content" dangerouslySetInnerHTML={{ __html: part.textHtml }} />;
	}
	return (
		<div className="content" style={{ whiteSpace: 'pre-wrap' }}>
			{part.text}
		</div>
	);
}

function ThinkingPartView({ part, streaming }: { part: ThinkingPart; streaming: boolean }) {
	const showHtml = typeof part.textHtml === 'string' && part.textHtml.length > 0;
	return (
		<details className="thinking" open={streaming}>
			<summary>
				<span className="thinking-label">Thinking</span>
				{streaming ? <span className="streaming-indicator" aria-hidden="true">●</span> : null}
			</summary>
			{showHtml ? (
				<div className="thinking-body" dangerouslySetInnerHTML={{ __html: part.textHtml as string }} />
			) : (
				<div className="thinking-body" style={{ whiteSpace: 'pre-wrap' }}>
					{part.text}
				</div>
			)}
		</details>
	);
}

// Walk parts in order:
//   text     → inline content block
//   thinking → inline collapsible <details>
//   tool_use → ToolCallCard, paired with its tool_result by id
//   tool_result → skipped (rendered alongside its paired tool_use)
function renderParts(parts: MessagePart[], streaming: boolean): React.ReactNode[] {
	const resultsById = new Map<string, ToolResultPart>();
	for (const p of parts) {
		if (p.type === 'tool_result') resultsById.set(p.toolUseId, p);
	}
	// A thinking part is "active" only if it's the last non-empty part — once
	// the next text/tool part appears, prior thinking collapses.
	const lastIndex = parts.length - 1;
	return parts.map((part, i) => {
		if (part.type === 'text') {
			if (!part.text) return null;
			return <TextPartView key={`text-${i}`} part={part} />;
		}
		if (part.type === 'thinking') {
			if (!part.text) return null;
			const isCurrent = streaming && i === lastIndex;
			return <ThinkingPartView key={`think-${i}`} part={part} streaming={isCurrent} />;
		}
		if (part.type === 'tool_use') {
			const use = part as ToolUsePart;
			const result = resultsById.get(use.id);
			return (
				<ToolCallCard
					key={`tool-${use.id}`}
					call={{ id: use.id, name: use.name, input: use.input }}
					result={result ? { toolUseId: result.toolUseId, content: result.content, isError: result.isError } : undefined}
					defaultOpen={streaming && !result}
				/>
			);
		}
		return null;
	});
}

export function Message({ message }: { message: MessageRow }) {
	const isAssistant = message.role === 'assistant';
	const isStreaming = message.status === 'streaming';
	const artifacts = message.artifacts ?? [];
	const parts = message.parts;
	const hasParts = isAssistant && Array.isArray(parts) && parts.length > 0;
	// Fallback content path (legacy / streaming pre-first-token / user messages):
	// pre-rendered markdown HTML if present, else plain text. Used when the
	// `parts` timeline is empty.
	const showHtml = isAssistant && typeof message.contentHtml === 'string' && message.contentHtml.length > 0;
	return (
		<div className="message" data-message-id={message.id} data-role={message.role} data-status={message.status}>
			<div className="role">
				{message.role}
				{message.model ? ` · ${message.model}` : ''}
				{isStreaming ? <span className="streaming-indicator" aria-label="streaming">●</span> : null}
			</div>
			{hasParts ? (
				renderParts(parts as MessagePart[], isStreaming)
			) : showHtml ? (
				<div className="content" dangerouslySetInnerHTML={{ __html: message.contentHtml as string }} />
			) : (
				<div className="content" style={{ whiteSpace: 'pre-wrap' }}>
					{message.content}
				</div>
			)}
			{artifacts.length > 0 ? (
				<div className="artifacts">
					{artifacts.map((a) => (
						<Artifact key={a.id} artifact={a} />
					))}
				</div>
			) : null}
			{message.status === 'error' && message.error ? <div className="error">{message.error}</div> : null}
			{isAssistant ? <MetaPanel snapshot={message.meta} /> : null}
		</div>
	);
}
