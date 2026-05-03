// Augment Cloudflare.Env with optional secrets that wrangler types doesn't pick
// up from the wrangler.jsonc `secrets.optional` array. Edit when adding new
// optional provider/integration secrets.
declare global {
	namespace Cloudflare {
		interface Env {
			ANTHROPIC_KEY?: string;
			OPENAI_KEY?: string;
			GOOGLE_KEY?: string;
			DEEPSEEK_KEY?: string;
			KAGI_KEY?: string;
		}
	}
}

export {};
