import { ClaudeProvider } from './claude.js';
import type { AiProvider } from './provider.js';

let provider: AiProvider | undefined;

/**
 * The rest of the codebase gets its AI engine from here and never constructs a
 * vendor client directly.
 */
export function getAiProvider(): AiProvider {
  provider ??= new ClaudeProvider();
  return provider;
}

/** Test seam: swap in a fake provider without touching call sites. */
export function setAiProvider(next: AiProvider): void {
  provider = next;
}

export * from './audit-schema.js';
export * from './provider.js';
