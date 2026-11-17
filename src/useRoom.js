import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_MS = 1000

export async function api(path, { body, seat } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (seat) {
    headers['x-quizdrop-key'] = seat.key
    if (seat.id) headers['x-quizdrop-id'] = seat.id
  }
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || 'Something went wrong. Try again.')
    error.gone = !!data.gone
    throw error
  }
  return data
}

/**
 * Keeps a room's state fresh by asking the server about once a second, and
 * sooner when it knows something is about to change (a question opening or
 * running out). `seat` is { key } for the host or { id, key } for a player.
 */
export function useRoom(code, seat) {
  const [state, setState] = useState(null)
  const [status, setStatus] = useState('connecting') // connecting | open | closed
  const [error, setError] = useState(null)
  const newest = useRef(0) // stops a slow reply from overwriting a newer one
  const base = `/api/rooms/${code}`

  const take = useCallback((next, order) => {
    if (order < newest.current) return
    newest.current = order
    // Stamp arrival time so countdowns run off the local clock, not the server's.
    setState({ ...next, at: performance.now() })
    setStatus('open')
  }, [])

  useEffect(() => {
    if (!seat) return
    let stopped = false
    let timer

    const poll = async () => {
      const order = performance.now()
      let wait = POLL_MS
      try {
        const next = await api(`${base}/state`, { seat })
        if (stopped) return
        take(next, order)
        if (next.phase === 'final') return // nothing changes after this
        if (next.phase === 'ready') wait = Math.min(wait, next.inMs + 30)
        if (next.phase === 'question') wait = Math.min(wait, next.leftMs + 450)
      } catch (err) {
        if (stopped) return
        if (err.gone) {
          setStatus('closed')
          return setError({ error: err.message, fatal: true })
        }
        setStatus('connecting')
        wait = 2000
      }
      timer = setTimeout(poll, Math.max(150, wait))
    }

    // Phones pause timers in the background, so catch up as soon as the tab is back.
    const onShow = () => {
      if (document.visibilityState !== 'visible' || stopped) return
      clearTimeout(timer)
      poll()
    }
    document.addEventListener('visibilitychange', onShow)
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [base, seat, take])

  /** Sends a move ('answer' or 'host') and shows the state that comes back. */
  const send = useCallback(
    async (kind, body) => {
      const order = performance.now()
      try {
        take(await api(`${base}/${kind}`, { body, seat }), order)
        setError(null)
        return true
      } catch (err) {
        setError({ error: err.message, fatal: err.gone })
        return false
      }
    },
    [base, seat, take],
  )

  // Errors from a move are shown briefly, then cleared.
  useEffect(() => {
    if (!error || error.fatal) return
    const id = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(id)
  }, [error])

  return { state, status, error, send }
}

/** Milliseconds left until the question closes (or opens, while getting ready), ticking locally. */
export function useCountdown(state) {
  const total = state?.phase === 'question' ? state.leftMs : state?.phase === 'ready' ? state.inMs : null
  const left = () => (total === null ? 0 : Math.max(0, total - (performance.now() - state.at)))
  const [ms, setMs] = useState(left)
  useEffect(() => {
    setMs(left())
    if (total === null) return
    const id = setInterval(() => setMs(left()), 100)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.at])
  return ms
}
