import { ARTIFACT_PATH_CHARS, artifactPathProblem } from '@shared/artifact-files'
import { decodeText, eachStartTag } from '@shared/artifact-source'

const ORIGIN = 'https://artifact.invalid'
const VERSION = '/version/'

/** Local images in static markup that a preview of this version cannot load. */
export function htmlImageProblems(
  html: string,
  page: string,
  files: ReadonlyMap<string, number>,
  limit: number,
): string[] {
  const base = ORIGIN + VERSION + page.split('/').map(encodeURIComponent).join('/')
  const problems = new Set<string>()
  let hasBase = false
  eachStartTag(html, ({ name, attributes }) => {
    if (name === 'base' && attributes.some(({ name }) => name === 'href')) {
      hasBase = true
      return false
    }
    if (name !== 'img' || problems.size >= limit) return
    const target = decodeText(attributes.find(({ name }) => name === 'src')?.value ?? '').trim()
    if (!target || target.startsWith('#') || target.startsWith('?') || target.startsWith('//')) {
      return
    }
    const shown = JSON.stringify(target.slice(0, ARTIFACT_PATH_CHARS))
    if (/^(?:file:|[a-z]:[/\\]|[/\\])/i.test(target)) {
      problems.add(`${shown} needs a relative path to a file in the version`)
      return
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return
    const url = URL.parse(target, base)
    if (!url || url.origin !== ORIGIN || !url.pathname.startsWith(VERSION)) {
      problems.add(`${shown} needs a relative path to a file in the version`)
      return
    }
    let path: string
    try {
      path = decodeURIComponent(url.pathname.slice(VERSION.length))
    } catch {
      return
    }
    if (artifactPathProblem(path) === null && !files.has(path)) {
      problems.add(`${shown} is missing from the version`)
    }
  })
  // A base element can change how the browser resolves URLs anywhere in the document.
  return hasBase ? [] : [...problems].map((problem) => `${page}: ${problem}`)
}
