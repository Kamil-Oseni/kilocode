# Connecting Local Models to Raya

Short answer: yes. If you build or buy a machine with a capable enough GPU, you can point Raya at models running on your own hardware and stop paying per token for that work. Raya inherits opencode's provider system, which already understands any OpenAI-compatible endpoint, and every serious local-inference runtime exposes exactly that kind of endpoint. This guide explains what to run, how to wire it into Raya's config, and — importantly — where local models help and where they will disappoint you.

## What "good enough" actually means

The GPU requirement is driven almost entirely by one thing: how much model you can hold in VRAM. A coding-capable open-weight model that can drive tools reliably wants to be a large model, and large models need a lot of memory. As a rough orientation, a quantized model needs a little over half a gigabyte of VRAM per billion parameters at 4-bit, plus headroom for the context window. That puts a 32-billion-parameter model comfortably on a 24 GB card, a 70-billion model on a single high-end 48 GB card or a pair of 24 GB cards, and anything larger into multi-GPU or heavily quantized territory where quality starts to slip.

The honest caveat is the one that matters most for Raya specifically: much of Raya's value comes from goal orchestration and tool calling, and not every open model calls tools well. A model that produces beautiful prose but cannot emit clean tool calls will stall the goal runner. Favor open models with strong, native function-calling support and test that first, before you judge anything else about them. This is the same constraint that motivates pinning goal orchestration to a tool-capable model on the paid providers.

## Pick a runtime

Three runtimes cover essentially everyone, and all three speak the OpenAI-compatible API that Raya needs.

Ollama is the easiest to start with. You install it, run `ollama pull` for a model, and it serves an OpenAI-compatible endpoint at `http://localhost:11434/v1` with no further configuration. Start here.

LM Studio is the friendliest if you want a GUI to manage models and watch resource use, and its built-in server exposes the same OpenAI-compatible surface, typically at `http://localhost:1234/v1`.

llama.cpp (via its `llama-server` binary) or vLLM are for when you want maximum control or throughput. vLLM in particular is the right choice if you eventually serve several developers from one machine, because it is built for concurrent high-throughput inference rather than single-user convenience.

For a first build, run Ollama, confirm it works, and only graduate to vLLM if you outgrow it.

## Wire it into Raya

Raya reads its provider configuration from the same JSON config opencode uses. A local runtime is registered as a custom provider whose `npm` package is the OpenAI-compatible AI SDK adapter and whose `baseURL` points at your local server. You then list the models you have pulled, using the exact model id the runtime reports.

For Ollama, a working provider block looks like this:

```json
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local (Ollama)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen2.5-coder:32b": {
          "name": "Qwen2.5 Coder 32B (local)"
        }
      }
    }
  }
}
```

For LM Studio, the only change is the `baseURL` (`http://localhost:1234/v1`) and the model ids that LM Studio reports for whatever you have loaded. The provider key (`local` above) is an identifier you choose; the model keys must match exactly what the runtime serves, because that string is what Raya sends on the wire.

Local runtimes usually need no API key. If your setup does require one — for instance a shared vLLM instance behind a token — add it under `options.apiKey`. Once the provider is in config, its models appear in Raya's model picker like any other, and you select the local model there.

## Where local models fit in your workflow

The realistic pattern is a hybrid one, and it is worth designing for deliberately rather than treating local as all-or-nothing. Route the high-volume, lower-stakes work — routine edits, summaries, quick questions, the many small calls a long session makes — to the local model, where each token is effectively free once the hardware is paid for. Keep a paid frontier model available for the hardest reasoning and for goal orchestration, where tool-calling reliability and raw capability still justify the cost. Because Raya lets you pick the model per session and can pin goal orchestration to a specific capable model, you can run most of your day locally while still reaching for a paid model on the runs that genuinely need it.

If you serve a team from one strong machine, put vLLM behind the same kind of authenticated gateway described in the mobile plan, so several developers share the GPU through one endpoint rather than each running their own runtime. That turns a single good local box into shared infrastructure and is where the economics of buying hardware instead of paying per token become most compelling.

## A sane first setup

Install Ollama, pull a strong tool-capable coding model sized to your VRAM, and add the provider block above to your Raya config. Point one non-critical session at it and give it a real task that requires a few tool calls — a small edit plus a verification read — and watch whether the tool calls land cleanly. If they do, widen its use. If they stall, the model's function-calling is the problem, not your setup, and you should try a different open model before concluding local inference does not work for you.
