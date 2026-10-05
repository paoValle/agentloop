/**
 * Adapter for an OpenAI-compatible chat endpoint.
 *
 * It is the only piece of this project that knows the outside world, and it is small
 * for a precise reason: routing between providers, retries and caching are the job of
 * `llmgateway` (see the RFC). Here there is only "carry the messages, read the answer,
 * tell me what it cost", with the exact token accounting — which is the part a gateway
 * cannot do on our behalf, because only the response knows it.
 *
 * No dependencies: `fetch` has been global since Node 18.
 */

import { PolicyError } from './errors.js';
import type { DecideRequest, Policy, PolicyOutcome, ToolSpec, Usage } from './types.js';

export interface OpenAICompatibleOptions {
  /** The model to query. It also goes into `Policy.model`, and this does that for you. */
  readonly model: string;
  /** API key. It goes into `Authorization: Bearer`. */
  readonly apiKey: string;
  /** Base URL. Defaults to `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
  /** Extra headers, for gateways and proxies. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Wait cap for a response. Defaults to 60,000 ms. */
  readonly timeoutMs?: number;
  /** Replacement `fetch`: for tests, or for an agent behind a proxy. */
  readonly fetch?: typeof globalThis.fetch;
  /** Output token cap, delegated to the provider. */
  readonly maxOutputTokens?: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

/** A `Policy` that talks to an OpenAI-compatible endpoint. */
export function openAICompatible(options: OpenAICompatibleOptions): Policy {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    model: options.model,
    decide: async (request: DecideRequest): Promise<PolicyOutcome> => {
      const body = await callProvider(options, baseUrl, timeoutMs, request);
      return interpret(body);
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

  // the runtime timeout and the caller one add up: if the caller cancels, the request
  // is cancelled too, not just the loop's wait
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = linkSignals(request.signal, controller.signal);

  try {
    const response = await doFetch(url, {
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
      signal,
    });

    if (!response.ok) {
      // the error body comes from who we talked to, not from a third party:
      // truncated, it goes to the caller. It *never* reaches the model (cf. ADR 0004)
      const body = (await response.text()).slice(0, 500);
      throw new PolicyError(
        `the provider responded ${response.status} ${response.statusText}${body === '' ? '' : `: ${body}`}`,
      );
    }

    return (await response.json()) as ProviderResponse;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    if (request.signal?.aborted === true) {
      throw new PolicyError('the Policy was cancelled by the caller', { cause: error });
    }
    throw new PolicyError('the call to the provider failed', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The provider response becomes a decision.
 *
 * The delicate point is `finish_reason`. A provider that ends with `tool_calls` has
 * **called** a tool, it did not ask for one to be called: if the two cases were
 * confused, the loop would execute a tool the model was only describing. Here the
 * distinction is explicit and an unknown case is an error, not a default.
 */
export function interpret(body: ProviderResponse): PolicyOutcome {
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new PolicyError('the provider responded with no choices');
  }

  const usage: Usage = {
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
  const model = body.model ?? 'unknown';

  const calls = choice.message?.tool_calls ?? [];
  if (calls.length > 0) {
    const first = calls[0];
    const name = first?.function?.name;
    if (name === undefined || name === '') {
      throw new PolicyError('the provider returned a tool call with no name');
    }
    return {
      decision: {
        type: 'tool',
        call: { id: first?.id ?? 'call-0', name, args: parseArguments(first?.function?.arguments) },
      },
      usage,
      model,
    };
  }

  const text = choice.message?.content ?? '';
  if (text.trim() === '') {
    // an empty response is not a response: better to fail than to close the run
    // with an empty `answer` that would look like an answer
    throw new PolicyError(
      `the provider returned an empty response (finish_reason: ${choice.finish_reason ?? 'none'})`,
    );
  }
  return { decision: { type: 'message', content: text }, usage, model };
}

/**
 * Tool arguments are a JSON string: if it is not valid JSON it is a provider error,
 * not a case to tolerate. It does not "try to guess", because a silent fallback here
 * means the tool receives `{}` and does something different from what the model wanted.
 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PolicyError(`the tool arguments are not valid JSON: ${raw.slice(0, 200)}`, { cause: error });
  }
}

/** Translates an internal message into the provider format. */
function toWireMessage(message: DecideRequest['messages'][number]): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      name: message.name,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

/** Translates a `ToolSpec` into the provider's `function` format. */
function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  };
}

/** Two signals into one, if the caller passed one. */
function linkSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener('abort', cancel, { once: true });
    b.addEventListener('abort', cancel, { once: true });
  }
  return controller.signal;
}
