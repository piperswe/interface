import type { Artifact as ArtifactT } from '../../types/conversation';

export function Artifact({ artifact }: { artifact: ArtifactT }) {
	const showHtml = typeof artifact.contentHtml === 'string' && artifact.contentHtml.length > 0;
	return (
		<div className="artifact" data-artifact-id={artifact.id} data-type={artifact.type}>
			<div className="artifact-header">
				<span className="artifact-type">{artifact.type}</span>
				{artifact.name ? <span className="artifact-name">{artifact.name}</span> : null}
				{artifact.language ? <span className="artifact-lang">{artifact.language}</span> : null}
				{artifact.version > 1 ? <span className="artifact-version">v{artifact.version}</span> : null}
			</div>
			{showHtml ? (
				<div className="artifact-body" dangerouslySetInnerHTML={{ __html: artifact.contentHtml as string }} />
			) : (
				<pre className="artifact-body">
					<code>{artifact.content}</code>
				</pre>
			)}
		</div>
	);
}
