import { revalidatePath } from 'next/cache'

import { listUsers } from '@/lib/admin/data'
import { deleteUser, revokePassword } from '@/lib/admin/actions'
import { requireAdmin } from '@/lib/admin/session'
import { ConfirmButton } from '@/components/admin/confirm-button'

export default async function AdminUsersPage() {
  const users = await listUsers()

  async function remove(formData: FormData) {
    'use server'
    // Re-checked inside the action: a server action is a POST endpoint, so the
    // layout's guard does not protect it on its own.
    await requireAdmin()
    await deleteUser(String(formData.get('userId')))
    revalidatePath('/admin/users')
  }

  async function lockOut(formData: FormData) {
    'use server'
    await requireAdmin()
    await revokePassword(String(formData.get('userId')))
    revalidatePath('/admin/users')
  }

  const totals = users.reduce(
    (a, u) => ({
      books: a.books + u.bookCount,
      chunks: a.chunks + u.chunkCount,
      uploads: a.uploads + u.privateCount,
    }),
    { books: 0, chunks: 0, uploads: 0 },
  )

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-5 px-5 py-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="m-0 text-[clamp(24px,3.5vw,32px)]">Users</h1>
        <p className="m-0 text-[13px] text-muted">
          {users.length} {users.length === 1 ? 'account' : 'accounts'} · {totals.books} books ·{' '}
          {totals.uploads} uploads · {totals.chunks.toLocaleString()} passages
        </p>
      </div>

      {users.length === 0 ? (
        <p className="m-0 rounded-md border border-line bg-surface px-4 py-6 text-[15px] text-muted">
          No accounts yet.
        </p>
      ) : (
        <div className="scroll-x rounded-md border border-line bg-surface">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-left">
                {['Account', 'Joined', 'Books', 'Own uploads', 'Passages', 'Chats', ''].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold text-muted-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0 align-middle">
                  <td className="px-3 py-2.5">
                    <div className="font-semibold">{u.name ?? '—'}</div>
                    <div className="text-[12px] text-muted-2">{u.email ?? u.id}</div>
                    {!u.hasPassword && (
                      <span className="mt-1 inline-block rounded bg-warn-bg px-1.5 py-0.5 text-[11px] font-semibold text-warn-fg">
                        no password — cannot sign in
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted-2">
                    {u.createdAt ? u.createdAt.toISOString().slice(0, 10) : '—'}
                  </td>
                  <td className="px-3 py-2.5">{u.bookCount}</td>
                  <td className="px-3 py-2.5">{u.privateCount}</td>
                  <td className="px-3 py-2.5">{u.chunkCount.toLocaleString()}</td>
                  <td className="px-3 py-2.5">{u.chatCount}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <div className="flex flex-nowrap items-center justify-end gap-1.5">
                      {u.hasPassword && (
                        <form action={lockOut}>
                          <input type="hidden" name="userId" value={u.id} />
                          <ConfirmButton
                            label="Lock out"
                            confirm={`Clear the password for ${u.email ?? u.id}? Their library is kept; they just cannot sign in until a new password is set.`}
                            tone="neutral"
                          />
                        </form>
                      )}
                      <form action={remove}>
                        <input type="hidden" name="userId" value={u.id} />
                        <ConfirmButton
                          label="Delete"
                          confirm={`Permanently delete ${u.email ?? u.id}, their library, their ${u.privateCount} uploaded book(s) and ${u.chatCount} chat(s)? This cannot be undone.`}
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

      <p className="m-0 text-[12.5px] leading-relaxed text-faint">
        There is deliberately no way to read a user&apos;s uploaded book text from here. Counts,
        status and errors are enough to run the service, and an admin who could read private
        uploads would contradict what the app tells users in its own settings.
      </p>
    </div>
  )
}
