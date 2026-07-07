import { describe, expect, test } from "bun:test";
import { builtinMatchers, cascadeImages, imageIdentity } from "../src/index";

const PNG_B64 = "iVBORw0KGgo" + "A".repeat(300);
const JPEG_B64 = "/9j/" + "B".repeat(300);
const TEXT_B64 = "SGVsbG8gd29ybGQ" + "C".repeat(300);

const genCall = (result: string) => ({
  type: "image_generation_call",
  call_id: "ig_1",
  status: "completed",
  revised_prompt: "a cat",
  result,
  saved_path: "C:/tmp/cat.png",
});
const genEnd = (result: string) => ({ type: "image_generation_end", call_id: "ig_1", status: "generating", result });
const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

const imageGenerationMatcher = builtinMatchers[4]!;

describe("openai-image-generation matcher", () => {
  test("image_generation_call_bare_base64_matched", () => {
    expect(imageGenerationMatcher.match(genCall(PNG_B64))?.identity).toEqual(imageIdentity(PNG_B64));
    expect(imageGenerationMatcher.match(genCall(JPEG_B64))?.identity).toEqual(imageIdentity(JPEG_B64));
  });

  test("image_generation_end_event_matched", () => {
    expect(imageGenerationMatcher.match(genEnd(PNG_B64))?.identity).toEqual(imageIdentity(PNG_B64));
  });

  test("non_image_or_short_result_not_matched", () => {
    for (const bad of [
      genCall(TEXT_B64),                                   // valid base64, not an image magic
      genCall("iVBORw0KGgo"),                              // image magic but below size floor
      { type: "image_generation_call", status: "completed" }, // no result
      { type: "image_generation_call", result: 42 },
      { type: "some_other_call", result: PNG_B64 },        // unrelated type with image-looking result
    ]) {
      expect(imageGenerationMatcher.match(bad)).toBeNull();
    }
  });

  test("replace_keeps_item_shape", () => {
    const replaced = imageGenerationMatcher.replace(genCall(PNG_B64), "PLACEHOLDER") as Record<string, unknown>;
    expect(replaced).toEqual({ ...genCall(PNG_B64), result: "PLACEHOLDER" });
  });

  test("extract_and_replace_with_image_roundtrip", () => {
    const extracted = imageGenerationMatcher.extract!(genCall(PNG_B64));
    expect(extracted).toEqual({ data: PNG_B64, mediaType: "image/png" });
    const restored = imageGenerationMatcher.replaceWithImage!(genCall("gone"), extracted!) as Record<string, unknown>;
    expect(restored["result"]).toBe(PNG_B64);
    expect(restored["call_id"]).toBe("ig_1");
  });

  test("historical_generation_call_downgraded_current_kept", () => {
    const currentResult = "iVBORw0KGgo" + "D".repeat(300);
    const payload = {
      items: [userMsg("draw a cat"), genCall(PNG_B64), userMsg("make it bigger"), genCall(currentResult)],
    };
    const { payload: out, mutated, telemetry } = cascadeImages(payload);
    expect(mutated).toBe(true);
    expect(telemetry.downgraded).toBe(1);
    expect(telemetry.current).toBe(1);
    expect(telemetry.byFormat["openai-image-generation"]).toBe(2);
    const items = (out as typeof payload).items;
    expect((items[1] as { result: string }).result).toContain("omitted");
    expect((items[1] as { call_id: string }).call_id).toBe("ig_1");
    expect((items[3] as { result: string }).result).toBe(currentResult);
  });

  test("generation_placeholder_byte_stable", () => {
    const payload = () => ({ items: [userMsg("old"), genCall(PNG_B64), userMsg("new")] });
    const a = cascadeImages(payload()).payload.items[1] as { result: string };
    const b = cascadeImages(payload()).payload.items[1] as { result: string };
    expect(a.result).toBe(b.result);
  });

  test("decoded_magic_sniff_covers_bmp_tiff_iso_bmff", () => {
    const pad = (bytes: number[]) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(256)]).toString("base64");
    const cases: Array<[number[], string]> = [
      [[0x42, 0x4d, 0x9a, 0x00], "image/bmp"],
      [[0x49, 0x49, 0x2a, 0x00], "image/tiff"],
      [[0x4d, 0x4d, 0x00, 0x2a], "image/tiff"],
      [[0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], "image/avif"], // ....ftypavif
      [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], "image/heic"], // ....ftypheic
      [[0x52, 0x49, 0x46, 0x46, 0x12, 0x34, 0x56, 0x78, 0x57, 0x45, 0x42, 0x50], "image/webp"], // RIFF....WEBP
    ];
    for (const [bytes, mediaType] of cases) {
      const b64 = pad(bytes);
      expect(imageGenerationMatcher.extract!(genCall(b64))).toEqual({ data: b64, mediaType });
    }
  });

  test("riff_without_webp_chunk_not_matched", () => {
    // A WAV file is RIFF too; the old base64-prefix sniff would have eaten it.
    const wav = Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WAVEfmt "), Buffer.alloc(256)]).toString("base64");
    expect(imageGenerationMatcher.match(genCall(wav))).toBeNull();
  });

  test("padding_or_invalid_base64_head_fails_closed", () => {
    for (const junk of ["====" + "A".repeat(300), "!!notbase64" + "A".repeat(300)]) {
      expect(imageGenerationMatcher.match(genCall(junk))).toBeNull();
    }
  });
});
