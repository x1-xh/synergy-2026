"use client"

import { useEffect, useRef, useState } from "react"

export default function Home() {
  const [status, setStatus] = useState("loading")
  const id = useRef(null)

  useEffect(() => {
    const check = () => {
      fetch("http://localhost:8000/up")
        .then((r) => setStatus(r.ok ? "ok" : "error"))
        .catch(() => setStatus("error"))
    }

    check()
    id.current = setInterval(check, 5000)

    return () => clearInterval(id.current)
  }, [])

  const label =
    status === "loading"
      ? "checking..."
      : status === "ok"
        ? "all good"
        : "not ok"

  return (
    <main>
      <h1>app status</h1>
      <p className={status}>
        <span className="dot"></span>
        {label}
      </p>
    </main>
  )
}
