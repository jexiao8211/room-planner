import Anthropic from "@anthropic-ai/sdk";

/** An error that maps directly to an HTTP response `{ error: message }`. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Translate an Anthropic SDK (or other upstream) failure into a user-facing HttpError.
 * Upstream failures are 502; messages never include the API key or request bodies.
 */
export function toUpstreamError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(502, "Anthropic API key rejected (401). Check ANTHROPIC_API_KEY in .env, or set MOCK_AI=1 for demo data.");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(502, "Anthropic API refused access (403): this key may not have access to the model or feature.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(502, "Anthropic API rate limit hit (429). Wait a moment and try again.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new HttpError(502, `Anthropic API rejected the request (400): ${shortMessage(err)}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new HttpError(502, `Anthropic API returned 404: ${shortMessage(err)}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, "Could not reach the Anthropic API (network error or timeout).");
  }
  if (err instanceof Anthropic.APIError) {
    return new HttpError(502, `Anthropic API error${err.status ? ` (${err.status})` : ""}: ${shortMessage(err)}`);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // e.g. structured-output parse failures raised by the SDK.
    return new HttpError(502, `Claude returned an unusable answer: ${shortMessage(err)}`);
  }
  return new HttpError(500, err instanceof Error ? err.message : "Internal error");
}

function shortMessage(err: Error): string {
  return err.message.replace(/\s+/g, " ").slice(0, 300);
}
