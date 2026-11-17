// Game rules for one room.
//
// The server runs as short-lived functions, so there is no process to hold a
// room in memory or run a timer. Instead a room is a small set of stored facts
// (who joined, who answered what and when, which question the host is on) and
// everything else, including the phase and the scores, is worked out from those
// facts and the current time. Nothing here touches the store or the clock:
// every function takes the room and `now`.

export const LIMITS = {
  questions: 40,
  players: 60,
  name: 16,
  question: 300,
  option: 140,
  explain: 400,
  minSeconds: 5,
  maxSeconds: 60,
}

export const LEAD_MS = 3000 // "get ready" pause, so every phone has the question before the clock starts
export const GRACE_MS = 400 // lets an answer sent right on the buzzer still land
export const AWAY_MS = 12_000 // a player not heard from for this long doesn't hold up the room

const BASE_POINTS = 500
const SPEED_POINTS = 500
const STREAK_STEP = 50
const STREAK_CAP = 5

const fail = (error, status = 400) => ({ ok: false, error, status })
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Checks a quiz that came from outside (the generator or a user) and returns a clean copy. */
export function cleanQuiz(raw) {
  if (!raw || !Array.isArray(raw.questions)) return fail('That quiz has no questions.')
  const questions = []
  for (const item of raw.questions.slice(0, LIMITS.questions)) {
    const q = text(item?.q, LIMITS.question)
    const options = Array.isArray(item?.options)
      ? item.options.map((o) => text(o, LIMITS.option)).filter(Boolean).slice(0, 4)
      : []
    const picked = typeof item?.options?.[item?.answer] === 'string' ? text(item.options[item.answer], LIMITS.option) : ''
    const answer = options.indexOf(picked)
    if (!q || options.length < 2 || answer < 0) continue
    if (new Set(options).size !== options.length) continue
    questions.push({ q, options, answer, explain: text(item.explain, LIMITS.explain) })
  }
  if (!questions.length) return fail('None of the questions were usable.')
  const seconds = Math.min(LIMITS.maxSeconds, Math.max(LIMITS.minSeconds, Number(raw.seconds) || 20))
  return { ok: true, quiz: { title: text(raw.title, 80) || 'Untitled quiz', seconds, questions } }
}

export const cleanName = (name) => text(name, LIMITS.name)

export function newMeta({ code, hostKey, quiz, now }) {
  return { code, hostKey, title: quiz.title, limitMs: quiz.seconds * 1000, total: quiz.questions.length, stage: 'lobby', index: -1, startedAt: 0, createdAt: now }
}

// ---- stored facts <-> room -------------------------------------------------
// A room is kept as one flat set of fields so that each kind of write is a
// single atomic operation and two people acting at once can't clobber each other.
//   meta        the host's position: lobby / playing / final, question index, start time
//   totals      scores and streaks from questions already finished
//   p:<id>      a player
//   n:<name>    reserves a name (lowercased) so two people can't take it at once
//   a:<i>:<id>  a player's answer to question i, written once
//   c:<i>       when question i was closed early (everyone answered, or the host skipped)
//   s:<id>      when a player was last heard from

export const field = {
  player: (id) => `p:${id}`,
  name: (name) => `n:${name.toLowerCase()}`,
  answer: (index, id) => `a:${index}:${id}`,
  closed: (index) => `c:${index}`,
  seen: (id) => `s:${id}`,
}

export function parseRoom(fields, quiz) {
  if (!fields?.meta) return null
  const room = { meta: JSON.parse(fields.meta), totals: fields.totals ? JSON.parse(fields.totals) : {}, quiz, players: new Map(), answers: new Map(), closedAt: null, seen: new Map() }
  const current = room.meta.index
  for (const [key, value] of Object.entries(fields)) {
    const [kind, a, b] = key.split(':')
    if (kind === 'p') room.players.set(a, JSON.parse(value))
    else if (kind === 's') room.seen.set(a, Number(value))
    else if (kind === 'c' && Number(a) === current) room.closedAt = Number(value)
    else if (kind === 'a' && Number(a) === current) room.answers.set(b, JSON.parse(value))
  }
  return room
}

// ---- working things out ----------------------------------------------------

/** lobby -> ready -> question -> reveal -> ready ... -> final */
export function phaseOf(room, now) {
  const { stage, startedAt, limitMs } = room.meta
  if (stage !== 'playing') return stage
  if (now < startedAt) return 'ready'
  if (room.closedAt !== null || now > startedAt + limitMs + GRACE_MS) return 'reveal'
  return 'question'
}

/** Answers that count for the current question: in before it closed. */
function countedAnswers(room) {
  const counted = new Map()
  for (const [id, given] of room.answers) {
    if (room.closedAt !== null && given.at > room.closedAt) continue
    if (room.players.has(id)) counted.set(id, given)
  }
  return counted
}

/** Faster answers earn more, and a run of correct answers adds a small bonus. */
export function points(ms, limitMs, streak) {
  const left = Math.max(0, 1 - ms / limitMs)
  const bonus = Math.min(Math.max(streak - 1, 0), STREAK_CAP) * STREAK_STEP
  return BASE_POINTS + Math.round(SPEED_POINTS * left) + bonus
}

/** Scores and streaks once the current question is counted in, plus each player's result on it. */
export function settle(room) {
  const question = room.quiz.questions[room.meta.index]
  const counted = countedAnswers(room)
  const totals = {}
  const results = {}
  for (const id of room.players.keys()) {
    const before = room.totals[id] || { score: 0, streak: 0 }
    const given = counted.get(id)
    const correct = !!given && given.choice === question.answer
    const streak = correct ? before.streak + 1 : 0
    const gained = correct ? points(given.ms, room.meta.limitMs, streak) : 0
    totals[id] = { score: before.score + gained, streak }
    results[id] = { correct, gained, choice: given ? given.choice : null }
  }
  return { totals, results, counted }
}

function standing(room, now) {
  const phase = phaseOf(room, now)
  const settled = phase === 'reveal' ? settle(room) : null
  const totals = settled ? settled.totals : room.totals
  const board = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: totals[p.id]?.score || 0, streak: totals[p.id]?.streak || 0, connected: now - (room.seen.get(p.id) || 0) < AWAY_MS }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, i) => ({ ...p, rank: i + 1 }))
  return { phase, settled, board }
}

/** True when the question is open and everyone still around has answered. */
export function everyoneAnswered(room, now) {
  if (phaseOf(room, now) !== 'question') return false
  const here = [...room.players.keys()].filter((id) => now - (room.seen.get(id) || 0) < AWAY_MS)
  return here.length > 0 && here.every((id) => room.answers.has(id))
}

// ---- moves -----------------------------------------------------------------
// Each one checks the move against the room and says what to store. The caller
// does the storing.

export function join(room, name) {
  const clean = cleanName(name)
  if (!clean) return fail('Pick a name first.')
  if (room.meta.stage === 'final') return fail('That game has already finished.')
  if (room.players.size >= LIMITS.players) return fail('That room is full.')
  return { ok: true, name: clean }
}

export function answer(room, { id, choice, now }) {
  if (!room.players.has(id)) return fail('You are not in this room.', 403)
  if (phaseOf(room, now) !== 'question') return fail('Too late for that one.', 409)
  const question = room.quiz.questions[room.meta.index]
  if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) return fail('Not an option.')
  if (room.answers.has(id)) return fail('You already answered.', 409)
  const ms = Math.min(room.meta.limitMs, Math.max(0, now - room.meta.startedAt))
  return { ok: true, index: room.meta.index, given: { choice, ms, at: now } }
}

/** `from` is the question the host was looking at, so a double click can't skip one. */
export function hostMove(room, { action, from, now }) {
  const phase = phaseOf(room, now)
  const { meta } = room
  if (from !== meta.index) return { ok: true, write: null }

  if (action === 'start') {
    if (phase !== 'lobby') return { ok: true, write: null }
    if (!room.players.size) return fail('Wait for at least one player.')
    return { ok: true, write: { meta: { ...meta, stage: 'playing', index: 0, startedAt: now + LEAD_MS } } }
  }
  if (action === 'skip') {
    if (phase !== 'question') return { ok: true, write: null }
    return { ok: true, close: meta.index }
  }
  if (action === 'next') {
    if (phase !== 'reveal') return fail('Finish this question first.', 409)
    const { totals } = settle(room)
    const done = meta.index + 1 >= meta.total
    const next = done ? { ...meta, stage: 'final' } : { ...meta, index: meta.index + 1, startedAt: now + LEAD_MS }
    // The finished question's answers are folded into the totals and can be dropped.
    return { ok: true, write: { meta: next, totals }, drop: meta.index }
  }
  return fail('Unknown move.')
}

// ---- what each side is allowed to see ---------------------------------------
// The correct answer is only included once the question has closed, so it
// can't be read off the network early.

function shared(room, now, { phase, settled }) {
  const { meta } = room
  const view = { code: meta.code, title: meta.title, phase, index: meta.index, total: meta.total, count: room.players.size }
  if (phase === 'ready') view.inMs = meta.startedAt - now
  if (phase === 'question' || phase === 'reveal') {
    const question = room.quiz.questions[meta.index]
    view.question = { q: question.q, options: question.options }
    view.limitMs = meta.limitMs
    view.leftMs = phase === 'question' ? Math.max(0, meta.limitMs - (now - meta.startedAt)) : 0
    if (phase === 'reveal') {
      const counts = question.options.map(() => 0)
      for (const given of settled.counted.values()) counts[given.choice] += 1
      view.reveal = { answer: question.answer, counts, explain: question.explain }
    }
  }
  return view
}

const publicRow = ({ id, name, score, rank, connected }) => ({ id, name, score, rank, connected })

export function hostView(room, now) {
  const state = standing(room, now)
  const view = { role: 'host', ...shared(room, now, state), players: state.board.map(publicRow) }
  if (state.phase === 'question') view.answered = [...room.answers.keys()].filter((id) => room.players.has(id)).length
  return view
}

export function playerView(room, id, now) {
  const state = standing(room, now)
  const me = state.board.find((p) => p.id === id)
  const view = { role: 'player', ...shared(room, now, state), me: { name: me.name, score: me.score, streak: me.streak, rank: me.rank } }
  if (state.phase === 'question' || state.phase === 'reveal') view.choice = room.answers.get(id)?.choice ?? null
  if (state.phase === 'reveal') view.result = state.settled.results[id]
  if (state.phase === 'final') view.top = state.board.slice(0, 3).map(publicRow)
  return view
}
