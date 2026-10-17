import { describe, expect, test } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder.js'
import { convertImagesToKiroFormat, extractAllImages } from '../plugin/image-handler.js'
import { transformToSdkRequest } from '../plugin/request.js'

const PNG_B64 = Buffer.from('\x89PNG fake body').toString('base64')
const AUTH: any = { access: 'x', region: 'us-east-1', profileArn: undefined }

const imageBlock = (mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: PNG_B64 }
})

// How Claude Code returns a screenshot or a Read of a .png: the image sits inside
// the tool_result, often with no text at all.
const screenshotResult = (id: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [imageBlock()]
})

const toolTurn = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'browser_take_screenshot', input: {} }]
})

describe('extractAllImages', () => {
  test('finds images nested in a tool_result', () => {
    expect(extractAllImages([screenshotResult('t1')])).toHaveLength(1)
  })

  test('still finds top-level Anthropic and OpenAI images', () => {
    const images = extractAllImages([
      imageBlock(),
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }
    ])
    expect(images).toHaveLength(2)
  })
})

describe('convertImagesToKiroFormat', () => {
  test('maps image/jpg to jpeg, which is the only JPEG value Kiro accepts', () => {
    const { images, omitted } = convertImagesToKiroFormat([
      { mediaType: 'image/jpg', data: PNG_B64 },
      { mediaType: 'image/JPEG', data: PNG_B64 }
    ])
    expect(omitted).toBe(0)
    expect(images.map((i) => i.format)).toEqual(['jpeg', 'jpeg'])
  })

  test('omits formats outside Kiro’s ImageFormat enum instead of sending them', () => {
    const { images, omitted } = convertImagesToKiroFormat([
      { mediaType: 'image/svg+xml', data: PNG_B64 },
      { mediaType: 'image/webp', data: PNG_B64 }
    ])
    expect(images.map((i) => i.format)).toEqual(['webp'])
    expect(omitted).toBe(1)
  })

  test('skips an oversized image without dropping the smaller ones after it', () => {
    const { images, omitted } = convertImagesToKiroFormat([
      { mediaType: 'image/png', data: 'A'.repeat(3_800_000) },
      { mediaType: 'image/png', data: PNG_B64 }
    ])
    expect(images).toHaveLength(1)
    expect(omitted).toBe(1)
  })

  test('decodes to a plain Uint8Array', () => {
    const { images } = convertImagesToKiroFormat([{ mediaType: 'image/png', data: PNG_B64 }])
    expect(Buffer.isBuffer(images[0]!.source.bytes)).toBe(false)
    expect(Buffer.from(images[0]!.source.bytes).toString('base64')).toBe(PNG_B64)
  })
})

describe('tool_result images reach Kiro', () => {
  const msgs = [
    { role: 'user', content: 'take a screenshot' },
    toolTurn('t1'),
    { role: 'user', content: [screenshotResult('t1')] }
  ]

  test('on the current message, next to the tool result', () => {
    const prep = transformToSdkRequest({ messages: msgs }, 'claude-opus-5', AUTH)
    const uim: any = prep.conversationState.currentMessage.userInputMessage
    expect(uim.images).toHaveLength(1)
    expect(uim.images[0].format).toBe('png')
    expect(uim.userInputMessageContext.toolResults[0].toolUseId).toBe('t1')
  })

  test('in history, next to the tool result', () => {
    const history: any[] = buildHistory(
      [...msgs, { role: 'assistant', content: 'I see it' }, { role: 'user', content: 'thanks' }],
      'claude-opus-5'
    )
    const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults)
    expect(entry.userInputMessage.images).toHaveLength(1)
  })

  test('an image-only result gets descriptive text, not an empty block', () => {
    const prep = transformToSdkRequest({ messages: msgs }, 'claude-opus-5', AUTH)
    const uim: any = prep.conversationState.currentMessage.userInputMessage
    expect(uim.userInputMessageContext.toolResults[0].content[0].text).toBe(
      '[image result: 1 image(s)]'
    )

    const history: any[] = buildHistory(
      [...msgs, { role: 'assistant', content: 'I see it' }, { role: 'user', content: 'thanks' }],
      'claude-opus-5'
    )
    const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults)
    expect(entry.userInputMessage.userInputMessageContext.toolResults[0].content[0].text).toBe(
      '[image result: 1 image(s)]'
    )
  })

  test('count toward history_image_messages like pasted images', () => {
    const history: any[] = buildHistory(
      [
        ...msgs,
        toolTurn('t2'),
        { role: 'user', content: [screenshotResult('t2')] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'next' }
      ],
      'claude-opus-5',
      { historyImageMessages: 1 }
    )
    const withImages = history.filter((h) => h.userInputMessage?.images?.length)
    expect(withImages).toHaveLength(1)
    expect(withImages[0].userInputMessage.userInputMessageContext.toolResults[0].toolUseId).toBe(
      't2'
    )
  })
})
