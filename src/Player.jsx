import { useState } from 'react'
import { useCountdown, useRoom } from './useRoom.js'
import { Dead, LETTERS, ordinal, Shell, Tick, Timer, TONES } from './bits.jsx'

function NameForm({ code, onSubmit, error, ready }) {
  const [name, setName] = useState('')
  return (
    <main className="page center">
      <form className="join" onSubmit={(e) => { e.preventDefault(); onSubmit(name) }}>
        <p className="kicker">Room {code}</p>
        <label htmlFor="name">What should we call you?</label>
        <div className="row">
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={16} autoComplete="off" autoFocus placeholder="Your name" />
          <button className="btn" disabled={!name.trim() || !ready}>I’m in</button>
        </div>
        {error && <p className="error" role="alert">{error.error}</p>}
      </form>
    </main>
  )
}

function Answering({ state, send }) {
  const ms = useCountdown(state)
  const [sent, setSent] = useState(null) // shows the pick straight away, before the server confirms
  const picked = state.choice ?? sent
  const shown = state.phase === 'reveal'

  return (
    <main className="phone">
      <div className="stage-top">
        <span className="kicker">{state.index + 1} of {state.total}</span>
        <span className="kicker">{state.me.score.toLocaleString()} pts</span>
      </div>
      <h1 className="q">{state.question.q}</h1>
      {!shown && <Timer ms={ms} limitMs={state.limitMs} />}

      <div className={`notes${shown ? ' shown' : ''}${picked !== null ? ' picked' : ''}`}>
        {state.question.options.map((option, i) => (
          <button
            key={i}
            className={`note ${TONES[i]}${picked === i ? ' mine' : ''}${shown && i === state.reveal.answer ? ' right' : ''}`}
            disabled={shown || picked !== null || ms <= 0}
            aria-pressed={picked === i}
            onClick={() => send({ t: 'answer', choice: i }) && setSent(i)}
          >
            <span className="letter">{LETTERS[i]}</span>
            <span className="option">{option}</span>
            {shown && i === state.reveal.answer && <Tick />}
          </button>
        ))}
      </div>

      <div className="verdict" aria-live="polite">
        {shown ? (
          <>
            <p className={`big-word ${state.result.correct ? 'good' : 'bad'}`}>
              {state.result.correct ? `+${state.result.gained}` : state.result.choice === null ? 'Out of time' : 'Not quite'}
            </p>
            {state.result.correct && state.me.streak > 1 && <p className="hint">{state.me.streak} in a row</p>}
            <p className="hint">You’re {ordinal(state.me.rank)} of {state.count}</p>
            {state.reveal.explain && <p className="why">{state.reveal.explain}</p>}
          </>
        ) : picked !== null ? (
          <p className="hint">Locked in. Waiting for the others.</p>
        ) : null}
      </div>
    </main>
  )
}

export default function Player({ code }) {
  const storeKey = `quizdrop:player:${code}`
  const [seat, setSeat] = useState(() => JSON.parse(sessionStorage.getItem(storeKey) || 'null'))

  const { state, status, error, send } = useRoom(
    () => (seat ? { t: 'rejoin', code, id: seat.id, key: seat.key } : null),
    (message) => {
      if (message.t === 'joined') {
        const next = { id: message.id, key: message.key }
        sessionStorage.setItem(storeKey, JSON.stringify(next))
        setSeat(next)
      }
      // A seat the server no longer knows about is useless, so forget it.
      if (message.t === 'error' && message.fatal) sessionStorage.removeItem(storeKey)
    },
  )

  if (error?.fatal) return <Dead message={error.error} />
  if (!seat) return <NameForm code={code} error={error} ready={status === 'open'} onSubmit={(name) => send({ t: 'join', code, name })} />
  if (!state) return <main className="page center"><p className="hint">Joining…</p></main>

  return (
    <Shell status={status} error={error}>
      {state.phase === 'lobby' && (
        <main className="page center">
          <p className="kicker">{state.title}</p>
          <h2>You’re in, {state.me.name}.</h2>
          <p className="hint">Watch the big screen. It starts when the host is ready.</p>
          <p className="hint">{state.count} {state.count === 1 ? 'player' : 'players'} so far</p>
        </main>
      )}
      {(state.phase === 'question' || state.phase === 'reveal') && <Answering key={state.index} state={state} send={send} />}
      {state.phase === 'final' && (
        <main className="page center">
          <p className="kicker">{state.title}</p>
          <p className="big-word good">{ordinal(state.me.rank)}</p>
          <h2>{state.me.score.toLocaleString()} points</h2>
          <ol className="board">
            {state.top.map((p) => <li key={p.id}><span>{p.rank}. {p.name}</span><b>{p.score.toLocaleString()}</b></li>)}
          </ol>
          <a className="btn ghost" href="#/">Done</a>
        </main>
      )}
    </Shell>
  )
}
