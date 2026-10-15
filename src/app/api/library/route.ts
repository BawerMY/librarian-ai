import { auth } from '@/auth'
import { addBook, getLibrary, NotFoundError, removeBook, setSelected } from '@/lib/library'

/**
 * The user's shelf, and mutations to it.
 *
 * Every handler derives the user from the session and passes it down. The
 * client sends a bookId or editionId, never a userId — and removeBook /
 * setSelected re-check ownership against the database rather than trusting
 * the id that arrived over HTTP.
 */

async function userId(): Promise<string | null> {
  const session = await auth()
  return session?.user?.id ?? null
}

export async function GET() {
  const uid = await userId()
  if (!uid) return new Response('Unauthorized', { status: 401 })
  return Response.json({ books: await getLibrary(uid) })
}

export async function POST(req: Request) {
  const uid = await userId()
  if (!uid) return new Response('Unauthorized', { status: 401 })

  const { bookId } = (await req.json()) as { bookId?: string }
  if (!bookId) return Response.json({ error: 'bookId required' }, { status: 400 })

  try {
    const result = await addBook(uid, bookId)
    return Response.json(result)
  } catch (err) {
    if (err instanceof NotFoundError) {
      return Response.json({ error: err.message }, { status: 404 })
    }
    throw err
  }
}

export async function DELETE(req: Request) {
  const uid = await userId()
  if (!uid) return new Response('Unauthorized', { status: 401 })

  const { editionId } = (await req.json()) as { editionId?: string }
  if (!editionId) return Response.json({ error: 'editionId required' }, { status: 400 })

  await removeBook(uid, editionId)
  return Response.json({ ok: true })
}

export async function PATCH(req: Request) {
  const uid = await userId()
  if (!uid) return new Response('Unauthorized', { status: 401 })

  const { editionId, selected } = (await req.json()) as {
    editionId?: string
    selected?: boolean
  }
  if (!editionId || typeof selected !== 'boolean') {
    return Response.json({ error: 'editionId and selected required' }, { status: 400 })
  }

  await setSelected(uid, editionId, selected)
  return Response.json({ ok: true })
}
