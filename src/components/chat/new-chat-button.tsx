'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

/**
 * "New question".
 *
 * A plain <Link href="/chat"> looks right and does nothing when you are
 * already on /chat: same route, so React keeps the Chat component mounted and
 * useChat keeps every message from the previous question.
 *
 * push() then refresh() re-runs the server component, which mints a fresh chat
 * id. That id is Chat's `key`, so a new one remounts it and the conversation
 * genuinely starts empty.
 */
export function NewChatButton({ className, children }: { className?: string; children: React.ReactNode }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(() => {
          router.push('/chat')
          router.refresh()
        })
      }
      className={className}
    >
      {children}
    </button>
  )
}
