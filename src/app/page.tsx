import Link from 'next/link'
import { Suspense } from 'react'

import { HeaderAuth, HeaderAuthFallback } from '@/components/ui/header-auth'
import { Logo } from '@/components/ui/logo'

/**
 * Landing page, from the design's Landing screen.
 *
 * The sample answer in the hero card is static illustration, deliberately
 * marked as such — it shows the citation chip the product produces without
 * pretending to be a live one.
 */
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-paper">
      <header className="flex items-center justify-between border-b border-line px-[clamp(18px,4vw,48px)] py-5">
        <Logo size="lg" />
        <div className="flex items-center gap-2">
          <Suspense fallback={<HeaderAuthFallback />}>
            <HeaderAuth />
          </Suspense>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-[1120px] grid-cols-1 items-center gap-[clamp(36px,5vw,64px)] px-[clamp(18px,4vw,48px)] pt-[clamp(48px,9vw,112px)] pb-[clamp(40px,6vw,72px)] lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <div className="text-xs font-bold uppercase tracking-[0.1em] text-accent">
            For people who read non-fiction
          </div>
          <h1 className="m-0 text-[clamp(44px,6.4vw,84px)] leading-[1.02] tracking-[-0.02em] text-balance">
            Everything you&apos;ve read, ready to answer.
          </h1>
          <p className="m-0 max-w-[520px] text-[17px] leading-relaxed text-muted text-pretty">
            Add the books you&apos;ve read. Ask a question in plain words, and LibrarianAI finds the
            answer across your whole library, with the book, chapter and page it came from.
          </p>
          <div className="mt-1 flex flex-wrap gap-2.5">
            <Link
              href="/signin"
              className="flex h-12 items-center rounded-md bg-accent px-[22px] text-[15px] font-semibold text-surface transition-colors hover:bg-accent-hover"
            >
              Build my library
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-[18px] rounded-[10px] border border-line bg-surface p-[clamp(20px,3vw,32px)] shadow-[0_1px_0_var(--color-line),0_24px_48px_-28px_rgba(34,28,24,0.25)]">
          <div className="self-end max-w-[86%] rounded-[10px_10px_2px_10px] bg-sidebar px-4 py-3 text-[15px] leading-normal">
            Where did I read that worrying is worse than the thing itself?
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="eyebrow">LibrarianAI</div>
            <p className="m-0 text-[15.5px] leading-[1.7]">
              Seneca puts it most directly:{' '}
              <span className="passage">
                &ldquo;we suffer more often in imagination than in reality.&rdquo;
              </span>{' '}
              <span className="inline-flex h-[22px] items-center rounded bg-accent-soft px-2 align-[1px] text-xs font-semibold whitespace-nowrap text-accent">
                Letters from a Stoic · Letter XIII · p. 48
              </span>
            </p>
            <p className="m-0 text-[15.5px] leading-[1.7] text-muted">
              Marcus Aurelius makes the same point in Book IV, and Epictetus gives the framework
              both rely on.
            </p>
            <p className="m-0 text-xs text-faint">An illustration, not a live answer.</p>
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-[clamp(28px,4vw,48px)] px-[clamp(18px,4vw,48px)] py-[clamp(40px,6vw,72px)] md:grid-cols-3">
          {[
            [
              'i.',
              'Add your books',
              'Pick from public-domain classics, or upload your own DRM-free EPUB or PDF.',
            ],
            [
              'ii.',
              'We read them for you',
              'Every book is indexed by chapter and section. Your uploads stay private to your account.',
            ],
            [
              'iii.',
              'Ask anything',
              'Find a half-remembered idea, or ask how two books relate. Every answer links to the exact passage.',
            ],
          ].map(([numeral, title, body]) => (
            <div key={numeral} className="flex flex-col gap-2.5">
              <div className="font-serif text-[40px] leading-none text-accent">{numeral}</div>
              <h3 className="m-0 text-[26px] font-medium">{title}</h3>
              <p className="m-0 text-[15px] leading-relaxed text-muted text-pretty">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="flex flex-wrap justify-between gap-4 border-t border-line px-[clamp(18px,4vw,48px)] py-6 text-[13px] text-faint">
        <a
          href="https://github.com/BawerMY/librarian-ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink-3 underline underline-offset-2 transition-colors hover:text-accent"
        >
          Source on GitHub
        </a>
        <span>
          Made by{' '}
          <a
            href="https://www.bawer-my.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink-3 underline underline-offset-2 transition-colors hover:text-accent"
          >
            Bawer Yavuzatmaca
          </a>
        </span>
      </footer>
    </div>
  )
}
