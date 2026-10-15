import { auth } from '@/auth'
import { SettingsView } from '@/components/settings/settings-view'
import { db } from '@/db'
import { getLibrary } from '@/lib/library'

export default async function SettingsPage() {
  const session = await auth()
  const userId = session!.user!.id!

  const [user, books] = await Promise.all([
    db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, userId) }),
    getLibrary(userId),
  ])

  return (
    <SettingsView
      name={user?.name ?? ''}
      email={user?.email ?? ''}
      bookCount={books.length}
      privateCount={books.filter((b) => b.kind === 'private').length}
    />
  )
}
