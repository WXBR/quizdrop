// Runs the same API as a normal server, for local development and for hosts
// that aren't serverless. If the client has been built, it serves that too.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createApp } from './app.js'

const PORT = Number(process.env.PORT) || 3001
const app = createApp()

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('/{*any}', (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(PORT, () => console.log(`quizdrop listening on http://localhost:${PORT}`))
