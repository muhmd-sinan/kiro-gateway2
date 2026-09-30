import { describe, expect, test } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder.js'
import { attachDocuments, extractDocuments, hasDocuments } from '../plugin/document-handler.js'
import { transformToSdkRequest } from '../plugin/request.js'

const PDF_B64 = Buffer.from('%PDF-1.4 fake body').toString('base64')

const pdfBlock = (title?: string) => ({
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
  ...(title ? { title } : {})
})

const AUTH: any = { access: 'x', region: 'us-east-1', profileArn: undefined }

describe('extractDocuments', () => {
  test('converts a base64 PDF into a Kiro document with decoded bytes', () => {
    const { documents, omitted } = extractDocuments([pdfBlock('report.pdf')])
    expect(omitted).toBe(0)
    expect(documents).toHaveLength(1)
    expect(documents[0]!.format).toBe('pdf')
    expect(documents[0]!.name).toBe('report')
    expect(Buffer.from(documents[0]!.source.bytes).toString()).toBe('%PDF-1.4 fake body')
  })

  test('finds PDFs nested in a tool_result, which is how Claude Code’s Read returns them', () => {
    const content = [{ type: 'tool_result', tool_use_id: 't1', content: [pdfBlock('spec.pdf')] }]
    expect(hasDocuments(content)).toBe(true)
    expect(extractDocuments(content).documents).toHaveLength(1)
  })

  test('inlines plain-text sources instead of uploading them', () => {
    const { documents, inlineText } = extractDocuments([
      {
        type: 'document',
        title: 'notes',
        source: { type: 'text', media_type: 'text/plain', data: 'hello' }
      }
    ])
    expect(documents).toHaveLength(0)
    expect(inlineText).toContain('hello')
    expect(inlineText).toContain('notes')
  })

  test('sanitizes names and keeps them unique', () => {
    const { documents } = extractDocuments([
      pdfBlock('a/b:c.pdf'),
      pdfBlock('a/b:c.pdf'),
      pdfBlock()
    ])
    const names = documents.map((d) => d.name)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9 \-()[\]]+$/)
  })

  test('counts unsupported formats and URL sources as omitted rather than throwing', () => {
    const { documents, omitted } = extractDocuments([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/zip', data: PDF_B64 }
      },
      { type: 'document', source: { type: 'url', url: 'https://example.com/x.pdf' } }
    ])
    expect(documents).toHaveLength(0)
    expect(omitted).toBe(2)
  })

  test('caps the number of documents per message', () => {
    const { documents, omitted } = extractDocuments(Array.from({ length: 7 }, () => pdfBlock()))
    expect(documents).toHaveLength(5)
    expect(omitted).toBe(2)
  })

  test('attachDocuments notes omissions so the model does not assume it read them', () => {
    const uim: any = { content: 'look' }
    attachDocuments(uim, { documents: [], inlineText: '', omitted: 1 })
    expect(uim.content).toContain('omitted')
    expect(uim.documents).toBeUndefined()
  })
})

describe('request building', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'summarize' }, pdfBlock('doc.pdf')] }
    ]
  }

  test('attaches the PDF to the current message when documents are on', () => {
    const prep = transformToSdkRequest(
      body,
      'claude-opus-5',
      AUTH,
      false,
      20000,
      undefined,
      {},
      'c',
      {
        documents: true
      }
    )
    const uim: any = prep.conversationState.currentMessage.userInputMessage
    expect(uim.documents).toHaveLength(1)
    expect(uim.documents[0].format).toBe('pdf')
    expect(uim.content).toContain('summarize')
  })

  test('attaches a PDF sent as an OpenAI file part, which is how OpenCode sends one', () => {
    const openaiBody = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize' },
            {
              type: 'file',
              file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` }
            }
          ]
        }
      ]
    }
    const prep = transformToSdkRequest(
      openaiBody,
      'claude-opus-5',
      AUTH,
      false,
      20000,
      undefined,
      {},
      'c',
      { documents: true }
    )
    const uim: any = prep.conversationState.currentMessage.userInputMessage
    expect(uim.documents).toHaveLength(1)
    expect(uim.documents[0].name).toBe('doc')
    expect(Buffer.from(uim.documents[0].source.bytes).toString()).toBe('%PDF-1.4 fake body')
  })

  test('ignores file parts that are not base64 data URIs', () => {
    expect(hasDocuments([{ type: 'file', file: { file_data: 'https://x/doc.pdf' } }])).toBe(false)
  })

  test('without the documents option, documents are not attached', () => {
    const prep = transformToSdkRequest(body, 'claude-opus-5', AUTH)
    const uim: any = prep.conversationState.currentMessage.userInputMessage
    expect(uim.documents).toBeUndefined()
  })

  test('history keeps recent PDFs and drops older ones under the retention limit', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'one' }, pdfBlock('a.pdf')] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'two' }, pdfBlock('b.pdf')] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'now' }
    ]
    const history: any[] = buildHistory(msgs, 'claude-opus-5', {
      documents: true,
      historyImageMessages: 1
    })
    const users = history.filter((h) => h.userInputMessage)
    expect(users[0].userInputMessage.documents).toBeUndefined()
    expect(users[0].userInputMessage.content).toContain('omitted')
    expect(users[1].userInputMessage.documents).toHaveLength(1)
  })
})
