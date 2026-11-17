// Game rules for one room. No sockets, no timers, no clock of its own:
// every function takes `now`, so the whole thing can be tested as plain data.

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

const BASE_POINTS = 500
const SPEED_POINTS = 500
const STREAK_STEP = 50
const STREAK_CAP = 5

const fail = (error) => ({ ok: false, error })
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

export function createRoom({ code, hostKey, quiz, now }) {
  return {
    code,
    hostKey,
    title: quiz.title,
    questions: quiz.questions,
    limitMs: quiz.seconds * 1000,
    phase: 'lobby', // lobby -> question -> reveal -> question ... -> final
    index: -1,
    startedAt: 0,
    players: new Map(),
    createdAt: now,
    touchedAt: now,
  }
}

export function join(room, { id, key, name, now }) {
  const clean = text(name, LIMITS.name)
  if (!clean) return fail('Pick a name first.')
  if (room.phase === 'final') return fail('That game has already finished.')
  if (room.players.size >= LIMITS.players) return fail('That room is full.')
  const taken = [...room.players.values()].some((p) => p.name.toLowerCase() === clean.toLowerCase())
  if (taken) return fail('Someone already has that name.')
  const player = { id, key, name: clean, score: 0, streak: 0, answers: [], connected: true, last: null }
  room.players.set(id, player)
  room.touchedAt = now
  return { ok: true, player }
}

function openQuestion(room, now) {
  room.index += 1
  room.phase = 'question'
  room.startedAt = now
  room.touchedAt = now
}

export function start(room, now) {
  if (room.phase !== 'lobby') return fail('The game has already started.')
  if (!room.players.size) return fail('Wait for at least one player.')
  openQuestion(room, now)
  return { ok: true }
}

export function answer(room, { id, choice, now }) {
  const player = room.players.get(id)
  if (!player) return fail('You are not in this room.')
  if (room.phase !== 'question') return fail('Too late for that one.')
  const question = room.questions[room.index]
  if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) return fail('Not an option.')
  if (player.answers[room.index]) return fail('You already answered.')
  const ms = Math.max(0, now - room.startedAt)
  if (ms > room.limitMs) return fail('Too late for that one.')
  player.answers[room.index] = { choice, ms }
  room.touchedAt = now
  return { ok: true, allIn: everyoneAnswered(room) }
}

export function everyoneAnswered(room) {
  const live = [...room.players.values()].filter((p) => p.connected)
  return live.length > 0 && live.every((p) => p.answers[room.index])
}

/** Faster answers earn more, and a run of correct answers adds a small bonus. */
export function points(ms, limitMs, streak) {
  const left = Math.max(0, 1 - ms / limitMs)
  const bonus = Math.min(Math.max(streak - 1, 0), STREAK_CAP) * STREAK_STEP
  return BASE_POINTS + Math.round(SPEED_POINTS * left) + bonus
}

export function reveal(room, now) {
  if (room.phase !== 'question') return fail('Nothing to reveal.')
  const question = room.questions[room.index]
  for (const player of room.players.values()) {
    const given = player.answers[room.index]
    const correct = !!given && given.choice === question.answer
    player.streak = correct ? player.streak + 1 : 0
    const gained = correct ? points(given.ms, room.limitMs, player.streak) : 0
    player.score += gained
    player.last = { correct, gained, choice: given ? given.choice : null }
  }
  room.phase = 'reveal'
  room.touchedAt = now
  return { ok: true }
}

export function next(room, now) {
  if (room.phase !== 'reveal') return fail('Finish this question first.')
  if (room.index + 1 >= room.questions.length) {
    room.phase = 'final'
    room.touchedAt = now
    return { ok: true, done: true }
  }
  openQuestion(room, now)
  return { ok: true, done: false }
}

export function ranking(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1, connected: p.connected }))
}

// What each side is allowed to see. The correct answer is only ever included
// once the room is in the reveal phase, so it can't be read off the network early.
function shared(room, now) {
  const question = room.questions[room.index]
  const playing = room.phase === 'question' || room.phase === 'reveal'
  const view = {
    code: room.code,
    title: room.title,
    phase: room.phase,
    index: room.index,
    total: room.questions.length,
    count: room.players.size,
  }
  if (playing) {
    view.question = { q: question.q, options: question.options }
    view.limitMs = room.limitMs
    view.leftMs = room.phase === 'question' ? Math.max(0, room.limitMs - (now - room.startedAt)) : 0
  }
  if (room.phase === 'reveal') {
    const counts = question.options.map(() => 0)
    for (const p of room.players.values()) {
      const given = p.answers[room.index]
      if (given) counts[given.choice] += 1
    }
    view.reveal = { answer: question.answer, counts, explain: question.explain }
  }
  return view
}

export function hostView(room, now) {
  const view = { role: 'host', ...shared(room, now), players: ranking(room) }
  if (room.phase === 'question') {
    view.answered = [...room.players.values()].filter((p) => p.answers[room.index]).length
  }
  return view
}

export function playerView(room, id, now) {
  const player = room.players.get(id)
  const board = ranking(room)
  const view = {
    role: 'player',
    ...shared(room, now),
    me: { name: player.name, score: player.score, streak: player.streak, rank: board.find((p) => p.id === id).rank },
  }
  if (room.phase === 'question' || room.phase === 'reveal') {
    const given = player.answers[room.index]
    view.choice = given ? given.choice : null
  }
  if (room.phase === 'reveal') view.result = player.last
  if (room.phase === 'final') view.top = board.slice(0, 3)
  return view
}
