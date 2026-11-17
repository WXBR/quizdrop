// Where rooms are kept. On Vercel this is Upstash Redis, reached over HTTPS.
// Without Redis settings it falls back to memory, which is what local
// development and the tests use.
import { Redis } from '@upstash/redis'

const TTL_SECONDS = 2 * 60 * 60
const roomKey = (code) => `quizdrop:room:${code}`
const quizKey = (code) => `quizdrop:quiz:${code}`

function redisStore(redis) {
  // A quiz never changes once its room exists, so each warm function keeps a copy
  // instead of fetching it again on every poll.
  const quizzes = new Map()
  return {
    kind: 'redis',
    async create(code, fields, quiz) {
      if (!(await redis.hsetnx(roomKey(code), 'meta', fields.meta))) return false
      const tx = redis.multi()
      tx.expire(roomKey(code), TTL_SECONDS)
      tx.set(quizKey(code), JSON.stringify(quiz), { ex: TTL_SECONDS })
      await tx.exec()
      return true
    },
    async read(code) {
      const fields = await redis.hgetall(roomKey(code))
      if (!fields?.meta) return null
      if (!quizzes.has(code)) {
        const quiz = await redis.get(quizKey(code))
        if (!quiz) return null
        if (quizzes.size > 200) quizzes.clear()
        quizzes.set(code, JSON.parse(quiz))
      }
      return { fields, quiz: quizzes.get(code) }
    },
    setOnce: async (code, name, value) => (await redis.hsetnx(roomKey(code), name, value)) === 1,
    set: (code, fields) => redis.hset(roomKey(code), fields),
    drop: (code, names) => (names.length ? redis.hdel(roomKey(code), ...names) : null),
    async hit(name, windowSeconds) {
      const key = `quizdrop:hits:${name}:${Math.floor(Date.now() / 1000 / windowSeconds)}`
      const tx = redis.multi()
      tx.incr(key)
      tx.expire(key, windowSeconds)
      const [count] = await tx.exec()
      return count
    },
  }
}

function memoryStore() {
  const rooms = new Map() // code -> { fields, quiz, expires }
  const hits = new Map()
  const live = (code) => {
    const room = rooms.get(code)
    if (room && room.expires < Date.now()) rooms.delete(code)
    return rooms.get(code)
  }
  return {
    kind: 'memory',
    async create(code, fields, quiz) {
      if (live(code)) return false
      rooms.set(code, { fields: { ...fields }, quiz, expires: Date.now() + TTL_SECONDS * 1000 })
      return true
    },
    async read(code) {
      const room = live(code)
      return room ? { fields: { ...room.fields }, quiz: room.quiz } : null
    },
    async setOnce(code, name, value) {
      const room = live(code)
      if (!room || name in room.fields) return false
      room.fields[name] = String(value)
      return true
    },
    async set(code, fields) {
      const room = live(code)
      if (room) for (const [name, value] of Object.entries(fields)) room.fields[name] = String(value)
    },
    async drop(code, names) {
      const room = live(code)
      if (room) for (const name of names) delete room.fields[name]
    },
    async hit(name, windowSeconds) {
      const key = `${name}:${Math.floor(Date.now() / 1000 / windowSeconds)}`
      if (hits.size > 5000) hits.clear()
      hits.set(key, (hits.get(key) || 0) + 1)
      return hits.get(key)
    },
  }
}

export function createStore(env = process.env) {
  // Vercel's Upstash integration uses the KV_ names, Upstash's own docs use the others.
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return memoryStore()
  // Values are stored as plain strings and parsed by the game code.
  return redisStore(new Redis({ url, token, automaticDeserialization: false }))
}
