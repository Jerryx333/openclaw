import Anthropic from "@anthropic-ai/sdk";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamAnthropic, type AnthropicOptions, type Model } from "@mariozechner/pi-ai";

type AnthropicRawStreamEffort = NonNullable<AnthropicOptions["effort"]>;

/**
 * Create a proxy Anthropic client that intercepts `messages.stream()` and
 * replaces it with `messages.create({ stream: true })`.
 *
 * The SDK's `messages.stream()` returns a `MessageStream` that validates SSE
 * event ordering and throws "Unexpected event order" when a relay sends events
 * out of order.  In contrast, `messages.create({ stream: true })` returns a
 * raw `Stream<RawMessageStreamEvent>` which is a simple async-iterable over
 * SSE events with NO ordering validation — exactly what we need.
 *
 * This fixes compatibility with third-party API relays (like nekocode.ai)
 * that send SSE events in non-standard order.
 */
function createRawStreamProxyClient(baseURL: string, apiKey: string): Anthropic {
  const real = new Anthropic({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
  });

  const messagesProxy = new Proxy(real.messages, {
    get(target, prop, receiver) {
      if (prop === "stream") {
        // Replace stream() with create({ stream: true }) which returns a raw
        // Stream<RawMessageStreamEvent> without MessageStream validation.
        return (
          params: Anthropic.MessageCreateParams,
          options?: Anthropic.RequestOptions,
        ): AsyncIterable<RawMessageStreamEvent> => {
          const createPromise = target.create(
            { ...params, stream: true } as Anthropic.MessageCreateParamsStreaming,
            options,
          );
          // createPromise resolves to Stream<RawMessageStreamEvent> which is
          // async-iterable.  We wrap it so `for await` works immediately.
          return {
            [Symbol.asyncIterator]() {
              let innerIterator: AsyncIterator<RawMessageStreamEvent> | null = null;
              return {
                async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
                  if (!innerIterator) {
                    const rawStream = await createPromise;
                    innerIterator = rawStream[Symbol.asyncIterator]();
                  }
                  return innerIterator.next();
                },
              };
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "messages") {
        return messagesProxy;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with a
 * raw-stream proxy client.  All message conversion and event handling is
 * handled by pi-ai — we only supply the proxy client and map
 * SimpleStreamOptions → AnthropicOptions.
 *
 * The proxy replaces `client.messages.stream()` (which uses the SDK's
 * MessageStream with strict event ordering) with `client.messages.create({
 * stream: true })` (which returns raw SSE events without validation).
 */
export function createAnthropicNonStreamingStreamFn(model: {
  id: string;
  baseUrl?: string;
  maxTokens?: number;
}): StreamFn {
  return (streamModel, context, options) => {
    const apiKey = options?.apiKey ?? "";
    const baseURL = model.baseUrl ?? "https://api.anthropic.com";
    const client = createRawStreamProxyClient(baseURL, apiKey);

    const maxTokens = resolveMaxTokens({
      modelMaxTokens: model.maxTokens,
      requestedMaxTokens: options?.maxTokens,
    });

    const opts: AnthropicOptions = {
      client: client as unknown as AnthropicOptions["client"],
      temperature: options?.temperature,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: options?.onPayload,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    };

    if (options?.reasoning) {
      const isAdaptive =
        model.id.includes("opus-4-6") ||
        model.id.includes("opus-4.6") ||
        model.id.includes("sonnet-4-6") ||
        model.id.includes("sonnet-4.6");

      if (isAdaptive) {
        opts.thinkingEnabled = true;
        const effortMap: Record<string, AnthropicRawStreamEffort> = {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: model.id.includes("opus-4-6") || model.id.includes("opus-4.6") ? "max" : "high",
        };
        opts.effort = effortMap[options.reasoning] ?? "high";
      } else {
        opts.thinkingEnabled = true;
        const budgets = options.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && options.reasoning in budgets
            ? budgets[options.reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else {
      opts.thinkingEnabled = false;
    }

    return streamAnthropic(streamModel as Model<"anthropic-messages">, context, opts);
  };
}

function resolveMaxTokens(params: {
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
}): number | undefined {
  const modelMax =
    typeof params.modelMaxTokens === "number" &&
    Number.isFinite(params.modelMaxTokens) &&
    params.modelMaxTokens > 0
      ? Math.floor(params.modelMaxTokens)
      : undefined;
  const requested =
    typeof params.requestedMaxTokens === "number" &&
    Number.isFinite(params.requestedMaxTokens) &&
    params.requestedMaxTokens > 0
      ? Math.floor(params.requestedMaxTokens)
      : undefined;

  if (modelMax !== undefined && requested !== undefined) {
    return Math.min(requested, modelMax);
  }
  return requested ?? modelMax;
}
