import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createProviderRegistry, type LanguageModel } from 'ai'

import { env } from '@/lib/env'

/**
 * Chat provider, resolved from a config string.
 *
 * Note the asymmetry with the EMBEDDING model, which is pinned to the Qdrant
 * collection name and recorded on every editions row: swapping that means
 * re-embedding every chunk in the system. Swapping the chat model costs
 * nothing and touches no data, so it gets a runtime config value and could
 * become a per-user preference later. The two deliberately do not share a
 * configuration posture.
 *
 * WHY openai-compatible RATHER THAN @openrouter/ai-sdk-provider:
 *
 * That provider (3.1.0) is a v2-spec provider and runs in compatibility mode
 * under AI SDK v7. In that mode the tool loop silently breaks: tool CALLS are
 * emitted, but `execute` never runs, no tool results come back, the loop stops
 * after one step, and the final text is empty. No error is raised anywhere —
 * the request simply produces nothing, which for a product whose entire
 * behaviour is a tool loop is a total failure that looks like a bad answer.
 *
 * Reproduced with a one-line weather tool:
 *   @openrouter/ai-sdk-provider  -> steps 1, executed 0, text ""
 *   @ai-sdk/openai-compatible    -> steps 2, executed 1, text produced
 *
 * openai-compatible is maintained in lockstep with the core SDK, so it tracks
 * the current spec. OpenRouter's own extras are sent via injectBody() below.
 * Revisit if the dedicated provider ships a v4-spec release.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

/**
 * OpenRouter-specific request fields, merged into the JSON body.
 *
 * `data_collection: 'deny'` matters for a product whose pitch is private
 * books: retrieved passages come from a user's own upload, and OpenRouter
 * routes them to an upstream provider. This excludes providers that may
 * retain or train on them. It belongs in the privacy copy too, not just here.
 *
 * Injected through fetch rather than providerOptions so it cannot be dropped
 * by provider-option plumbing — it is a privacy guarantee, not a preference.
 */
function openrouterExtras(): Record<string, unknown> {
  const model = env.chat.model.replace(/^openrouter:/, '')
  return {
    provider: {
      data_collection: 'deny',
      allow_fallbacks: true,
    },
    // Model slugs get deprecated and renamed; OpenRouter tries these in order.
    ...(env.chat.fallback ? { models: [model, env.chat.fallback] } : {}),

    /**
     * Reasoning, bounded.
     *
     * qwen3.8-flash is a thinking model, and left alone it spends its entire
     * output budget reasoning. One cross-book question produced 2,232
     * reasoning chunks and 229KB of stream with ZERO answer text before the
     * request timed out.
     *
     * Disabled outright, which measured cleanest on this model: a one-sentence
     * prompt cost 29 output tokens with reasoning off, 64 with `effort: low`,
     * and 109 with reasoning left on. The hard part of this app is retrieval,
     * which happens in the tools rather than in the model's head.
     */
    reasoning: { enabled: false },
    include_reasoning: false,

    /** A single turn that wants more than this has gone wrong, not deep. */
    max_tokens: 2000,
  }
}

const injectBody =
  (extras: () => Record<string, unknown>): typeof fetch =>
  async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') return fetch(input, init)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      return fetch(input, init)
    }
    return fetch(input, { ...init, body: JSON.stringify({ ...body, ...extras() }) })
  }

const registry = createProviderRegistry({
  openrouter: createOpenAICompatible({
    name: 'openrouter',
    baseURL: OPENROUTER_BASE,
    apiKey: env.chat.openrouterKey ?? '',
    headers: {
      // OpenRouter attributes traffic by these; harmless but polite.
      'HTTP-Referer': 'https://librarian.local',
      'X-Title': 'LibrarianAI',
    },
    fetch: injectBody(openrouterExtras),
  }),
  // Ollama also speaks an OpenAI-compatible API. Only useful for chat here —
  // embeddings go through lib/embed/ollama.ts, which needs bge's
  // query/passage prefix handling.
  ollama: createOpenAICompatible({
    name: 'ollama',
    baseURL: `${env.embed.url}/v1`,
  }),
})

/** `provider:model`, e.g. "openrouter:anthropic/claude-sonnet-5.5". */
type ModelId = `openrouter:${string}` | `ollama:${string}`

export function chatModel(id: string = env.chat.model): LanguageModel {
  if (!/^(openrouter|ollama):/.test(id)) {
    throw new Error(`CHAT_MODEL must be "openrouter:<model>" or "ollama:<model>", got "${id}"`)
  }
  return registry.languageModel(id as ModelId)
}

/** Fail at boot rather than on a user's first question. */
export function assertChatConfigured(): void {
  if (env.chat.model.startsWith('openrouter:') && !env.chat.openrouterKey) {
    throw new Error('CHAT_MODEL uses openrouter but OPENROUTER_API_KEY is not set')
  }
}
