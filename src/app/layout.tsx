import type { Metadata, Viewport } from 'next'
import { EB_Garamond, Manrope } from 'next/font/google'

import './globals.css'

// Self-hosted by next/font — no runtime Google Fonts request, which matters
// for a PWA that should work on a flaky connection.
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-manrope',
  display: 'swap',
})

const garamond = EB_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-garamond',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'LibrarianAI',
  description:
    "Everything you've read, ready to answer. Ask a question in plain words and get the book, chapter and page it came from.",
  applicationName: 'LibrarianAI',
  appleWebApp: { capable: true, title: 'LibrarianAI', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  themeColor: '#F5F0E6',
  width: 'device-width',
  initialScale: 1,
  // The app is a full-screen shell; stop iOS zooming inputs on focus
  // without disabling user zoom entirely.
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${garamond.variable}`}>
      <body>{children}</body>
    </html>
  )
}
