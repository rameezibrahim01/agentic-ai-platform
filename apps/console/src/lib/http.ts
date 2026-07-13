// Content negotiation for the authoring form routes (issue #105). A person's
// browser posts a form and must land back on a PAGE with the message; the
// drill, curl, and any programmatic caller keep JSON + status codes. The
// Accept header is the whole signal: browsers send text/html, machines don't.

export function wantsHtml(accept: string | null): boolean {
  return accept !== null && accept.includes("text/html");
}

/** Path + query for the redirect-with-message form of an error response. */
export function errorRedirectPath(basePath: string, error: string): string {
  const separator = basePath.includes("?") ? "&" : "?";
  return `${basePath}${separator}error=${encodeURIComponent(error)}`;
}
