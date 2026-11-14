export function normalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function normalizeMessage(message) {
  const sources = new Map(), citations = [], calls = new Map(), toolErrors = [];
  const searchQueries = [], text = [];
  function source(raw) {
    const url = normalizeUrl(raw.url);
    if (!url) return null;
    let item = sources.get(url);
    if (!item) {
      item = { url, title: '', domain: new URL(url).hostname, snippet: '', siteName: '', publishedAt: null,
        searched: false, fetched: false, cited: false, searchRank: null };
      sources.set(url, item);
    }
    if (raw.title) item.title = raw.title;
    if (raw.snippet) item.snippet = raw.snippet;
    if (raw.site_name) item.siteName = raw.site_name;
    if (raw.page_age || raw.published_at) item.publishedAt = raw.page_age || raw.published_at;
    return item;
  }
  for (const block of message.content || []) {
    if (block.type === 'server_tool_use') {
      calls.set(block.id, block);
      if (block.input?.action === 'search') searchQueries.push(...(block.input.queries || [block.input.query]).filter(Boolean));
    }
    if (block.type === 'web_search_tool_result') {
      for (const [i, raw] of (block.content || []).entries()) {
        if (raw.type.endsWith('_error')) { toolErrors.push({ tool: 'search', code: raw.error_code }); continue; }
        const item = source(raw);
        if (item) { item.searched = true; item.searchRank ??= i + 1; }
      }
    }
    if (block.type === 'web_fetch_tool_result') {
      const raw = block.content;
      if (raw?.type === 'web_fetch_tool_result_error') {
        toolErrors.push({ tool: 'fetch', code: raw.error_code, url: calls.get(block.tool_use_id)?.input?.url || '' });
      } else if (raw?.type === 'web_fetch_result') {
        const item = source({ ...raw, title: raw.content?.title });
        if (item) item.fetched = true;
      }
    }
    if (block.type === 'text') {
      const blockIndex = text.length;
      text.push(block.text || '');
      for (const cite of block.citations || []) {
        const item = source(cite);
        if (!item) continue;
        item.cited = true;
        citations.push({ url: item.url, title: cite.title || item.title, text: cite.cited_text || block.text || '', blockIndex });
      }
    }
  }
  const searchCalls = [...calls.values()].filter(call => call.input?.action === 'search');
  return {
    responseText: text.join(''), sources: [...sources.values()], citations,
    searchQueries: [...new Set(searchQueries)], searchTriggered: searchCalls.length > 0,
    searchCalls: searchCalls.length, toolErrors, usage: message.usage || {},
    model: message.model, stopReason: message.stop_reason, messageId: message.id,
  };
}
