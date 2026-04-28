import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'VOD Trimmer',
  description: 'AI-powered Twitch VOD dead air removal',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&display=swap" rel="stylesheet" />
      </head>
      <body style={{ margin: 0, padding: 0, background: '#0C0C0C', color: '#F0F0F0', fontFamily: "'Space Mono', monospace" }}>
        {children}
      </body>
    </html>
  )
}
