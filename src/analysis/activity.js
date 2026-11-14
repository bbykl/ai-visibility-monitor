import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve, basename } from 'node:path';
import { MessageAccumulator, readSSE } from '../providers/sse.js';

// Tool calls and results may be interleaved. Associate them by ID, while keeping
// the original call order; multiple search terms in one call are not new rounds.
export function toolActivity(message) {
  const results = new Map();
  for (const block of message.content || []) {
    if (!['web_search_tool_result', 'web_fetch_tool_result'].includes(block.type)) continue;
    const items = Array.isArray(block.content) ? block.content : [block.content];
    const group = results.get(block.tool_use_id) || [];
    group.push(...items.filter(Boolean));
    results.set(block.tool_use_id, group);
  }
  let searchIndex = 0;
  return (message.content || []).filter(b => b.type === 'server_tool_use').map((block, index) => {
    const input = block.input || {};
    const action = input.action || (block.name === 'web_search' ? 'search' : block.name === 'web_fetch' ? 'open_page' : 'unknown');
    const queries = (Array.isArray(input.queries) ? input.queries : [input.query]).filter(q => typeof q === 'string' && q.trim());
    const output = results.get(block.id) || [];
    const errors = output.filter(r => r.type?.endsWith('_error')).map(r => r.error_code || 'unknown');
    const pages = output.filter(r => ['web_search_result', 'web_fetch_result'].includes(r.type)).map(r => ({
      url: r.url || '', title: r.title || r.content?.title || '',
    }));
    return {
      step: index + 1, id: block.id, action, kind: block.kind || '',
      searchIndex: action === 'search' ? ++searchIndex : null,
      queries, url: typeof input.url === 'string' ? input.url : '',
      pattern: typeof input.pattern === 'string' ? input.pattern : '',
      status: errors.length ? (pages.length ? 'partial_failed' : 'failed') : (output.length || results.has(block.id) ? 'completed' : 'pending'),
      resultCount: pages.length, pages, errors,
    };
  });
}

export function activitySummary(activity) {
  const searches = activity.filter(s => s.action === 'search');
  return {
    toolActivity: activity, searchCalls: searches.length,
    searchQueries: [...new Set(searches.flatMap(s => s.queries))],
    searchTriggered: searches.length > 0,
  };
}

// Old samples already have their original SSE on disk. Recover only the public
// tool metadata on read, without another API request or changing stored answers.
export async function withToolActivity(query, dataDir) {
  if (!query?.result || Array.isArray(query.result.toolActivity)) return query;
  try {
    if (!query.raw_file) throw new Error('No saved stream');
    const accumulator = new MessageAccumulator();
    const body = Readable.toWeb(createReadStream(resolve(dataDir, 'raw', basename(query.raw_file))));
    for await (const frame of readSSE(body)) {
      const event = JSON.parse(frame.data);
      if (event.type === 'error') continue;
      accumulator.accept(event);
    }
    const message = accumulator.message();
    if (!message.content.length) throw new Error('No saved content');
    return { ...query, result: { ...query.result, ...activitySummary(toolActivity(message)) } };
  } catch {
    return { ...query, result: { ...query.result, activityUnavailable: true } };
  }
}
