// Small pieces the host and player screens both use.
import { useCountdown } from './useRoom.js'

export const LETTERS = ['A', 'B', 'C', 'D']
export const TONES = ['yellow', 'blue', 'pink', 'green']

export const go = (path) => {
  window.location.hash = path
}

export function Timer({ ms, limitMs }) {
  const seconds = Math.ceil(ms / 1000)
  return (
    <div className={`timer${seconds <= 5 ? ' low' : ''}`} role="timer" aria-label={`${seconds} seconds left`}>
      <div className="timer-line"><i style={{ transform: `scaleX(${limitMs ? ms / limitMs : 0})` }} /></div>
      <span className="timer-num">{seconds}</span>
    </div>
  )
}

/** The short pause before a question, so every phone has it before the clock starts. */
export function Ready({ state }) {
  const ms = useCountdown(state)
  return (
    <main className="page center ready">
      <p className="kicker">Question {state.index + 1} of {state.total}</p>
      <p className="count-in" key={Math.ceil(ms / 1000)}>{Math.max(1, Math.ceil(ms / 1000))}</p>
      <p className="hint">Get ready</p>
    </main>
  )
}

export function Tick() {
  return (
    <svg className="tick" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 13.5l5 5L20 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Shell({ status, error, children }) {
  return (
    <>
      {children}
      {status === 'connecting' && <p className="toast" role="status">Reconnecting…</p>}
      {error && !error.fatal && <p className="toast bad" role="alert">{error.error}</p>}
    </>
  )
}

export function Dead({ message }) {
  return (
    <main className="page center">
      <h2>{message}</h2>
      <a className="btn" href="#/">Back to start</a>
    </main>
  )
}

export const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`
