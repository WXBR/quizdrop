// Turns the text pulled out of a slide deck into quiz questions using Claude.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

export const MAX_CHARS = 120_000
const MODEL = process.env.QUIZ_MODEL || 'claude-opus-5-5'
const LETTERS = ['A', 'B', 'C', 'D']

const Quiz = z.object({
  title: z.string().describe('Short name for the quiz, taken from the topic of the slides'),
  questions: z.array(
    z.object({
      q: z.string().describe('The question, one sentence'),
      options: z.array(z.string()).describe('Exactly four short answer options'),
      answer: z.enum(LETTERS).describe('Which option is correct, A is the first'),
      explain: z.string().describe('One or two sentences on why, shown after the answer is revealed'),
    }),
  ),
})

const SYSTEM = `You write live classroom quiz questions from lecture slides. The questions are played as a timed game: each one appears on a shared screen for about twenty seconds and students answer on their phones, so they have to be readable at a glance.

The text you get was extracted from slides automatically, so expect fragments, repeated headers, page numbers and stray bullet points. Work out what the lecture is teaching and ask about that. Ignore admin content such as lecturer names, dates and assessment logistics.

A good question tests whether someone understood the idea, not whether they memorised the wording of a slide. Mix straight recall with questions that apply a concept to a small example. Each question has exactly four options and exactly one correct answer. Wrong options should be mistakes a student could plausibly make, about the same length as the right one, with no "all of the above" or "none of the above". Keep questions under 200 characters and options under 80.

Only use what the slides support. If the slides are too thin for the number of questions asked for, return fewer rather than inventing material.`

export function canGenerate() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

class GenerateError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function shuffle(list) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export async function generateQuiz({ text, count }, client = new Anthropic()) {
  if (text.length > MAX_CHARS) {
    throw new GenerateError(413, `Those slides have ${text.length.toLocaleString()} characters of text and the limit is ${MAX_CHARS.toLocaleString()}. Try a shorter deck or split it.`)
  }

  let response
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Write ${count} questions from these slides.\n\n<slides>\n${text}\n</slides>` }],
      output_config: { effort: 'medium', format: zodOutputFormat(Quiz) },
    })
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new GenerateError(503, 'The server’s API key was rejected.')
    if (error instanceof Anthropic.RateLimitError) throw new GenerateError(429, 'The question writer is busy. Give it a minute.')
    if (error instanceof Anthropic.APIError) throw new GenerateError(502, 'The question writer had a problem. Try again.')
    throw error
  }

  if (response.stop_reason === 'refusal') throw new GenerateError(422, 'The model declined to write questions from those slides.')
  if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
    throw new GenerateError(502, 'The questions came back incomplete. Try asking for fewer.')
  }

  // Models like putting the right answer in the same slot, so shuffle each one.
  const questions = response.parsed_output.questions.map((item) => {
    const right = item.options[LETTERS.indexOf(item.answer)]
    const options = shuffle(item.options)
    return { q: item.q, options, answer: options.indexOf(right), explain: item.explain }
  })
  return { title: response.parsed_output.title, questions }
}
