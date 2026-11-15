export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 30rem; margin: 10vh auto; padding: 0 1.25rem; line-height: 1.5; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; font-size: .9rem; margin: 1rem 0 1.5rem; }
  dt { opacity: .7; } dd { margin: 0; word-break: break-all; }
  .actions { display: flex; gap: .75rem; }
  button, a.btn { font: inherit; padding: .55rem 1.1rem; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; cursor: pointer; text-decoration: none; }
  button.primary { background: #f38020; border-color: #f38020; color: #fff; }
  p.note { font-size: .85rem; opacity: .75; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="card">${body}</div></body></html>`;
}

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export function htmlResponse(html: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(html, { status: init.status ?? 200, headers: { ...SECURITY_HEADERS, ...(init.headers ?? {}) } });
}

export function consentPage(opts: { clientName: string; clientUri?: string; redirectUri: string; stateId: string }): string {
  return page(
    "Authorize access to Search Console",
    `<h1>Authorize access to Search Console</h1>
     <p><strong>${escapeHtml(opts.clientName)}</strong> wants to read Search Console data through this server.</p>
     <dl>
       <dt>Application</dt><dd>${escapeHtml(opts.clientName)}</dd>
       ${opts.clientUri ? `<dt>Website</dt><dd>${escapeHtml(opts.clientUri)}</dd>` : ""}
       <dt>Redirects to</dt><dd>${escapeHtml(opts.redirectUri)}</dd>
       <dt>Access</dt><dd>Read-only</dd>
     </dl>
     <form method="post" action="/authorize">
       <input type="hidden" name="state" value="${escapeHtml(opts.stateId)}">
       <div class="actions">
         <button type="submit" class="primary">Continue with Cloudflare Access</button>
       </div>
     </form>
     <p class="note">Only approve if you just added this server as a connector yourself. You will sign in with Cloudflare Access next.</p>`,
  );
}

export function errorPage(message: string): string {
  return page("Authorization error", `<h1>Authorization error</h1><p>${escapeHtml(message)}</p>`);
}

export function homePage(origin: string): string {
  return page(
    "mcp-gsc",
    `<h1>mcp-gsc</h1>
     <p>Remote MCP server for Google Search Console.</p>
     <p>Add this URL as a custom connector (OAuth) in Claude or ChatGPT:</p>
     <p><code>${escapeHtml(origin)}/mcp</code></p>`,
  );
}
