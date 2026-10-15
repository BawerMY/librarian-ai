import { auth } from '@/auth'
import { LibraryView } from '@/components/library/library-view'
import { getLibrary } from '@/lib/library'

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>
}) {
  const session = await auth()
  const userId = session!.user!.id!

  const { q, tab } = await searchParams
  const books = await getLibrary(userId)

  // Land on "Add books" when the shelf is empty — an empty shelf with an
  // empty-state card is one click of friction for no reason.
  const initialTab = tab === 'add' || books.length === 0 ? 'add' : 'mine'

  return (
    <LibraryView initialBooks={books} initialTab={initialTab} initialQuery={q ?? ''} />
  )
}
