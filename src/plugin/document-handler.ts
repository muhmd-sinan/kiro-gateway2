/**
 * Anthropic `document` blocks → Kiro `userInputMessage.documents`.
 *
 * Claude Code sends PDFs two ways: as a top-level `document` block when the user
 * attaches one, and nested inside a `tool_result` when its Read tool opens a
 * PDF. Both used to be dropped — the history builder only read text out of a
 * message, and getContentText only reads text out of a tool_result — so the
 * model answered questions about a file it never saw.
 *
 * Kiro accepts documents natively (DocumentBlock: name, format, bytes), verified
 * live: Sonnet 5 and Opus 5.5 both read text back out of a PDF sent this way.
 * Plain-text sources carry no binary to upload, so they are inlined as text,
 * which is also what Anthropic does with them.
 */

/** DocumentFormat values the Kiro SDK accepts, keyed by MIME type. */
const FORMAT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
}

/**
 * Per-message limits. Kiro documents none; these are Bedrock Converse's, which
 * the DocumentBlock shape mirrors. Exceeding them is reported in the message text
 * rather than failing the request.
 */
const MAX_DOCUMENTS = 5
const MAX_DOCUMENT_BYTES = 4_500_000

export interface KiroDocument {
  name: string
  format: string
  source: { bytes: Uint8Array }
}

export interface DocumentExtraction {
  documents: KiroDocument[]
  /** Text from plain-text sources, to append to the message content. */
  inlineText: string
  /** Documents seen but not attached (limits or unsupported formats). */
  omitted: number
}

interface RawDocument {
  mediaType: string
  data: string
  title?: string
}

function isDocumentBlock(block: any): boolean {
  return block?.type === 'document' && block.source && typeof block.source === 'object'
}

/**
 * Document blocks in a message, including ones nested in tool results.
 *
 * Only one level of nesting is walked: a tool_result's content is a flat list
 * of blocks in the Anthropic schema.
 */
function collectBlocks(content: unknown): any[] {
  if (!Array.isArray(content)) return []
  const blocks: any[] = []
  for (const block of content) {
    if (isDocumentBlock(block)) blocks.push(block)
    else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      for (const inner of block.content) if (isDocumentBlock(inner)) blocks.push(inner)
    }
  }
  return blocks
}

/** True when the message carries at least one document block. */
export function hasDocuments(content: unknown): boolean {
  return collectBlocks(content).length > 0
}

/**
 * Kiro document names: letters, digits, spaces, hyphens, parentheses and square
 * brackets (the Bedrock rule), no consecutive spaces, unique within a message.
 */
function sanitizeName(raw: string | undefined, index: number, used: Set<string>): string {
  let name = (raw ?? '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^A-Za-z0-9 \-()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  if (!name) name = `document ${index + 1}`
  let unique = name
  for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${name} (${n})`
  used.add(unique.toLowerCase())
  return unique
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export function extractDocuments(content: unknown): DocumentExtraction {
  const documents: KiroDocument[] = []
  const inline: string[] = []
  const used = new Set<string>()
  let omitted = 0

  const raws: RawDocument[] = []
  for (const block of collectBlocks(content)) {
    const source = block.source
    const title = typeof block.title === 'string' ? block.title : undefined

    if (source.type === 'text' && typeof source.data === 'string') {
      inline.push(title ? `[Document: ${title}]\n${source.data}` : source.data)
    } else if (source.type === 'content' && Array.isArray(source.content)) {
      const text = source.content
        .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
      if (text) inline.push(title ? `[Document: ${title}]\n${text}` : text)
    } else if (source.type === 'base64' && typeof source.data === 'string') {
      raws.push({
        mediaType: String(source.media_type || 'application/pdf'),
        data: source.data,
        title
      })
    } else {
      // URL and file-id sources would need a fetch or Anthropic's Files API;
      // Claude Code sends base64, so these are reported rather than chased.
      omitted++
    }
  }

  for (const raw of raws) {
    const format = FORMAT_BY_MIME[raw.mediaType.toLowerCase()]
    // base64 is 4 chars per 3 bytes, so this bound is checked without decoding.
    const approxBytes = Math.floor((raw.data.length * 3) / 4)
    if (!format || documents.length >= MAX_DOCUMENTS || approxBytes > MAX_DOCUMENT_BYTES) {
      omitted++
      continue
    }
    documents.push({
      name: sanitizeName(raw.title, documents.length, used),
      format,
      source: { bytes: base64ToBytes(raw.data) }
    })
  }

  return { documents, inlineText: inline.join('\n\n'), omitted }
}

/**
 * Apply an extraction to a Kiro userInputMessage in place: attach documents,
 * append inlined text, and note anything left out so the model does not answer
 * as if it had read a file it never received.
 */
export function attachDocuments(uim: any, extraction: DocumentExtraction): void {
  if (extraction.documents.length > 0) uim.documents = extraction.documents
  if (extraction.inlineText) {
    uim.content = uim.content ? `${uim.content}\n\n${extraction.inlineText}` : extraction.inlineText
  }
  if (extraction.omitted > 0) {
    uim.content += `\n\n[${extraction.omitted} document(s) omitted: unsupported format or over the size/count limit]`
  }
}
