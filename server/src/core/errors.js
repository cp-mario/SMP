/**
 * Standardized JSON error responses.
 *
 * All API routes use these helpers so the client always receives the same
 * shape: `{ ok: false, error: string, errors?: string[] }`.
 */

/**
 * Return a JSON error Response with the given status and message.
 * Replaces the mixed patterns of `new Response(...)`, `set.status`, and
 * throwing `Error` with `err.status`.
 */
export function errorResponse(message, status = 400, errors = null) {
  const body: Record<string, unknown> = { ok: false, error: message };
  if (Array.isArray(errors) && errors.length) body.errors = errors;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 404 Not Found */
export function notFound(message = "Not found") {
  return errorResponse(message, 404);
}

/** 400 Bad Request */
export function badRequest(message = "Bad request", errors = null) {
  return errorResponse(message, 400, errors);
}

/** 409 Conflict */
export function conflict(message = "Conflict", errors = null) {
  return errorResponse(message, 409, errors);
}

/** 500 Internal Server Error */
export function serverError(message = "Internal server error") {
  return errorResponse(message, 500);
}
