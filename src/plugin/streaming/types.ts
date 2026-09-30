export interface StreamEvent {
  type: string
  message?: any
  content_block?: any
  delta?: any
  index?: number
  usage?: any
  /**
   * Kiro's own billing for the call, from meteringEvent. Internal only: no
   * serializer reads it, so it never reaches a client. Carried on message_delta
   * for the proxy's timing log.
   */
  metering?: { credits: number }
}

export interface StreamState {
  thinkingRequested: boolean
  buffer: string
  inThinking: boolean
  thinkingExtracted: boolean
  thinkingBlockIndex: number | null
  textBlockIndex: number | null
  nextBlockIndex: number
  stoppedBlocks: Set<number>
}

export interface ToolCallState {
  toolUseId: string
  name: string
  input: string
}

export const THINKING_START_TAG = '<thinking>'
export const THINKING_END_TAG = '</thinking>'
