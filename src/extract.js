// Pulls the text out of a slide deck in the browser, so the file itself never
// leaves the laptop. Only the text gets sent off to have questions written.

async function fromPdf(file) {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() })
  const doc = await task.promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      text += item.str + (item.hasEOL ? '\n' : ' ')
    }
    pages.push(text)
  }
  await task.destroy()
  return pages
}

async function fromPptx(file) {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const number = (name) => Number(name.match(/slide(\d+)\.xml$/)[1])
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => number(a) - number(b))
  const slides = []
  for (const name of names) {
    const xml = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml')
    const lines = [...xml.getElementsByTagName('a:p')].map((p) =>
      [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join(''),
    )
    slides.push(lines.filter((line) => line.trim()).join('\n'))
  }
  return slides
}

const tidy = (text) => text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

export const ACCEPT = '.pdf,.pptx,.txt,.md'

/** Returns { text, slides } where slides is how many pages had any text on them. */
export async function extractText(file) {
  const name = file.name.toLowerCase()
  let parts
  if (name.endsWith('.pdf')) parts = await fromPdf(file)
  else if (name.endsWith('.pptx')) parts = await fromPptx(file)
  else if (name.endsWith('.txt') || name.endsWith('.md')) parts = [await file.text()]
  else if (name.endsWith('.ppt')) throw new Error('Old .ppt files don’t work. Save it as .pptx or export a PDF.')
  else throw new Error('That file type doesn’t work. Use a PDF or a .pptx.')

  const filled = parts.map(tidy).filter(Boolean)
  if (!filled.length) throw new Error('Couldn’t find any text in there. If the slides are all images, this won’t work yet.')
  const text = filled.length === 1 ? filled[0] : filled.map((part, i) => `[Slide ${i + 1}]\n${part}`).join('\n\n')
  return { text, slides: filled.length }
}
