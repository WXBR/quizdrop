import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Keeps one WebSocket open to a room and reconnects if it drops.
 * `hello` returns the first message to send on every (re)connect, or null to
 * connect quietly and wait. `onMessage` sees every message that isn't state.
 */
export function useRoom(hello, onMessage) {
  const [state, setState] = useState(null)
  const [status, setStatus] = useState('connecting') // connecting | open | closed
  const [error, setError] = useState(null)
  const socket = useRef(null)
  const latest = useRef({ hello, onMessage })
  latest.current = { hello, onMessage }

  useEffect(() => {
    let stopped = false
    let retry = 0
    let timer

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${scheme}://${location.host}/ws`)
      socket.current = ws
      ws.onopen = () => {
        retry = 0
        setStatus('open')
        const first = latest.current.hello()
        if (first) ws.send(JSON.stringify(first))
      }
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.t === 'state') {
          // Stamp arrival time so countdowns run off the local clock, not the server's.
          setState({ ...message.state, at: performance.now() })
          setError(null)
        } else if (message.t === 'error') {
          setError(message)
          if (message.fatal) {
            stopped = true
            ws.close()
          }
        }
        latest.current.onMessage?.(message)
      }
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null
        if (event.code === 4000) {
          stopped = true
          setError({ error: 'This game was opened in another tab.', fatal: true })
        }
        if (event.code === 4001) {
          stopped = true
          setError({ error: 'This game has expired.', fatal: true })
        }
        setStatus(stopped ? 'closed' : 'connecting')
        if (!stopped) timer = setTimeout(connect, Math.min(4000, 400 * 2 ** retry++))
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      socket.current?.close()
    }
  }, [])

  const send = useCallback((message) => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(message))
    return true
  }, [])

  return { state, status, error, send, clearError: () => setError(null) }
}

/** Milliseconds left on the current question, ticking locally between server updates. */
export function useCountdown(state) {
  const running = state?.phase === 'question'
  const left = () => (running ? Math.max(0, state.leftMs - (performance.now() - state.at)) : 0)
  const [ms, setMs] = useState(left)
  useEffect(() => {
    setMs(left())
    if (!running) return
    const id = setInterval(() => setMs(left()), 100)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, state?.at])
  return ms
}
