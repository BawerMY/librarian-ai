import Link from 'next/link'

const SIZES = {
  sm: { box: 'h-6 w-6 text-base', text: 'text-[19px]' },
  md: { box: 'h-[26px] w-[26px] text-lg', text: 'text-[21px]' },
  lg: { box: 'h-7 w-7 text-[19px]', text: 'text-[22px]' },
} as const

export function Logo({
  size = 'md',
  href = '/',
}: {
  size?: keyof typeof SIZES
  href?: string
}) {
  const s = SIZES[size]
  return (
    <Link href={href} className="flex items-center gap-2.5">
      <span
        className={`grid place-items-center rounded bg-accent font-serif text-surface ${s.box}`}
      >
        L
      </span>
      <span className={`font-serif font-medium tracking-[-0.01em] ${s.text}`}>LibrarianAI</span>
    </Link>
  )
}
