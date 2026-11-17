import { useEffect, useMemo, useState } from 'react'
import { useCountdown, useRoom } from './useRoom.js'
import { openRoom } from './Home.jsx'
import { Dead, LETTERS, Ready, Shell, Tick, Timer, TONES } from './bits.jsx'

function Lobby({ state, send }) {
  const joinAt = location.host
  return (
    <main className="stage lobby">
      <p className="kicker">{state.title}</p>
      <p className="join-at">Join at <strong>{joinAt}</strong> with the code</p>
      <p className="code" aria-label={`Room code ${state.code.split('').join(' ')}`}>{state.code}</p>
      <ul className="names" aria-label="Players">
        {state.players.map((p) => <li key={p.id} className={p.connected ? '' : 'away'}>{p.name}</li>)}
      </ul>
      {!state.players.length && <p className="hint">Waiting for people to join.</p>}
      <button className="btn big" onClick={() => send('host', { action: 'start', from: state.index })} disabled={!state.players.length}>
        Start{state.players.length ? ` with ${state.players.length}` : ''}
      </button>
    </main>
  )
}

function Question({ state, send }) {
  const ms = useCountdown(state)
  const shown = state.phase === 'reveal'
  const last = state.index + 1 === state.total
  const most = shown ? Math.max(1, ...state.reveal.counts) : 1
  return (
    <main className="stage question">
      <div className="stage-top">
        <span className="kicker">Question {state.index + 1} of {state.total}</span>
        {shown ? <span className="kicker">{state.code}</span> : <span className="kicker">{state.answered} of {state.count} answered</span>}
      </div>
      <h1 className="q">{state.question.q}</h1>
      {!shown && <Timer ms={ms} limitMs={state.limitMs} />}

      <ul className={`notes${shown ? ' shown' : ''}`}>
        {state.question.options.map((option, i) => {
          const right = shown && i === state.reveal.answer
          return (
            <li key={i} className={`note ${TONES[i]}${right ? ' right' : ''}`}>
              <span className="letter">{LETTERS[i]}</span>
              <span className="option">{option}</span>
              {shown && (
                <span className="tally">
                  <i style={{ width: `${(state.reveal.counts[i] / most) * 100}%` }} />
                  <b>{state.reveal.counts[i]}</b>
                </span>
              )}
              {right && <Tick />}
            </li>
          )
        })}
      </ul>

      {shown ? (
        <div className="after">
          <div className="after-left">
            {state.reveal.explain && <p className="why">{state.reveal.explain}</p>}
            <button className="btn big" onClick={() => send('host', { action: 'next', from: state.index })} autoFocus>
              {last ? 'See who won' : 'Next question'}
            </button>
          </div>
          <ol className="board" aria-label="Leaderboard">
            {state.players.slice(0, 5).map((p) => (
              <li key={p.id}><span>{p.name}</span><b>{p.score.toLocaleString()}</b></li>
            ))}
          </ol>
        </div>
      ) : (
        <button className="link skip" onClick={() => send('host', { action: 'skip', from: state.index })}>end this question early</button>
      )}
    </main>
  )
}

function Final({ state, quiz }) {
  const [busy, setBusy] = useState(false)
  const [first, second, third] = state.players
  const again = async () => {
    setBusy(true)
    try {
      await openRoom(quiz)
    } catch {
      setBusy(false)
    }
  }
  return (
    <main className="stage final">
      <p className="kicker">{state.title}</p>
      {first ? (
        <>
          <ol className="podium">
            {[second, first, third].map((p, i) =>
              p ? (
                <li key={p.id} className={`step ${['second', 'first', 'third'][i]}`}>
                  <span className="who">{p.name}</span>
                  <span className="pts">{p.score.toLocaleString()}</span>
                  <span className="place">{[2, 1, 3][i]}</span>
                </li>
              ) : null,
            )}
          </ol>
          {state.players.length > 3 && (
            <ol className="board rest" start={4}>
              {state.players.slice(3).map((p) => (
                <li key={p.id}><span>{p.rank}. {p.name}</span><b>{p.score.toLocaleString()}</b></li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <h1 className="q">Nobody stuck around.</h1>
      )}
      <div className="row center">
        {quiz && <button className="btn" onClick={again} disabled={busy}>Play it again</button>}
        <a className="btn ghost" href="#/">New quiz</a>
      </div>
    </main>
  )
}

export default function Host({ code }) {
  const [saved] = useState(() => JSON.parse(sessionStorage.getItem(`quizdrop:host:${code}`) || 'null'))
  const seat = useMemo(() => (saved ? { key: saved.hostKey } : null), [saved])
  const { state, status, error, send } = useRoom(code, seat)

  // Space moves things along, so the host can run it from the keyboard.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== ' ' || event.target.closest('button, a, input')) return
      event.preventDefault()
      if (state?.phase === 'lobby') send('host', { action: 'start', from: state.index })
      if (state?.phase === 'reveal') send('host', { action: 'next', from: state.index })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state?.phase, state?.index, send])

  if (!saved) return <Dead message="This game was started somewhere else." />
  if (error?.fatal) return <Dead message={error.error} />
  if (!state) return <main className="page center"><p className="hint">Opening the room…</p></main>

  return (
    <Shell status={status} error={error}>
      {state.phase === 'lobby' && <Lobby state={state} send={send} />}
      {state.phase === 'ready' && <Ready state={state} />}
      {(state.phase === 'question' || state.phase === 'reveal') && <Question state={state} send={send} />}
      {state.phase === 'final' && <Final state={state} quiz={saved.quiz} />}
    </Shell>
  )
}
