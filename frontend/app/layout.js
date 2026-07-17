import "./globals.css"

export const metadata = {
  title: "ClarityOps — Alert Intelligence Platform",
  description: "Next-Generation Alert Correlation & Deduplication Engine for Enterprise Observability",
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
