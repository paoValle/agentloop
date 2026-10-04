/**
 * Adapter per un endpoint chat compatibile con OpenAI.
 *
 * È l'unico pezzo di questo progetto che conosce il mondo esterno, ed è piccolo per
 * una ragione precisa: il routing tra provider, i retry e la cache sono il compito
 * di `llmgateway` (vedi il RFC). Qui c'è solo "porta i messaggi, leggi la risposta,
 * dimmi quanto è costata", con il conto esatto dei token — che è la parte che un
 * gateway non può fare al posto nostro, perché la sa solo la risposta.
 *
 * Nessuna dipendenza: `fetch` è globale da Node 18.
 */

import { PolicyError } from './errors.js';
import type { DecideRequest, Policy, PolicyOutcome, ToolSpec, Usage } from './types.js';

export interface OpenAICompatibleOptions {
  /** Il modello da interrogare. Va anche in `Policy.model`, e questo lo fa per te. */
  readonly model: string;
  /** Chiave dell'API. Va in `Authorization: Bearer`. */
  readonly apiKey: string;
  /** Base URL. Di default `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
  /** Intestazioni aggiuntive, per gateway e proxy. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Tetto di attesa per una risposta. Di default 60 000 ms. */
  readonly timeoutMs?: number;
  /** `fetch` sostitutivo: per i test, o per un agente con proxy. */
  readonly fetch?: typeof globalThis.fetch;
  /** Tetto di token di output, demandato al provider. */
  readonly maxOutputTokens?: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Una `Policy` che parla a un endpoint compatibile con OpenAI. */
export function openAICompatible(options: OpenAICompatibleOptions): Policy {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    model: options.model,
    decide: async (request: DecideRequest): Promise<PolicyOutcome> => {
      const corpo = await callProvider(options, baseUrl, timeoutMs, request);
      return interpret(corpo);
    },
  };
}

interface ProviderResponse {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function callProvider(
  options: OpenAICompatibleOptions,
  baseUrl: string,
  timeoutMs: number,
  request: DecideRequest,
): Promise<ProviderResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // il timeout del runtime e quello del chiamante si sommano: se il chiamante
  // annulla, si annulla anche la richiesta, non solo l'attesa del loop
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const segnale = linkSignals(request.signal, controller.signal);

  try {
    const risposta = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...options.headers,
      },
      body: JSON.stringify({
        model: options.model,
        messages: request.messages.map(toWireMessage),
        tools: request.tools.map(toWireTool),
        tool_choice: request.tools.length > 0 ? 'auto' : undefined,
        max_tokens: options.maxOutputTokens,
      }),
      signal: segnale,
    });

    if (!risposta.ok) {
      // il corpo dell'errore viene da chi ci abbiamo parlato, non da un terzo:
      // troncato, va al chiamante. Al *modello* non passa mai (cfr. ADR 0004)
      const corpo = (await risposta.text()).slice(0, 500);
      throw new PolicyError(
        `il provider ha risposto ${risposta.status} ${risposta.statusText}${corpo === '' ? '' : `: ${corpo}`}`,
      );
    }

    return (await risposta.json()) as ProviderResponse;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    if (request.signal?.aborted === true) {
      throw new PolicyError('la Policy è stata annullata dal chiamante', { cause: error });
    }
    throw new PolicyError('la chiamata al provider è fallita', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * La risposta del provider diventa una decisione.
 *
 * Il punto delicato è `finish_reason`. Un provider che termina con `tool_calls` ha
 * **chiamato** un tool, non chiesto che ne venga chiamato uno: se i due casi venissero
 * confusi, il loop eseguirebbe un tool che il modello stava solo descrivendo. Qui la
 * distinzione è esplicita e un caso sconosciuto è un errore, non un default.
 */
export function interpret(corpo: ProviderResponse): PolicyOutcome {
  const scelta = corpo.choices?.[0];
  if (scelta === undefined) {
    throw new PolicyError('il provider ha risposto senza scelte');
  }

  const usage: Usage = {
    inputTokens: corpo.usage?.prompt_tokens ?? 0,
    outputTokens: corpo.usage?.completion_tokens ?? 0,
  };
  const model = corpo.model ?? 'sconosciuto';

  const chiamate = scelta.message?.tool_calls ?? [];
  if (chiamate.length > 0) {
    const prima = chiamate[0];
    const nome = prima?.function?.name;
    if (nome === undefined || nome === '') {
      throw new PolicyError('il provider ha restituito una tool call senza nome');
    }
    return {
      decision: {
        type: 'tool',
        call: { id: prima?.id ?? 'call-0', name: nome, args: parseArguments(prima?.function?.arguments) },
      },
      usage,
      model,
    };
  }

  const testo = scelta.message?.content ?? '';
  if (testo.trim() === '') {
    // una risposta vuota non è una risposta: meglio fallire che chiudere il run
    // con un `answer` vuoto che sembrerebbe una risposta
    throw new PolicyError(
      `il provider ha restituito una risposta vuota (finish_reason: ${scelta.finish_reason ?? 'nessuno'})`,
    );
  }
  return { decision: { type: 'message', content: testo }, usage, model };
}

/**
 * Gli argomenti di un tool sono una stringa JSON: se non è JSON valido è un errore
 * del provider, non un caso da tollerare. Non si "prova a indovinare" perché un
 * fallback silenzioso qui significa che il tool riceve `{}` e fa qualcosa di diverso
 * da quello che il modello voleva.
 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PolicyError(`gli argomenti del tool non sono JSON valido: ${raw.slice(0, 200)}`, { cause: error });
  }
}

/** Traduce un messaggio interno nel formato del provider. */
function toWireMessage(messaggio: DecideRequest['messages'][number]): Record<string, unknown> {
  if (messaggio.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: messaggio.tool_call_id,
      name: messaggio.name,
      content: messaggio.content,
    };
  }
  return { role: messaggio.role, content: messaggio.content };
}

/** Traduce una `ToolSpec` nel formato `function` del provider. */
function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  };
}

/** Due segnali in uno, se il chiamante ne ha passato uno. */
function linkSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  const controller = new AbortController();
  const annulla = (): void => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener('abort', annulla, { once: true });
    b.addEventListener('abort', annulla, { once: true });
  }
  return controller.signal;
}