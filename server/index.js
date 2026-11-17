import { createServer } from 'node:http'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import * as game from './game.js'
import { canGenerate, generateQuiz } from './generate.js'

const PORT = Number(process.env.PORT) || 3001
const ROOM_TTL_MS = 2 * 60 * 60 * 1000
const GRACE_MS = 400 // lets an answer sent right on the buzzer still land
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I or O, they read as 1 and 0

const rooms = new Map() // code -> { room, timer, host: ws | null, sockets: Map<playerId, ws> }
const token = () => randomBytes(16).toString('hex')
const same = (given, real) => {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(real)
  return a.length === b.length && timingSafeEqual(a, b)
}

function newCode() {
  for (;;) {
    let code = ''
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)]
    if (!rooms.has(code)) return code
  }
}

// One small in-memory limiter. Enough to stop a single address hammering the
// endpoints that cost money or memory.
function limiter(max, windowMs) {
  const hits = new Map()
  return (req, res, next) => {
    const now = Date.now()
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < windowMs)
    if (recent.length >= max) return res.status(429).json({ error: 'Slow down a little and try again soon.' })
    recent.push(now)
    hits.set(req.ip, recent)
    if (hits.size > 5000) hits.clear()
    next()
  }
}

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size, generate: canGenerate() }))

app.post('/api/generate', limiter(6, 10 * 60 * 1000), async (req, res) => {
  if (!canGenerate()) return res.status(503).json({ error: 'This server has no API key set, so it can’t write questions. You can still play the sample quiz.' })
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  const count = Math.min(20, Math.max(3, Number(req.body?.count) || 10))
  if (text.length < 200) return res.status(400).json({ error: 'There isn’t enough text in those slides to write questions from.' })
  try {
    const checked = game.cleanQuiz(await generateQuiz({ text, count }))
    if (!checked.ok) return res.status(502).json({ error: checked.error })
    res.json(checked.quiz)
  } catch (error) {
    if (!error.status) console.error(error)
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong writing the questions.' })
  }
})

app.post('/api/rooms', limiter(20, 10 * 60 * 1000), (req, res) => {
  const checked = game.cleanQuiz(req.body)
  if (!checked.ok) return res.status(400).json({ error: checked.error })
  const code = newCode()
  const hostKey = token()
  rooms.set(code, { room: game.createRoom({ code, hostKey, quiz: checked.quiz, now: Date.now() }), timer: null, host: null, sockets: new Map() })
  res.json({ code, hostKey })
})

app.get('/api/rooms/:code', (req, res) => {
  const entry = rooms.get(String(req.params.code).toUpperCase())
  if (!entry) return res.status(404).json({ error: 'No game with that code.' })
  res.json({ code: entry.room.code, title: entry.room.title, phase: entry.room.phase })
})

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('/{*any}', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 })

const send = (ws, message) => ws && ws.readyState === ws.OPEN && ws.send(JSON.stringify(message))

function broadcast(entry) {
  const now = Date.now()
  send(entry.host, { t: 'state', state: game.hostView(entry.room, now) })
  for (const [id, ws] of entry.sockets) send(ws, { t: 'state', state: game.playerView(entry.room, id, now) })
}

function closeQuestion(entry) {
  clearTimeout(entry.timer)
  entry.timer = null
  if (game.reveal(entry.room, Date.now()).ok) broadcast(entry)
}

function armTimer(entry) {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => closeQuestion(entry), entry.room.limitMs + GRACE_MS)
}

const hostActions = {
  start(entry) {
    const out = game.start(entry.room, Date.now())
    if (out.ok) armTimer(entry)
    return out
  },
  skip(entry) {
    if (entry.room.phase !== 'question') return { ok: false, error: 'Nothing to skip.' }
    closeQuestion(entry)
    return { ok: true, quiet: true }
  },
  next(entry) {
    const out = game.next(entry.room, Date.now())
    if (out.ok && !out.done) armTimer(entry)
    return out
  },
}

function attach(ws, message) {
  const entry = rooms.get(String(message.code || '').toUpperCase())
  if (!entry) return send(ws, { t: 'error', error: 'No game with that code.', fatal: true })
  const { room } = entry

  if (message.t === 'host') {
    if (!same(message.hostKey, room.hostKey)) return send(ws, { t: 'error', error: 'That isn’t your game to host.', fatal: true })
    if (entry.host && entry.host !== ws) entry.host.close(4000, 'replaced')
    entry.host = ws
    ws.seat = { entry, host: true }
  } else if (message.t === 'rejoin') {
    const player = room.players.get(message.id)
    if (!player || !same(message.key, player.key)) return send(ws, { t: 'error', error: 'Couldn’t pick up where you left off.', fatal: true })
    const old = entry.sockets.get(player.id)
    if (old && old !== ws) old.close(4000, 'replaced')
    player.connected = true
    entry.sockets.set(player.id, ws)
    ws.seat = { entry, id: player.id }
  } else {
    const out = game.join(room, { id: token().slice(0, 12), key: token(), name: message.name, now: Date.now() })
    if (!out.ok) return send(ws, { t: 'error', error: out.error })
    entry.sockets.set(out.player.id, ws)
    ws.seat = { entry, id: out.player.id }
    send(ws, { t: 'joined', code: room.code, id: out.player.id, key: out.player.key })
  }
  broadcast(entry)
}

wss.on('connection', (ws) => {
  ws.alive = true
  ws.on('pong', () => (ws.alive = true))

  ws.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (!message || typeof message.t !== 'string') return
    if (!ws.seat) {
      if (['host', 'join', 'rejoin'].includes(message.t)) attach(ws, message)
      return
    }

    const { entry, host, id } = ws.seat
    let out
    if (host && Object.hasOwn(hostActions, message.t)) {
      out = hostActions[message.t](entry)
    } else if (!host && message.t === 'answer') {
      out = game.answer(entry.room, { id, choice: message.choice, now: Date.now() })
      if (out.ok && out.allIn) return closeQuestion(entry)
    } else {
      return
    }
    if (!out.ok) return send(ws, { t: 'error', error: out.error })
    if (!out.quiet) broadcast(entry)
  })

  ws.on('close', () => {
    if (!ws.seat) return
    const { entry, host, id } = ws.seat
    if (host) {
      if (entry.host === ws) entry.host = null
      return
    }
    if (entry.sockets.get(id) !== ws) return
    entry.sockets.delete(id)
    const player = entry.room.players.get(id)
    if (player) player.connected = false
    // Someone leaving shouldn't hold the question open for everyone else.
    if (entry.room.phase === 'question' && game.everyoneAnswered(entry.room)) return closeQuestion(entry)
    broadcast(entry)
  })
})

// Drop dead connections and rooms nobody has touched in a while.
const sweep = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate()
    else {
      ws.alive = false
      ws.ping()
    }
  }
  const now = Date.now()
  for (const [code, entry] of rooms) {
    if (now - entry.room.touchedAt < ROOM_TTL_MS) continue
    clearTimeout(entry.timer)
    entry.host?.close(4001, 'expired')
    for (const ws of entry.sockets.values()) ws.close(4001, 'expired')
    rooms.delete(code)
  }
}, 30_000)
sweep.unref()

server.listen(PORT, () => console.log(`quizdrop listening on http://localhost:${PORT}`))
