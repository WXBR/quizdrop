import { useEffect, useRef, useState } from 'react'
import { ACCEPT, extractText } from './extract.js'
import { sample } from './sample.js'
import { go, LETTERS } from './bits.jsx'

const DRAFT = 'quizdrop:draft'

async function api(path, body) {
  const res = await fetch(path, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.')
  return data
}

export async function openRoom(quiz) {
  const { code, hostKey } = await api('/api/rooms', quiz)
  sessionStorage.setItem(`quizdrop:host:${code}`, JSON.stringify({ hostKey, quiz }))
  go(`/host/${code}`)
}

function JoinForm() {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault()
    try {
      const room = await api(`/api/rooms/${encodeURIComponent(code)}`)
      go(`/play/${room.code}`)
    } catch (err) {
      setError(err.message)
    }
  }
  return (
    <form className="join" onSubmit={submit}>
      <label htmlFor="code">Got a code?</label>
      <div className="row">
        <input
          id="code"
          className="code-input"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))
            setError('')
          }}
          placeholder="ABCD"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
        />
        <button className="btn" disabled={code.length !== 4}>Join</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  )
}

function DropZone({ onQuiz }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [over, setOver] = useState(false)
  const [count, setCount] = useState(10)
  const [canGenerate, setCanGenerate] = useState(true)
  const input = useRef(null)

  useEffect(() => {
    api('/api/health').then((health) => setCanGenerate(health.generate)).catch(() => {})
  }, [])

  const take = async (file) => {
    if (!file || busy) return
    setError('')
    try {
      setBusy('Reading your slides')
      const { text, slides } = await extractText(file)
      setBusy(`Writing ${count} questions from ${slides} ${slides === 1 ? 'page' : 'slides'}`)
      const quiz = await api('/api/generate', { text, count })
      onQuiz(quiz)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="make">
      <button
        type="button"
        className={`drop${over ? ' over' : ''}${busy ? ' busy' : ''}`}
        onClick={() => input.current.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take(e.dataTransfer.files[0])
        }}
        disabled={!!busy}
        aria-live="polite"
      >
        {busy ? (
          <>
            <span className="drop-title">{busy}<span className="dots" aria-hidden="true" /></span>
            <span className="drop-sub">This usually takes under a minute.</span>
          </>
        ) : (
          <>
            <span className="drop-title">Drop your slides here</span>
            <span className="drop-sub">PDF or PowerPoint. Or click to pick a file.</span>
          </>
        )}
      </button>
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { take(e.target.files[0]); e.target.value = '' }} />
      {error && <p className="error" role="alert">{error}</p>}
      {!canGenerate && !error && <p className="hint">This server has no API key set, so it can’t write questions from slides right now. The sample quiz still works.</p>}
      <div className="make-foot">
        <label>
          Questions
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={!!busy}>
            {[5, 10, 15, 20].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" className="link" onClick={() => onQuiz(structuredClone(sample))} disabled={!!busy}>
          or try the sample quiz
        </button>
      </div>
    </div>
  )
}

function Review({ quiz, setQuiz, onBack }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const patch = (i, change) => setQuiz({ ...quiz, questions: quiz.questions.map((q, n) => (n === i ? { ...q, ...change } : q)) })

  const open = async () => {
    setBusy(true)
    setError('')
    try {
      await openRoom(quiz)
      sessionStorage.removeItem(DRAFT)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <main className="page review">
      <button className="link back" onClick={onBack}>← start over</button>
      <input className="title-input" value={quiz.title} onChange={(e) => setQuiz({ ...quiz, title: e.target.value })} aria-label="Quiz title" maxLength={80} />
      <p className="lede">Have a read before you open the room. Fix anything that’s off, tick the right answer, or bin a question.</p>

      <ol className="cards">
        {quiz.questions.map((item, i) => (
          <li key={i} className="card">
            <div className="card-head">
              <span className="num">{i + 1}</span>
              <textarea value={item.q} rows={2} onChange={(e) => patch(i, { q: e.target.value })} aria-label={`Question ${i + 1}`} maxLength={300} />
              <button className="bin" onClick={() => setQuiz({ ...quiz, questions: quiz.questions.filter((_, n) => n !== i) })} aria-label={`Remove question ${i + 1}`}>×</button>
            </div>
            <ul className="opts">
              {item.options.map((option, o) => (
                <li key={o} className={o === item.answer ? 'right' : ''}>
                  <label title="Mark as the right answer">
                    <input type="radio" name={`answer-${i}`} checked={o === item.answer} onChange={() => patch(i, { answer: o })} />
                    <span className="letter">{LETTERS[o]}</span>
                  </label>
                  <input
                    value={option}
                    onChange={(e) => patch(i, { options: item.options.map((v, n) => (n === o ? e.target.value : v)) })}
                    aria-label={`Question ${i + 1} option ${LETTERS[o]}`}
                    maxLength={140}
                  />
                </li>
              ))}
            </ul>
            {item.explain && <p className="why">{item.explain}</p>}
          </li>
        ))}
      </ol>

      <div className="review-foot">
        <label>
          Seconds per question
          <select value={quiz.seconds} onChange={(e) => setQuiz({ ...quiz, seconds: Number(e.target.value) })}>
            {[10, 15, 20, 30, 45].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn big" onClick={open} disabled={busy || !quiz.questions.length}>
          {busy ? 'Opening' : `Open the room · ${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  )
}

export default function Home() {
  // The draft survives a refresh so a generated quiz isn't lost by accident.
  const [quiz, setQuizState] = useState(() => JSON.parse(sessionStorage.getItem(DRAFT) || 'null'))
  const setQuiz = (next) => {
    setQuizState(next)
    if (next) sessionStorage.setItem(DRAFT, JSON.stringify(next))
    else sessionStorage.removeItem(DRAFT)
  }

  if (quiz) return <Review quiz={quiz} setQuiz={setQuiz} onBack={() => setQuiz(null)} />

  return (
    <main className="page home">
      <header>
        <h1>Quizdrop</h1>
        <p className="lede">Drop in your lecture slides and get a live quiz the whole class can join from their phones.</p>
      </header>
      <DropZone onQuiz={(made) => setQuiz({ seconds: 20, ...made })} />
      <JoinForm />
      <footer>
        <a href="https://github.com/WXBR/quizdrop">Source on GitHub</a>
      </footer>
    </main>
  )
}
