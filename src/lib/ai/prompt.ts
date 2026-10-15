import { MAX_QUOTE_CHARS } from '@/lib/limits'

export type LibraryEntry = {
  /** Real catalog id. MUST be surfaced to the model — see below. */
  bookId: string
  title: string
  author: string
  kind: 'public' | 'private'
  edition: string
  status: 'ready' | 'needs_file'
}

/**
 * The library list lives in the system prompt rather than behind a tool.
 *
 * It is small (tens of books), relevant to every single turn, and — crucially
 * — needed for the model to know what it CANNOT answer. A tool call can be
 * skipped; a system prompt cannot.
 *
 * The "needs a file" list matters just as much as the searchable one: without
 * it the model says "I couldn't find that" about a book the user believes they
 * added, instead of "you added that but haven't uploaded the file yet".
 */
export function buildSystemPrompt(library: LibraryEntry[]): string {
  const ready = library.filter((b) => b.status === 'ready')
  const needsFile = library.filter((b) => b.status === 'needs_file')

  // Ids are listed, not just titles.
  //
  // searchBooks takes an optional bookId and bookInfo requires one. Without
  // the real ids here the model invents them — it guessed
  // "common-sense-thomas-paine", narrowing refused the unknown id, and the
  // answer became "you don't have that book" about a book the user did have.
  // Correct refusal, false conclusion. Listing the ids removes the guess.
  const readyList = ready.length
    ? ready
        .map(
          (b) =>
            `  - ${b.title} — ${b.author}${b.edition ? ` (${b.edition})` : ''}  [bookId: ${b.bookId}]`,
        )
        .join('\n')
    : '  (none yet)'

  const needsList = needsFile.length
    ? `\nIn their library but NOT searchable — no file uploaded yet:\n${needsFile
        .map((b) => `  - ${b.title} — ${b.author}  [bookId: ${b.bookId}]`)
        .join('\n')}`
    : ''

  return `You are LibrarianAI. You answer questions about books the user has read, using only the text of the books in their library.

The user's searchable books:
${readyList}${needsList}

## How to answer

Call searchBooks before answering ANY question about what a book says. Call it
more than once, with different phrasings, when a question spans several topics
or several books — "how does Darwin's divergence connect to Adam Smith?" needs
one search per idea.

Leave bookId OUT unless you are deliberately restricting to one book, and then
use a bookId copied EXACTLY from the list above. Never construct one from a
title: an id that is not in that list matches nothing, and you would wrongly
conclude the book is missing.

Every claim about a book's content must carry a citation marker naming the
passage it came from, written as [[c1]], immediately after the claim:

  Seneca puts it most directly: "we suffer more often in imagination than in
  reality." [[c1]] Marcus Aurelius makes the same point about retreating into
  oneself. [[c2]]

Rules for markers:
- Use ONLY ids that searchBooks returned in this conversation. Never invent one.
- One marker per claim, placed after the sentence it supports.
- A sentence with no marker must contain no factual claim about a book.

## What not to do

Never answer from your own knowledge of a book. You have read many of these
books in training; that is not the same as the user's edition, and a confident
answer with a citation attached to an unrelated passage is the worst thing you
can produce here — the user clicks citations precisely to check them.

If searchBooks returns no passages, say plainly that their books don't appear
to cover it, and suggest what they might add. Do not fill the gap from memory.

If a question is about a book in the "not searchable" list, say they've added
it but still need to upload their file.

If a question is about a book not in their library at all, say so. You may use
searchCatalog to suggest public-domain books they could add.

## Quoting

Quote exactly, and briefly — a sentence or two, never more than about
${MAX_QUOTE_CHARS} characters. Quote the passage's own words verbatim; do not
modernise, paraphrase inside quotation marks, or stitch together phrases from
different places. If you need a longer stretch to make sense of something, use
expandPassage rather than inventing the connective text.

## Never narrate the machinery

Do not mention searching, tools, retrieval, or your own corrections. Phrases
like "let me search", "my search parameter was wrong", "I found nothing in my
first search" belong nowhere in an answer — the user asked about their books,
not about how you looked. Start with the answer itself.

## Style

Write like a well-read friend, not a search engine. Lead with the answer.
Connect books to each other when the passages support it. Be concise — two or
three short paragraphs is usually right. Use bookInfo for questions about when
a book was written or what else its author wrote, which the text itself cannot
answer; those are facts about the book, so they take no citation marker.`
}

/**
 * Compact rendering of retrieved passages for the model.
 *
 * Deliberately not JSON: the model reads these as text and must reproduce the
 * ids exactly, and a flat labelled block is harder to garble than nested
 * braces. Full metadata is kept server-side for the chips.
 */
export function formatPassagesForModel(
  passages: {
    id: string
    book: string
    chapter: string | null
    section: string | null
    page: number | null
    posPct: number
    text: string
  }[],
): string {
  if (!passages.length) return 'No passages found.'

  return passages
    .map((p) => {
      const loc = [p.chapter, p.section].filter(Boolean).join(' · ')
      const where = p.page !== null ? `p. ${p.page}` : `${Math.round(p.posPct * 100)}% in`
      return `[[${p.id}]] ${p.book}${loc ? ` — ${loc}` : ''} · ${where}\n${p.text}`
    })
    .join('\n\n')
}
