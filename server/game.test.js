import { describe, it, expect } from 'vitest'
import { cleanQuiz, points, GRACE_MS, LEAD_MS } from './game.js'
import { createApp } from './app.js'
import { createStore } from './store.js'

const quiz = {
  title: 'Test',
  seconds: 20,
  questions: [
    { q: 'One plus one?', options: ['1', '2', '3', '4'], answer: 1, explain: 'It is two.' },
    { q: 'Sky colour?', options: ['Blue', 'Green'], answer: 0, explain: '' },
  ],
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

describe('points', () => {
  it('rewards speed and streaks', () => {
    expect(points(0, 20000, 1)).toBe(1000)
    expect(points(20000, 20000, 1)).toBe(500)
    expect(points(10000, 20000, 3)).toBe(850)
    expect(points(0, 20000, 99)).toBe(1250)
  })
})

// The rest plays real games through the HTTP API, with the in-memory store and
// a clock the test controls. Each request is handled from stored facts alone,
// the same way it is in production.
async function setup() {
  let now = 1_000_000
  const app = createApp({ store: createStore({}), clock: () => now, generateReady: () => false })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://localhost:${server.address().port}/api`
  const call = async (path, { body, seat } = {}) => {
    const headers = { 'Content-Type': 'application/json' }
    if (seat) {
      headers['x-quizdrop-key'] = seat.key
      if (seat.id) headers['x-quizdrop-id'] = seat.id
    }
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) })
    return { status: res.status, ...(await res.json()) }
  }
  const { code, hostKey } = await call('/rooms', { body: quiz })
  const room = `/rooms/${code}`
  const host = { key: hostKey }
  const join = async (name) => {
    const out = await call(`${room}/join`, { body: { name } })
    return { id: out.id, key: out.key }
  }
  return {
    call,
    room,
    host,
    join,
    tick: (ms) => (now += ms),
    state: (seat) => call(`${room}/state`, { seat }),
    move: (action, from) => call(`${room}/host`, { seat: host, body: { action, from } }),
    answer: (seat, choice) => call(`${room}/answer`, { seat, body: { choice } }),
    close: () => server.close(),
  }
}

describe('joining', () => {
  it('refuses duplicate and empty names', async () => {
    const g = await setup()
    await g.join('Ada')
    expect((await g.call(`${g.room}/join`, { body: { name: 'ada' } })).status).toBe(409)
    expect((await g.call(`${g.room}/join`, { body: { name: '   ' } })).status).toBe(400)
    expect((await g.state(g.host)).players.map((p) => p.name)).toEqual(['Ada'])
    g.close()
  })

  it('gives the same name to only one of two people who ask at once', async () => {
    const g = await setup()
    const both = await Promise.all([g.call(`${g.room}/join`, { body: { name: 'Sam' } }), g.call(`${g.room}/join`, { body: { name: 'sam' } })])
    expect(both.map((r) => r.status).sort()).toEqual([200, 409])
    g.close()
  })

  it('says so when the room does not exist or the key is wrong', async () => {
    const g = await setup()
    expect((await g.call('/rooms/ZZZZ')).status).toBe(404)
    expect((await g.state({ key: 'nope' })).status).toBe(403)
    const ada = await g.join('Ada')
    expect((await g.state({ id: ada.id, key: 'nope' })).status).toBe(403)
    expect((await g.call(`${g.room}/host`, { seat: ada, body: { action: 'start', from: -1 } })).status).toBe(403)
    g.close()
  })
})

describe('a game', () => {
  it('needs a player before it starts', async () => {
    const g = await setup()
    expect((await g.move('start', -1)).status).toBe(400)
    g.close()
  })

  it('counts everyone in before the clock starts', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    expect((await g.move('start', -1)).phase).toBe('ready')
    const waiting = await g.state(ada)
    expect(waiting.inMs).toBe(LEAD_MS)
    expect(waiting.question).toBeUndefined()
    expect((await g.answer(ada, 1)).status).toBe(409)
    g.tick(LEAD_MS)
    expect((await g.state(ada)).phase).toBe('question')
    g.close()
  })

  it('plays through to a final ranking', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    const ben = await g.join('Ben')
    await g.move('start', -1)
    g.tick(LEAD_MS + 5000)

    expect((await g.answer(ada, 1)).phase).toBe('question')
    expect((await g.answer(ada, 0)).status).toBe(409) // one answer each
    expect((await g.answer(ben, 9)).status).toBe(400)
    expect((await g.state(g.host)).answered).toBe(1)

    // Ben answers wrong and is the last one in, which closes the question.
    const closed = await g.answer(ben, 0)
    expect(closed.phase).toBe('reveal')
    expect(closed.result).toEqual({ correct: false, gained: 0, choice: 0 })
    const reveal = await g.state(g.host)
    expect(reveal.reveal).toEqual({ answer: 1, counts: [1, 1, 0, 0], explain: 'It is two.' })
    expect(reveal.players.map((p) => [p.name, p.score])).toEqual([['Ada', 875], ['Ben', 0]])

    expect((await g.move('next', 0)).phase).toBe('ready')
    g.tick(LEAD_MS)
    await g.answer(ada, 0)
    await g.answer(ben, 0)
    const second = await g.state(ada)
    expect(second.me).toMatchObject({ score: 875 + 1050, streak: 2, rank: 1 }) // streak bonus
    expect((await g.state(ben)).me.score).toBe(1000)

    expect((await g.move('next', 1)).phase).toBe('final')
    const end = await g.state(ben)
    expect(end.me.rank).toBe(2)
    expect(end.top.map((p) => p.name)).toEqual(['Ada', 'Ben'])
    expect((await g.call(`${g.room}/join`, { body: { name: 'Late' } })).status).toBe(400)
    g.close()
  })

  it('closes a question by itself when time runs out', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    const ben = await g.join('Ben')
    await g.move('start', -1)
    g.tick(LEAD_MS + 1000)
    await g.answer(ada, 1)
    expect((await g.state(ada)).leftMs).toBe(19000)
    g.tick(19000 + GRACE_MS + 1)
    expect((await g.answer(ben, 1)).status).toBe(409)
    const out = await g.state(ben)
    expect(out.phase).toBe('reveal')
    expect(out.result).toEqual({ correct: false, gained: 0, choice: null })
    g.close()
  })

  it('does not wait for a player who has gone quiet', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    await g.join('Ben') // never heard from again
    await g.move('start', -1)
    g.tick(LEAD_MS + 13000)
    await g.state(ada)
    expect((await g.answer(ada, 1)).phase).toBe('reveal')
    g.close()
  })

  it('lets the host end a question early, and ignores a double click on next', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    await g.move('start', -1)
    await g.move('start', -1) // second click does nothing
    g.tick(LEAD_MS + 100)
    expect((await g.move('next', 0)).status).toBe(409) // can't skip ahead mid question
    expect((await g.move('skip', 0)).phase).toBe('reveal')
    expect((await g.answer(ada, 1)).status).toBe(409)

    const [first, again] = [await g.move('next', 0), await g.move('next', 0)]
    expect(first.index).toBe(1)
    expect(again.index).toBe(1)
    g.close()
  })

  it('keeps a mid-game joiner from changing a question that already closed', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    await g.move('start', -1)
    g.tick(LEAD_MS + 100)
    await g.answer(ada, 1)
    const late = await g.join('Cy')
    const seen = await g.state(late)
    expect(seen.phase).toBe('reveal')
    expect(seen.result.choice).toBe(null)
    expect((await g.answer(late, 1)).status).toBe(409)
    g.close()
  })
})

describe('what goes over the network', () => {
  it('never includes the answer while a question is open', async () => {
    const g = await setup()
    const ada = await g.join('Ada')
    const ben = await g.join('Ben')
    await g.move('start', -1)
    const early = JSON.stringify([await g.state(g.host), await g.state(ada)])
    g.tick(LEAD_MS + 100)
    const open = JSON.stringify([await g.answer(ada, 1), await g.state(g.host), await g.state(ada), await g.state(ben)])
    for (const blob of [early, open]) {
      expect(blob).not.toContain('"answer"')
      expect(blob).not.toContain('It is two.')
      expect(blob).not.toContain('hostKey')
      expect(blob).not.toContain(ben.key)
    }
    g.close()
  })
})
