# @image-cascade/conformance

**Conformance suite and language-neutral corpus for [image-context-cascade](https://www.npmjs.com/package/image-context-cascade) adapters.**

If you wire the cascade into a new agent, framework, or provider format, this package tells you whether your integration actually preserves the invariants that make the pattern safe:

- current-turn images are never touched;
- historical images are downgraded to byte-stable placeholders;
- telemetry never leaks image data;
- malformed input fails open.

## Usage

```ts
import { runConformance, loadCorpusCases, runCorpusConformance } from "@image-cascade/conformance";

// Wrap your adapter in a harness: (payload) => ({ payload, telemetry })
const report = await runConformance(myAdapterHarness);
if (!report.ok) console.error(report.failures);
```

## The corpus

`corpus/` ships JSON case files (importable via `@image-cascade/conformance/corpus/<name>.json`) that pin expected behavior for Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, document attachments, and boundary edge cases. The cases are **language-neutral**: a Python or Go port can consume the same fixtures and claim conformance against the same expectations.

See the [adapter guide](https://github.com/dlgod7/image-context-cascade/blob/main/docs/adapter-guide.md) and [verification doc](https://github.com/dlgod7/image-context-cascade/blob/main/docs/verification.md) for the full contract.

Apache-2.0.
