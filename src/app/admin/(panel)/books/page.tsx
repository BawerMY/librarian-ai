import { revalidatePath } from 'next/cache'

import { ConfirmButton } from '@/components/admin/confirm-button'
import { deleteEdition, pruneOrphanBooks, reindexEdition } from '@/lib/admin/actions'
import { listEditions } from '@/lib/admin/data'
import { requireAdmin } from '@/lib/admin/session'

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-ok-bg text-ok-fg',
  failed: 'bg-accent-soft text-accent',
  awaiting_file: 'bg-warn-bg text-warn-fg',
  pending: 'bg-warn-bg text-warn-fg',
  parsing: 'bg-warn-bg text-warn-fg',
  embedding: 'bg-warn-bg text-warn-fg',
}

export default async function AdminBooksPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>
}) {
  const editions = await listEditions()
  const { msg } = await searchParams

  async function requeue(formData: FormData) {
    'use server'
    await requireAdmin()
    const result = await reindexEdition(String(formData.get('editionId')))
    revalidatePath('/admin/books')
    if (!result.ok) {
      const { redirect } = await import('next/navigation')
      redirect(`/admin/books?msg=${encodeURIComponent(result.reason ?? 'Could not re-queue.')}`)
    }
  }

  async function remove(formData: FormData) {
    'use server'
    await requireAdmin()
    await deleteEdition(String(formData.get('editionId')))
    revalidatePath('/admin/books')
  }

  async function prune() {
    'use server'
    await requireAdmin()
    const n = await pruneOrphanBooks()
    revalidatePath('/admin/books')
    const { redirect } = await import('next/navigation')
    redirect(`/admin/books?msg=${encodeURIComponent(`${n} catalog row(s) with no edition removed.`)}`)
  }

  const failed = editions.filter((e) => e.indexStatus === 'failed')
  const working = editions.filter((e) =>
    ['pending', 'parsing', 'embedding'].includes(e.indexStatus),
  )
  const chunks = editions.reduce((a, e) => a + (e.chunkCount ?? 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5 px-5 py-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="m-0 text-[clamp(24px,3.5vw,32px)]">Books</h1>
        <p className="m-0 text-[13px] text-muted">
          {editions.length} editions · {chunks.toLocaleString()} passages
          {working.length > 0 && ` · ${working.length} indexing`}
          {failed.length > 0 && ` · ${failed.length} failed`}
        </p>
      </div>

      {msg && (
        <p className="m-0 rounded-md border border-line-strong bg-surface p-3 text-sm text-ink">
          {msg}
        </p>
      )}

      {editions.length === 0 ? (
        <p className="m-0 rounded-md border border-line bg-surface px-4 py-6 text-[15px] text-muted">
          No editions yet. Books appear here once a user adds one.
        </p>
      ) : (
        <div className="scroll-x rounded-md border border-line bg-surface">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-left">
                {['Book', 'Kind', 'Owner', 'Status', 'Passages', 'In libraries', 'Model', ''].map(
                  (h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold text-muted-2">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {editions.map((e) => (
                <tr key={e.editionId} className="border-b border-line align-middle last:border-0">
                  <td className="px-3 py-2.5">
                    <div className="font-semibold">{e.title}</div>
                    <div className="text-[12px] text-muted-2">{e.author}</div>
                    {e.error && (
                      <div className="mt-1 max-w-[320px] text-[11.5px] leading-snug text-accent">
                        {e.error.slice(0, 180)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        e.kind === 'public' ? 'bg-sidebar text-ink-3' : 'bg-accent-soft text-accent'
                      }`}
                    >
                      {e.kind}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted-2">
                    {e.kind === 'public' ? 'shared' : (e.ownerEmail ?? '—')}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        STATUS_STYLE[e.indexStatus] ?? 'bg-sidebar text-ink-3'
                      }`}
                    >
                      {e.indexStatus}
                      {['pending', 'parsing', 'embedding'].includes(e.indexStatus) &&
                        ` ${e.progress}%`}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">{(e.chunkCount ?? 0).toLocaleString()}</td>
                  <td className="px-3 py-2.5">{e.holders}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-muted-2">
                    {e.embedModel ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <div className="flex flex-nowrap items-center justify-end gap-1.5">
                      <form action={requeue}>
                        <input type="hidden" name="editionId" value={e.editionId} />
                        <ConfirmButton
                          label="Re-index"
                          confirm={`Re-index "${e.title}"? It is parsed and embedded again, which takes minutes.`}
                          tone="neutral"
                        />
                      </form>
                      <form action={remove}>
                        <input type="hidden" name="editionId" value={e.editionId} />
                        <ConfirmButton
                          label="Delete"
                          confirm={
                            e.holders > 0
                              ? `"${e.title}" is in ${e.holders} librar${e.holders === 1 ? 'y' : 'ies'}. Deleting it removes the book and its ${(e.chunkCount ?? 0).toLocaleString()} passages for those users. Continue?`
                              : `Delete "${e.title}" and its ${(e.chunkCount ?? 0).toLocaleString()} passages?`
                          }
                          tone="danger"
                        />
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form action={prune} className="flex flex-wrap items-center gap-3">
        <ConfirmButton
          label="Prune catalog rows with no edition"
          confirm="Remove catalog entries that have no edition at all? These are leftovers from adds that never completed. No passages are affected."
          tone="neutral"
        />
        <span className="text-[12.5px] text-faint">
          Public editions are shared and kept even when nobody holds them — re-adding is then
          instant instead of a re-index.
        </span>
      </form>
    </div>
  )
}
