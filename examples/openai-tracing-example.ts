import OpenAI from "openai";
import dotenv from "dotenv";
import { wrap_guard_prompt } from '../src/utils/wrap-guard';
import { Config, readConfig } from '../src/config/config';
import { GuardrailApiResponse } from '../src/types/guardrail-types';
import { context, trace, Tracer } from "@opentelemetry/api";
import { initialize_tracing } from "../src/services/trace-exporter";

// This is an example of how you might be calling an LLM (with guardrails and tracing)
async function processPrompt(userPrompt: string, datasetId: string, tracer: Tracer): Promise<string> {
  return tracer.startActiveSpan('interaction', async (parentSpan) => {
    try {
      const ctx = trace.setSpan(context.active(), parentSpan);
      parentSpan.setAttribute("llm.request.type", "chat");
      parentSpan.setAttribute("span.type", "interaction");
      const guardrailBefore: GuardrailApiResponse = await wrap_guard_prompt({
        prompt: userPrompt,
        id: "0",
        datasetId: datasetId,
        config,
        parentSpan: parentSpan,
        tracer: tracer
      });
      console.log(guardrailBefore.action);
      if (guardrailBefore.action.action_type === "block") {
        console.log("Prompt was blocked by guardrail.");
        parentSpan.end();
        return guardrailBefore.action.block_message;
      }

      const llm_span = tracer.startSpan("openai.chat", undefined, ctx);
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await openai.chat.completions.create({
            messages: [{ role: "user", content: userPrompt }],
            model: llm_model_name
        });
        llm_span.setAttribute("span.type", "completion");
        llm_span.setAttribute("llm.vendor", "OpenAI");
        llm_span.setAttribute("llm.request.model", llm_model_name);
        if (completion && completion.usage) {
            llm_span.setAttribute("llm.usage.total_tokens", completion.usage.total_tokens);
            llm_span.setAttribute("llm.usage.completion_tokens", completion.usage.completion_tokens);
            llm_span.setAttribute("llm.usage.prompt_tokens", completion.usage.prompt_tokens);
        }
      } catch (error) {
        llm_span.setAttribute("error", true);
        throw error;
      } finally {
        llm_span.end();
      }

      const openaiResponse = completion.choices[0]?.message?.content ?? "no response from llm";

      const guardrailAfter: GuardrailApiResponse = await wrap_guard_prompt({
        prompt: userPrompt,
        id: completion.id,
        datasetId: datasetId,
        config,
        response: openaiResponse,
        parentSpan: parentSpan,
        tracer: tracer
      });

      console.log(guardrailAfter.action);
      if (guardrailAfter.action.action_type === "block") {
        return guardrailAfter.action.block_message;
      }

      return openaiResponse;
    } catch (error) {
      console.error('Error in processPrompt:', error);
      parentSpan.setAttribute("error", true);
      throw error;
    } finally {
      parentSpan.end();
    }
  });
}

// Example setup: config + environment variables
dotenv.config();
const config: Config = readConfig();
// this is an example of how to get the ID you are sending traces to in WhyLabs, you can pass this in
// or read it from an env variable if you have that defined:
const datasetId = process.env.WHYLABS_DEFAULT_DATASET_ID ?? "model-1";
const provider = initialize_tracing(config, datasetId, "openllmtelemetry-instrumented-service");
const tracer = trace.getTracer('openllmtelemetry', '0.0.1');

// OpenAI setup
const llm_model_name = "gpt-3.5-turbo";
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Example usage
const userPrompt = "What is the speed of light?";
(async () => {
  try {
    const application_response = await processPrompt(userPrompt, datasetId, tracer);
    console.log(application_response);

    // Ensure all spans are exported before exiting
    await provider.shutdown();
  } catch (error) {
    console.error('Failed log trace:', error);
    await provider.shutdown();
  }
})();
