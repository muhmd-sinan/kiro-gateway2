interface UnifiedImage {
  mediaType: string
  data: string
}

const MAX_KIRO_IMAGES = 4
const MAX_KIRO_IMAGE_BYTES = 3_750_000

/**
 * ImageFormat values the Kiro SDK accepts (gif, jpeg, png, webp), keyed by MIME
 * subtype. `jpg` is not a valid ImageFormat, so `image/jpg` (which some clients
 * send) has to map to `jpeg`. Anything else is outside the enum and is omitted
 * with a note instead of being sent.
 */
const FORMAT_BY_SUBTYPE: Record<string, string> = {
  png: 'png',
  jpeg: 'jpeg',
  jpg: 'jpeg',
  pjpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp'
}

interface KiroImage {
  format: string
  source: {
    bytes: Uint8Array
  }
}

interface ImageConversionResult {
  images: KiroImage[]
  omitted: number
}

/** Decode base64 to a plain Uint8Array (NOT Buffer) to avoid Buffer.toJSON() trap. */
function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function kiroImageFormat(mediaType: string): string | undefined {
  const subtype = mediaType.toLowerCase().split('/')[1]?.split(';')[0]?.trim()
  return subtype ? FORMAT_BY_SUBTYPE[subtype] : undefined
}

function extractImagesFromAnthropicFormat(content: any[]): UnifiedImage[] {
  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image' && item.source?.type === 'base64') {
      images.push({
        mediaType: item.source.media_type || 'image/jpeg',
        data: item.source.data
      })
    }
  }

  return images
}

function extractImagesFromOpenAI(content: any[]): UnifiedImage[] {
  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image_url' && item.image_url?.url) {
      const url = item.image_url.url

      if (url.startsWith('data:')) {
        try {
          const [header, data] = url.split(',', 2)
          if (!data) continue

          const mediaType = header.split(';')[0].replace('data:', '')

          images.push({
            mediaType: mediaType || 'image/jpeg',
            data: data
          })
        } catch (e) {
          continue
        }
      }
    }
  }

  return images
}

function extractImagesFromBlocks(content: any[]): UnifiedImage[] {
  return [...extractImagesFromAnthropicFormat(content), ...extractImagesFromOpenAI(content)]
}

/**
 * Images in a message, including ones nested in tool results.
 *
 * Claude Code returns screenshots (browser/Playwright tools) and image files
 * opened by its Read tool as `image` blocks inside a `tool_result`. Kiro's
 * ToolResultContentBlock only has `text` and `json`, so those images can't ride
 * on the tool result; callers attach them to the same userInputMessage's
 * `images`, next to the tool results. Before this walk, getContentText reduced
 * such a tool_result to its text (often empty) and the model answered about a
 * screenshot it never received. Only one level is walked, as in
 * document-handler.ts: a tool_result's content is a flat list of blocks.
 */
export function extractAllImages(content: any): UnifiedImage[] {
  if (!Array.isArray(content)) return []

  const images = extractImagesFromBlocks(content)
  for (const block of content) {
    if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      images.push(...extractImagesFromBlocks(block.content))
    }
  }
  return images
}

/**
 * Text for a tool_result whose only content is images.
 *
 * The images ride on the userInputMessage (see extractAllImages), so
 * getContentText reduced such a result — every Playwright screenshot — to an
 * empty text block, which tells the model nothing about which result the
 * attached image belongs to.
 */
export function imageOnlyToolResultText(block: any): string {
  if (!Array.isArray(block?.content)) return ''
  const count = extractImagesFromBlocks(block.content).length
  return count > 0 ? `[image result: ${count} image(s)]` : ''
}

export function convertImagesToKiroFormat(images: UnifiedImage[]): ImageConversionResult {
  const selected: KiroImage[] = []
  let totalBase64Chars = 0

  for (const img of images) {
    if (selected.length >= MAX_KIRO_IMAGES) break
    // continue, not break: one oversized image used to drop every image after
    // it, including small ones that fit the remaining budget.
    if (totalBase64Chars + img.data.length > MAX_KIRO_IMAGE_BYTES) continue
    // An unsupported format is skipped, not sent: history replays it every turn,
    // so one bad image would fail every later request in the conversation.
    const format = kiroImageFormat(img.mediaType)
    if (!format) continue
    selected.push({ format, source: { bytes: base64ToUint8Array(img.data) } })
    totalBase64Chars += img.data.length
  }

  return {
    images: selected,
    omitted: images.length - selected.length
  }
}

export function extractTextFromParts(parts: any[]): string {
  const textParts: string[] = []

  for (const part of parts) {
    if (part.text && typeof part.text === 'string') {
      textParts.push(part.text)
    } else if (part.type === 'text' && part.text) {
      textParts.push(part.text)
    }
  }

  return textParts.join('')
}
