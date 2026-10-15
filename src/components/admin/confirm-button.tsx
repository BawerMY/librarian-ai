'use client'

/**
 * Submit button that asks first.
 *
 * Every destructive action in the admin panel is irreversible and operates on
 * someone else's data, so none of them is one stray click away. Uses the native
 * confirm deliberately: it cannot be missed, and it blocks the submit rather
 * than racing it.
 */
export function ConfirmButton({
  label,
  confirm,
  tone = 'neutral',
}: {
  label: string
  confirm: string
  tone?: 'neutral' | 'danger'
}) {
  return (
    <button
      type="submit"
      onClick={(e) => {
        if (!window.confirm(confirm)) e.preventDefault()
      }}
      className={
        tone === 'danger'
          ? 'h-8 whitespace-nowrap rounded-md border border-accent px-2.5 text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent hover:text-surface'
          : 'h-8 whitespace-nowrap rounded-md border border-line-strong px-2.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-ink'
      }
    >
      {label}
    </button>
  )
}
