// The HTTP API. Every request is handled on its own: read the room's stored
// facts, work out the state for right now, maybe store one new fact, reply.
// That is what lets it run as a serverless function with nothing kept in memory.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import express from 'express'
import * as game from './game.js'
import { canGenerate, generateQuiz } from './generate.js'
import { createStore } from './store.js'

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I or O, they read as 1 and 0
const SEEN_EVERY_MS = 4000
const DAILY_GENERATE_CAP = Number(process.env.GENERATE_DAILY_CAP) || 60

const token = () => randomBytes(16).toString('hex')
const same = (given, real) => {
  if (typeof given !== 'string' || typeof real !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(real)
  return a.length === b.length && timingSafeEqual(a, b)
}

function newCode() {
  let code = ''
  for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)]
  return code
}

export function createApp({ store = createStore(), clock = Date.now, generate = generateQuiz, generateReady = canGenerate } = {}) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  const limit = (name, max, windowSeconds) => async (req, res, next) => {
    const count = await store.hit(`${name}:${req.ip}`, windowSeconds)
    if (count > max) return res.status(429).json({ error: 'Slow down a little and try again soon.' })
    next()
  }

  // Loads the room and works out who is asking from the key they send.
  const room = async (req, res, next) => {
    const code = String(req.params.code).toUpperCase()
    const stored = /^[A-Z]{4}$/.test(code) ? await store.read(code) : null
    const loaded = stored && game.parseRoom(stored.fields, stored.quiz)
    if (!loaded) return res.status(404).json({ error: 'No game with that code.', gone: true })
    req.code = code
    req.fields = stored.fields
    req.room = loaded

    const key = req.get('x-quizdrop-key')
    const id = req.get('x-quizdrop-id')
    if (key && !id && same(key, loaded.meta.hostKey)) req.who = { host: true }
    else if (key && id && same(key, loaded.players.get(id)?.key)) req.who = { id }
    next()
  }
  const seated = (req, res, next) => (req.who ? next() : res.status(403).json({ error: 'You are not in this game.', gone: true }))

  const reload = async (req) => {
    const stored = await store.read(req.code)
    req.fields = stored.fields
    req.room = game.parseRoom(stored.fields, stored.quiz)
  }
  const view = (req) => (req.who.host ? game.hostView(req.room, clock()) : game.playerView(req.room, req.who.id, clock()))

  app.get('/api/health', (req, res) => res.json({ ok: true, store: store.kind, generate: generateReady() }))

  app.post('/api/generate', limit('generate', 6, 600), async (req, res) => {
    if (!generateReady()) return res.status(503).json({ error: 'This server has no API key set, so it can’t write questions. You can still play the sample quiz.' })
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    const count = Math.min(20, Math.max(3, Number(req.body?.count) || 10))
    if (text.length < 200) return res.status(400).json({ error: 'There isn’t enough text in those slides to write questions from.' })
    // A ceiling for the whole site, so a busy day can't run up the bill.
    if ((await store.hit('generate:all', 86_400)) > DAILY_GENERATE_CAP) {
      return res.status(429).json({ error: 'That’s all the quizzes this site can write today. The sample quiz still works.' })
    }
    try {
      const checked = game.cleanQuiz(await generate({ text, count }))
      if (!checked.ok) return res.status(502).json({ error: checked.error })
      res.json(checked.quiz)
    } catch (error) {
      if (!error.status) console.error(error)
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong writing the questions.' })
    }
  })

  app.post('/api/rooms', limit('rooms', 20, 600), async (req, res) => {
    const checked = game.cleanQuiz(req.body)
    if (!checked.ok) return res.status(400).json({ error: checked.error })
    const hostKey = token()
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = newCode()
      const meta = game.newMeta({ code, hostKey, quiz: checked.quiz, now: clock() })
      if (await store.create(code, { meta: JSON.stringify(meta) }, checked.quiz)) return res.json({ code, hostKey })
    }
    res.status(503).json({ error: 'Couldn’t find a free room code. Try again.' })
  })

  app.get('/api/rooms/:code', room, (req, res) => {
    const { meta } = req.room
    res.json({ code: meta.code, title: meta.title, phase: meta.stage })
  })

  app.post('/api/rooms/:code/join', limit('join', 30, 600), room, async (req, res) => {
    const checked = game.join(req.room, req.body?.name)
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error })
    const player = { id: token().slice(0, 12), key: token(), name: checked.name }
    // Reserving the name is one atomic write, so two people can't both get it.
    if (!(await store.setOnce(req.code, game.field.name(player.name), player.id))) {
      return res.status(409).json({ error: 'Someone already has that name.' })
    }
    await store.set(req.code, { [game.field.player(player.id)]: JSON.stringify(player), [game.field.seen(player.id)]: clock() })
    res.json({ code: req.code, id: player.id, key: player.key })
  })

  app.get('/api/rooms/:code/state', room, seated, async (req, res) => {
    const now = clock()
    const { id } = req.who
    if (id && now - (req.room.seen.get(id) || 0) > SEEN_EVERY_MS) {
      req.room.seen.set(id, now)
      await store.set(req.code, { [game.field.seen(id)]: now })
    }
    // Whoever notices that everyone has answered closes the question. Only the
    // first write counts, so it doesn't matter how many notice at once.
    if (game.everyoneAnswered(req.room, now)) {
      await store.setOnce(req.code, game.field.closed(req.room.meta.index), now)
      await reload(req)
    }
    res.json(view(req))
  })

  app.post('/api/rooms/:code/answer', room, seated, async (req, res) => {
    if (req.who.host) return res.status(403).json({ error: 'The host doesn’t answer.' })
    const now = clock()
    const checked = game.answer(req.room, { id: req.who.id, choice: req.body?.choice, now })
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error })
    await store.setOnce(req.code, game.field.answer(checked.index, req.who.id), JSON.stringify(checked.given))
    await store.set(req.code, { [game.field.seen(req.who.id)]: now })
    await reload(req)
    if (game.everyoneAnswered(req.room, clock())) {
      await store.setOnce(req.code, game.field.closed(checked.index), clock())
      await reload(req)
    }
    res.json(view(req))
  })

  app.post('/api/rooms/:code/host', room, seated, async (req, res) => {
    if (!req.who.host) return res.status(403).json({ error: 'Only the host can do that.' })
    const now = clock()
    const move = game.hostMove(req.room, { action: req.body?.action, from: req.body?.from, now })
    if (!move.ok) return res.status(move.status).json({ error: move.error })
    if (move.close !== undefined) await store.setOnce(req.code, game.field.closed(move.close), now)
    if (move.write) {
      await store.set(req.code, Object.fromEntries(Object.entries(move.write).map(([name, value]) => [name, JSON.stringify(value)])))
    }
    if (move.drop !== undefined) {
      const done = Object.keys(req.fields).filter((name) => name.startsWith(`a:${move.drop}:`) || name === game.field.closed(move.drop))
      await store.drop(req.code, done)
    }
    await reload(req)
    res.json(view(req))
  })

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }))
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'That’s too much to send at once.' })
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Couldn’t read that.' })
    console.error(error)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
  })

  return app
}
