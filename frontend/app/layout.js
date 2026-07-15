import "./globals.css"

export const metadata = {
  title: "app status",
  description: "simple health check",
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
