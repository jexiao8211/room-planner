// Typed client for the local API server (proxied by Vite under /api).
import type {
  ChatRequest,
  ChatResponse,
  HealthResponse,
  PhotoInput,
  ProductSearchRequest,
  ProductSearchResponse,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../shared/types";
import { isConnectionLossStatus } from "./updateDecision";

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** A failed API call with its HTTP status (e.g. 400 = the request itself was rejected; retrying won't help). */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * The server went away mid-request: the fetch itself failed, or the preview proxy answered for an API that is down
 * (a redeploy restarts it). Sending the same request again once it is back is expected to work.
 */
export class ConnectionLostError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ConnectionLostError";
  }
}

export function isConnectionLost(e: unknown): e is ConnectionLostError {
  return e instanceof ConnectionLostError;
}

/** True for errors that sending the same request again can't fix (a 4xx other than timeout / rate limit). */
export function isPermanentRequestError(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ConnectionLostError("Can't reach the API server — is it running? (npm run dev)", null);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`;
    let json = false;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string" && body.error) {
        message = body.error;
        json = true;
      }
    } catch {
      // Body wasn't JSON (e.g. proxy error page) — keep the status message.
    }
    if (isConnectionLossStatus(res.status, json)) throw new ConnectionLostError(message, res.status);
    throw new ApiRequestError(message, res.status);
  }
  return (await res.json()) as T;
}

function postJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health", { signal });
}

export function roomFromPhotos(req: RoomFromPhotosRequest, signal?: AbortSignal): Promise<RoomFromPhotosResponse> {
  return postJSON<RoomFromPhotosResponse>("/api/rooms/from-photos", req, signal);
}

export function searchProducts(req: ProductSearchRequest, signal?: AbortSignal): Promise<ProductSearchResponse> {
  return postJSON<ProductSearchResponse>("/api/products/search", req, signal);
}

/** One chat turn: the reply text plus the actions the app should apply (see src/ui/chat/executeActions.ts). */
export function sendChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  return postJSON<ChatResponse>("/api/chat", req, signal);
}

export { isAbort };

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Fall through to <img> decoding.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Couldn't read "${file.name}" — try a JPEG or PNG photo.`);
  }
}

/**
 * Downscale a photo so its long edge is at most `maxEdge` px and re-encode it as JPEG (quality 0.85).
 * Returns base64 without the `data:` prefix, ready for the API.
 */
export async function downscaleImage(file: File, maxEdge = 1568): Promise<PhotoInput> {
  const img = await decode(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available in this browser.");
    ctx.fillStyle = "#ffffff"; // JPEG has no alpha; avoid black backgrounds on transparent PNGs
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.source, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const comma = dataUrl.indexOf(",");
    return { mediaType: "image/jpeg", dataBase64: dataUrl.slice(comma + 1) };
  } finally {
    img.close();
  }
}
