import { describe, it, expect } from 'vitest'
import { generateQuiz, MAX_CHARS } from './generate.js'
import { cleanQuiz } from './game.js'

// A stand-in for the Anthropic client, so these run without a key or a network.
const fake = (reply) => {
  const calls = []
  return { calls, messages: { parse: async (params) => (calls.push(params), reply) } }
}

const reply = {
  stop_reason: 'end_turn',
  parsed_output: {
    title: 'Cells',
    questions: [
      { q: 'What makes energy?', options: ['Nucleus', 'Mitochondria', 'Ribosome', 'Wall'], answer: 'B', explain: 'It does.' },
      { q: 'What holds DNA?', options: ['Nucleus', 'Vacuole', 'Ribosome', 'Wall'], answer: 'A', explain: 'It does.' },
    ],
  },
}

describe('generateQuiz', () => {
  it('keeps the right answer right after shuffling the options', async () => {
    for (let run = 0; run < 20; run++) {
      const quiz = await generateQuiz({ text: 'slides', count: 2 }, fake(reply))
      expect(quiz.questions[0].options[quiz.questions[0].answer]).toBe('Mitochondria')
      expect(quiz.questions[1].options[quiz.questions[1].answer]).toBe('Nucleus')
      expect(cleanQuiz(quiz).quiz.questions).toHaveLength(2)
    }
  })

  it('sends the slides and a schema the API can enforce', async () => {
    const client = fake(reply)
    await generateQuiz({ text: 'the slide text', count: 7 }, client)
    const [params] = client.calls
    expect(params.messages[0].content).toContain('the slide text')
    expect(params.messages[0].content).toContain('7 questions')
    expect(params.output_config.format.type).toBe('json_schema')
  })

  it('refuses text that is too long instead of cutting it off', async () => {
    const client = fake(reply)
    await expect(generateQuiz({ text: 'x'.repeat(MAX_CHARS + 1), count: 5 }, client)).rejects.toMatchObject({ status: 413 })
    expect(client.calls).toHaveLength(0)
  })

  it('reports a refusal or a cut-off reply as an error', async () => {
    await expect(generateQuiz({ text: 's', count: 5 }, fake({ stop_reason: 'refusal', parsed_output: null }))).rejects.toMatchObject({ status: 422 })
    await expect(generateQuiz({ text: 's', count: 5 }, fake({ stop_reason: 'max_tokens', parsed_output: null }))).rejects.toMatchObject({ status: 502 })
  })
})
