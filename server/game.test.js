import { describe, it, expect } from 'vitest'
import { cleanQuiz, createRoom, join, start, answer, reveal, next, points, hostView, playerView, ranking } from './game.js'

const quiz = {
  title: 'Test',
  seconds: 20,
  questions: [
    { q: 'One plus one?', options: ['1', '2', '3', '4'], answer: 1, explain: 'It is two.' },
    { q: 'Sky colour?', options: ['Blue', 'Green'], answer: 0, explain: '' },
  ],
}

function room() {
  const r = createRoom({ code: 'ABCD', hostKey: 'k', quiz: cleanQuiz(quiz).quiz, now: 0 })
  join(r, { id: 'a', key: 'ka', name: 'Ada', now: 0 })
  join(r, { id: 'b', key: 'kb', name: 'Ben', now: 0 })
  return r
}

describe('cleanQuiz', () => {
  it('drops broken questions and keeps the good ones', () => {
    const out = cleanQuiz({
      questions: [
        { q: 'ok', options: ['a', 'b'], answer: 1 },
        { q: '', options: ['a', 'b'], answer: 0 },
        { q: 'one option', options: ['a'], answer: 0 },
        { q: 'bad answer', options: ['a', 'b'], answer: 5 },
        { q: 'duplicates', options: ['a', 'a'], answer: 0 },
      ],
    })
    expect(out.ok).toBe(true)
    expect(out.quiz.questions).toHaveLength(1)
    expect(out.quiz.seconds).toBe(20)
  })

  it('keeps the answer pointing at the same option when blanks are removed', () => {
    const out = cleanQuiz({ questions: [{ q: 'x', options: ['', 'wrong', 'right'], answer: 2 }] })
    const q = out.quiz.questions[0]
    expect(q.options[q.answer]).toBe('right')
  })

  it('rejects a quiz with nothing usable', () => {
    expect(cleanQuiz({ questions: [] }).ok).toBe(false)
    expect(cleanQuiz(null).ok).toBe(false)
  })

  it('clamps the timer', () => {
    expect(cleanQuiz({ ...quiz, seconds: 999 }).quiz.seconds).toBe(60)
    expect(cleanQuiz({ ...quiz, seconds: 1 }).quiz.seconds).toBe(5)
  })
})

describe('joining', () => {
  it('refuses duplicate and empty names', () => {
    const r = room()
    expect(join(r, { id: 'c', key: 'kc', name: 'ada', now: 0 }).ok).toBe(false)
    expect(join(r, { id: 'c', key: 'kc', name: '   ', now: 0 }).ok).toBe(false)
  })

  it('lets someone join mid game but not after the end', () => {
    const r = room()
    start(r, 0)
    expect(join(r, { id: 'c', key: 'kc', name: 'Cy', now: 1 }).ok).toBe(true)
    r.phase = 'final'
    expect(join(r, { id: 'd', key: 'kd', name: 'Di', now: 1 }).ok).toBe(false)
  })
})

describe('a round', () => {
  it('needs a player before it starts', () => {
    const r = createRoom({ code: 'ABCD', hostKey: 'k', quiz: cleanQuiz(quiz).quiz, now: 0 })
    expect(start(r, 0).ok).toBe(false)
  })

  it('takes one answer per player and reports when everyone is in', () => {
    const r = room()
    start(r, 1000)
    expect(answer(r, { id: 'a', choice: 1, now: 2000 })).toEqual({ ok: true, allIn: false })
    expect(answer(r, { id: 'a', choice: 0, now: 2100 }).ok).toBe(false)
    expect(answer(r, { id: 'b', choice: 9, now: 2200 }).ok).toBe(false)
    expect(answer(r, { id: 'b', choice: 0, now: 2300 })).toEqual({ ok: true, allIn: true })
  })

  it('ignores answers after the time limit', () => {
    const r = room()
    start(r, 0)
    expect(answer(r, { id: 'a', choice: 1, now: 20001 }).ok).toBe(false)
  })

  it('does not wait for players who dropped off', () => {
    const r = room()
    start(r, 0)
    r.players.get('b').connected = false
    expect(answer(r, { id: 'a', choice: 1, now: 500 }).allIn).toBe(true)
  })

  it('scores speed and streaks', () => {
    expect(points(0, 20000, 1)).toBe(1000)
    expect(points(20000, 20000, 1)).toBe(500)
    expect(points(10000, 20000, 3)).toBe(850)
    expect(points(0, 20000, 99)).toBe(1250)
  })

  it('plays through to a final ranking', () => {
    const r = room()
    start(r, 0)
    answer(r, { id: 'a', choice: 1, now: 5000 })
    answer(r, { id: 'b', choice: 0, now: 1000 })
    reveal(r, 6000)
    expect(r.players.get('a').score).toBe(875)
    expect(r.players.get('b').score).toBe(0)

    expect(next(r, 7000)).toEqual({ ok: true, done: false })
    answer(r, { id: 'a', choice: 0, now: 7000 })
    reveal(r, 9000)
    expect(r.players.get('a').score).toBe(875 + 1050)
    expect(r.players.get('b').streak).toBe(0)

    expect(next(r, 9500)).toEqual({ ok: true, done: true })
    expect(r.phase).toBe('final')
    expect(ranking(r).map((p) => p.name)).toEqual(['Ada', 'Ben'])
  })

  it('cannot skip ahead or reveal twice', () => {
    const r = room()
    expect(next(r, 0).ok).toBe(false)
    start(r, 0)
    expect(next(r, 0).ok).toBe(false)
    reveal(r, 1)
    expect(reveal(r, 2).ok).toBe(false)
  })
})

describe('views', () => {
  it('never leaks the answer while a question is open', () => {
    const r = room()
    start(r, 0)
    answer(r, { id: 'a', choice: 1, now: 100 })
    const blob = JSON.stringify([hostView(r, 200), playerView(r, 'a', 200), playerView(r, 'b', 200)])
    expect(blob).not.toContain('"answer"')
    expect(blob).not.toContain('It is two.')
    expect(blob).not.toContain('hostKey')
    expect(blob).not.toContain('"key"')
  })

  it('shows the result once revealed', () => {
    const r = room()
    start(r, 0)
    answer(r, { id: 'a', choice: 1, now: 100 })
    reveal(r, 200)
    const host = hostView(r, 200)
    expect(host.reveal).toEqual({ answer: 1, counts: [0, 1, 0, 0], explain: 'It is two.' })
    expect(playerView(r, 'a', 200).result.correct).toBe(true)
    expect(playerView(r, 'b', 200).result).toEqual({ correct: false, gained: 0, choice: null })
  })

  it('counts down the time left', () => {
    const r = room()
    start(r, 0)
    expect(hostView(r, 5000).leftMs).toBe(15000)
    expect(hostView(r, 5000).answered).toBe(0)
  })
})
