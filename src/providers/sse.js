// Incremental SSE decoder: UTF-8 boundaries, CRLF boundaries and multi-line data.
export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = 'message';
  function line(text) {
    if (!text) {
      const result = data.length ? { event, data: data.join('\n') } : null;
      data = []; event = 'message';
      return result;
    }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    if (field === 'event') event = value;
    return null;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const result = line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (result) yield result;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class MessageAccumulator {
  constructor() { this.blocks = []; this.usage = {}; this.stopped = false; this.stopReason = null; }
  accept(event) {
    if (event.type === 'error' || event.error) throw new Error(event.error?.message || 'API 流返回错误');
    if (event.type === 'message_start') {
      this.id = event.message?.id;
      this.model = event.message?.model;
      Object.assign(this.usage, event.message?.usage);
    }
    if (event.type === 'content_block_start') this.blocks[event.index] = structuredClone(event.content_block);
    if (event.type === 'content_block_delta') {
      const block = this.blocks[event.index];
      if (!block) throw new Error('API 内容块顺序异常');
      const delta = event.delta;
      if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
      if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
      if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
      if (delta.type === 'citations_delta') (block.citations ||= []).push(delta.citation);
      if (delta.type === 'input_json_delta') block.partial_json = (block.partial_json || '') + delta.partial_json;
    }
    if (event.type === 'message_delta') {
      this.stopReason = event.delta?.stop_reason || this.stopReason;
      Object.assign(this.usage, event.usage);
    }
    if (event.type === 'message_stop') this.stopped = true;
  }
  message() {
    return { id: this.id, model: this.model, content: this.blocks.filter(Boolean), usage: this.usage, stop_reason: this.stopReason };
  }
}
