import { stepCountIs } from 'ai'

/**
 * Tool-loop policy, shared by the chat route and the grounding tests so the
 * tests exercise exactly what production runs.
 *
 * WHY THIS EXISTS:
 *
 * A step budget alone is not enough. Models differ enormously in how
 * search-happy they are, and a model that spends every step searching never
 * reaches the step where it writes the answer — the request then finishes with
 * `finishReason: "tool-calls"` and EMPTY text. The user sees nothing.
 *
 * Measured on the same question ("how do ideas about self-control relate
 * across my books?"), same budget of 5 steps:
 *
 *   anthropic/claude-sonnet-5.5   7 searches over 3 steps, then answered
 *   qwen/qwen3.8-flash           19 searches over 5 steps, never answered
 *
 * So the guarantee cannot be "ask the model nicely to answer eventually".
 * Two structural limits instead:
 *
 *   1. prepareStep() disables tools on the final step, so the last step is
 *      always an answer rather than another search.
 *   2. SEARCH_BUDGET caps retrieval calls per turn; past it, searchBooks
 *      returns a note telling the model to answer with what it has.
 *
 * Together these make "an answer is produced" independent of model
 * temperament — which matters because the chat model is a swappable env var.
 */

/** Total steps allowed in one turn, including the final answer step. */
export const MAX_STEPS = 6

/**
 * Retrieval calls allowed per turn.
 *
 * Generous enough for genuine multi-book questions (Sonnet used 7), tight
 * enough that a search-happy model cannot run up 19 embeddings and 19 Qdrant
 * queries for one question.
 */
export const SEARCH_BUDGET = 10

export const stopWhen = stepCountIs(MAX_STEPS)

/**
 * Force the last step to be prose.
 *
 * `activeTools: []` rather than `toolChoice: 'none'`: tool_choice support is
 * uneven across providers and qwen3.8-flash via OpenRouter ignores it. Three
 * runs of the grounding suite with toolChoice still produced one turn that hit
 * the step ceiling with `finishReason: "tool-calls"` and empty text.
 *
 * An empty active-tool set is not a request — there is no tool left to call,
 * so the only thing the model can emit is the answer. Prior tool results stay
 * in the message history either way.
 */
export function prepareStep({ stepNumber }: { stepNumber: number }) {
  if (stepNumber >= MAX_STEPS - 1) {
    return { activeTools: [] as [] }
  }
  return {}
}

/**
 * Last-resort guarantee that the user gets prose.
 *
 * Even with tools stripped on the final step, qwen3.8-flash occasionally ends
 * a turn with empty content. Rather than keep guessing at SDK and provider
 * semantics, this closes the hole at the application level: if a turn produced
 * no text, re-ask once with no tools at all and the already-retrieved passages
 * inlined.
 *
 * It is a fresh single-shot rather than a continuation of the broken turn —
 * there is no partial assistant message to repair, and the citation store
 * already holds every passage, so the [[cN]] ids still resolve.
 */
export function needsForcedAnswer(text: string, retrievedPassages: number): boolean {
  // Nothing was retrieved: a bare refusal or a bookInfo answer is legitimate
  // and carries no markers by design.
  if (retrievedPassages === 0) return false

  const trimmed = text.trim()
  if (trimmed.length === 0) return true

  // Passages were retrieved but nothing is cited — so this is not an answer.
  //
  // qwen3.8-flash interleaves commentary with its tool calls ("my first two
  // look-ups missed their mark — let me go at the Smith material properly"),
  // and `text` is the concatenation of every step's prose. That makes the
  // emptiness check useless: there IS text, it just isn't an answer. In an app
  // where every claim about a book must carry a marker, uncited prose over
  // retrieved passages is definitionally a failed turn.
  return !/\[\[c\d+\]\]/.test(trimmed)
}

export function forcedAnswerPrompt(formattedPassages: string): string {
  return (
    `These passages were retrieved from the user's library for their question:\n\n` +
    `${formattedPassages}\n\n` +
    `Answer the question now using only these passages. Cite each claim with its ` +
    `[[cN]] marker. Do not call any tools.`
  )
}
