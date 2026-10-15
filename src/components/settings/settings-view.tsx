'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function SettingsView({
  name,
  email,
  bookCount,
  privateCount,
}: {
  name: string
  email: string
  bookCount: number
  privateCount: number
}) {
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function saveName() {
    setBusy(true)
    try {
      await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function deleteEverything() {
    setBusy(true)
    try {
      const res = await fetch('/api/account', { method: 'DELETE' })
      if (res.ok) window.location.href = '/'
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-5 py-7">
      <h1 className="m-0 text-[clamp(28px,4vw,36px)]">Settings</h1>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow m-0">Account</h2>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Name
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={saveName}
            className="h-11 rounded-md border border-line-input bg-surface px-3 text-[15px] font-normal outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Email
          <input
            value={email}
            readOnly
            className="h-11 rounded-md border border-line bg-sidebar px-3 text-[15px] font-normal text-muted-2 outline-none"
          />
        </label>
        {saved && <span className="text-[12.5px] text-ok-fg">Saved</span>}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow m-0">Your data</h2>
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-muted">
          <div className="text-sm font-semibold text-ink">
            {bookCount} {bookCount === 1 ? 'book' : 'books'} in your library
            {privateCount > 0 && `, ${privateCount} your own ${privateCount === 1 ? 'copy' : 'copies'}`}
          </div>
          <p className="m-0 mt-1">
            Uploaded files are deleted once indexed. Your own books are never shared with other
            accounts, and nothing leaves this server except the text of a passage sent to the
            answering model when you ask a question.
          </p>
        </div>

        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="h-11 self-start rounded-md border border-accent px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent hover:text-surface"
          >
            Delete all my data
          </button>
        ) : (
          <div className="flex flex-col gap-3 rounded-md border border-accent bg-accent-soft px-4 py-3">
            <p className="m-0 text-sm leading-relaxed text-accent">
              This permanently deletes your account, your library, your uploaded books and every
              chat. Public-domain books stay in the shared catalog. This cannot be undone.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={deleteEverything}
                disabled={busy}
                className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-surface disabled:opacity-60"
              >
                {busy ? 'Deleting…' : 'Yes, delete everything'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-10 rounded-md border border-line-strong px-4 text-sm font-semibold text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
