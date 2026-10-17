import { describe, expect, test } from 'bun:test'
import { buildHistory, injectSystemPrompt } from '../infrastructure/transformers/history-builder.js'
import { sanitizeCodeWhispererSchema } from '../infrastructure/transformers/tool-transformer.js'

describe('object unions in tool schemas', () => {
  test('oneOf object variants keep every property', () => {
    const schema = sanitizeCodeWhispererSchema({
      type: 'object',
      required: ['mode'],
      properties: { mode: { type: 'string' } },
      oneOf: [
        { properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'number' } }, required: ['b'] }
      ]
    })
    expect(Object.keys(schema.properties).sort()).toEqual(['a', 'b', 'mode'])
    // A branch's required list is wrong for the other branch; the parent's holds.
    expect(schema.required).toEqual(['mode'])
  })
})

describe('history start', () => {
  // A client that trimmed or compacted old messages can send an assistant first.
  const trimmed = [
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'next' }
  ]

  test('opens with a user turn and keeps the assistant reply', () => {
    const history: any[] = buildHistory(trimmed, 'claude-opus-5')
    expect(history[0].userInputMessage).toBeDefined()
    expect(history[1].assistantResponseMessage.content).toBe('earlier answer')
  })

  test('puts the system prompt before that reply', () => {
    const history: any[] = injectSystemPrompt(
      buildHistory(trimmed, 'claude-opus-5'),
      'SYSTEM',
      'claude-opus-5'
    )
    expect(history[0].userInputMessage.content.startsWith('SYSTEM')).toBe(true)
  })
})
