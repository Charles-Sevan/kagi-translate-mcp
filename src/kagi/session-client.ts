import { KagiApiError, KagiClient, KagiNetworkError, KagiResponseError } from "./client.js";
import type {
  KagiProofreadRequest,
  KagiProofreadResponse,
  KagiTranslateTextRequest,
  KagiTranslateUrlRequest,
  KagiTranslationResponse,
} from "./types.js";

export interface SessionCredentials {
  authorization: string;
  token?: string;
}

// The web interface uses session auth and SSE, not the public Bearer-key API.
export class KagiSessionClient extends KagiClient {
  private token: string | undefined;
  private refreshAt = 0;

  constructor(
    private readonly credentials: SessionCredentials,
    private readonly sessionBaseUrl = "https://translate.kagi.com"
  ) {
    super("");
  }

  override async translateText(request: KagiTranslateTextRequest): Promise<KagiTranslationResponse> {
    if (request.texts) {
      const { texts, ...options } = request;
      const translations: string[] = [];
      for (const text of texts) {
        const result = await this.translateText({ ...options, text });
        translations.push(result.translation!);
      }
      return { translations };
    }
    return this.postSession("/api/translate", {
      text: request.text,
      from: request.source_lang,
      to: request.target_lang,
      formality: request.formality ?? "default",
      speaker_gender: request.gender === "neutral" ? "unknown" : request.gender ?? "unknown",
      addressee_gender: "unknown",
      translation_style: "natural",
      context: request.context ?? "",
    });
  }

  override async proofread(request: KagiProofreadRequest): Promise<KagiProofreadResponse> {
    return this.postSession("/api/proofread", {
      text: request.text,
      source_lang: request.language ?? request.target_lang ?? "auto",
      writing_style: "general",
      correction_level: "standard",
      formality: "default",
      language_complexity: "standard",
      context: "",
      explanation_language: "fr",
    });
  }

  override async translateUrl(_request: KagiTranslateUrlRequest): Promise<KagiTranslationResponse> {
    throw new KagiResponseError("translate_url is not supported in browser-session mode; use translate_text instead.");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.sessionBaseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
        headers: {
          "X-Kagi-Authorization": this.credentials.authorization,
          Cookie: `kagi_session=${this.credentials.authorization}${this.token ? `; translate_session=${this.token}` : ""}`,
          Origin: this.sessionBaseUrl,
          Referer: `${this.sessionBaseUrl}/`,
          ...init.headers,
        },
      });
    } catch {
      // Do not include fetch options or credentials in logs or MCP errors.
      throw new KagiNetworkError("Could not reach Kagi Translate (network error or timeout).");
    }
  }

  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.refreshAt) return;
    const response = await this.request("/");
    if (!response.ok) {
      await response.body?.cancel();
      throw new KagiApiError("Could not refresh the Kagi Translate session. Renew the Kagi browser session.", response.status, null);
    }
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("translate_session="));
    await response.body?.cancel();
    const token = cookie?.split(";", 1)[0]?.slice("translate_session=".length);
    this.token = token || this.credentials.token;
    if (!this.token) {
      throw new KagiResponseError("Kagi did not return a Translate session token. Renew the Kagi browser session.");
    }
    // The Translate JWT currently lasts about an hour. Refresh well before that.
    this.refreshAt = Date.now() + 20 * 60_000;
  }

  private async postSession(path: string, body: object): Promise<KagiTranslationResponse & KagiProofreadResponse> {
    await this.ensureToken();
    const response = await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, session_token: this.token, model: "standard", stream: true }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 || response.status === 403
        ? "Kagi session rejected. Renew KAGI_TRANSLATE_AUTHORIZATION in the credentials file."
        : `Kagi request failed with status ${response.status}`;
      throw new KagiApiError(message, response.status, null);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new KagiNetworkError("The Kagi response stream was interrupted or timed out.");
    }
    return parseSessionResponse(text, path === "/api/proofread");
  }
}

export function parseSessionResponse(text: string, proofread: boolean): KagiTranslationResponse & KagiProofreadResponse {
  let delta = "";
  let finalText: string | undefined;
  let complete = false;
  const result: KagiTranslationResponse & KagiProofreadResponse = {};
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      frame = parsed as Record<string, unknown>;
    } catch {
      throw new KagiResponseError("Kagi returned an invalid SSE event.");
    }
    if (frame.error) throw new KagiResponseError("Kagi reported an error in the response stream.");
    if (typeof frame.delta === "string") delta += frame.delta;
    if (typeof frame.final_text === "string") finalText = frame.final_text;
    if (frame.text_done === true || frame.done === true) complete = true;
    if (frame.detected_language && typeof frame.detected_language === "object") {
      const language = frame.detected_language as Record<string, unknown>;
      result.detected_language = {
        ...(typeof language.iso === "string" ? { iso: language.iso } : {}),
        ...(typeof language.label === "string" ? { label: language.label } : {}),
      };
    }
    if (frame.analysis && typeof frame.analysis === "object") {
      const analysis = frame.analysis as Record<string, unknown>;
      result.analysis = analysis;
      if (typeof analysis.corrected_text === "string") finalText = analysis.corrected_text;
    }
  }
  const output = finalText ?? delta;
  if (!complete || !output) throw new KagiResponseError("Kagi returned an incomplete or empty response stream.");
  if (proofread) result.corrected_text = output;
  else result.translation = output;
  return result;
}
