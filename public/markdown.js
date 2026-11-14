import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

export function renderMarkdown(text) {
  const safe = DOMPurify.sanitize(marked.parse(String(text || ''), { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ['img','style','form','input','button','video','audio','iframe'],
    FORBID_ATTR: ['style'],
  });
  const template = document.createElement('template');
  template.innerHTML = safe;
  for (const a of template.content.querySelectorAll('a')) {
    try {
      const url = new URL(a.getAttribute('href'));
      if (!['http:','https:'].includes(url.protocol)) throw new Error('scheme');
      a.target = '_blank'; a.rel = 'noopener noreferrer';
    } catch { a.removeAttribute('href'); }
  }
  return template.innerHTML;
}
