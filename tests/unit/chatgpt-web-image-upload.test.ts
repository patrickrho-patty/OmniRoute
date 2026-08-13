import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCurrentTurnImageUrls,
  readImageDimensions,
} from "../../open-sse/services/chatgptImageUpload.ts";

// ── extractCurrentTurnImageUrls ─────────────────────────────────────────────

test("extracts image_url parts from the current user turn", () => {
  const urls = extractCurrentTurnImageUrls([
    { role: "system", content: "you are helpful" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
      ],
    },
  ]);
  assert.deepEqual(urls, ["data:image/png;base64,AAAA", "https://example.com/a.jpg"]);
});

test("supports bare-string image_url and input_image parts", () => {
  const urls = extractCurrentTurnImageUrls([
    {
      role: "user",
      content: [
        { type: "image_url", image_url: "https://example.com/b.png" },
        { type: "input_image", image_url: { url: "https://example.com/c.webp" } },
      ],
    },
  ]);
  assert.deepEqual(urls, ["https://example.com/b.png", "https://example.com/c.webp"]);
});

test("returns empty for text-only / string content turns", () => {
  assert.deepEqual(extractCurrentTurnImageUrls([{ role: "user", content: "hello" }]), []);
  assert.deepEqual(
    extractCurrentTurnImageUrls([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    []
  );
});

test("extracts from an image-only user turn (no text part)", () => {
  const urls = extractCurrentTurnImageUrls([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,ZZZ" } }],
    },
  ]);
  assert.deepEqual(urls, ["data:image/png;base64,ZZZ"]);
});

test("ignores malformed parts and empty urls without throwing", () => {
  const urls = extractCurrentTurnImageUrls([
    {
      role: "user",
      content: [
        null,
        "raw-string-part",
        { type: "image_url" },
        { type: "image_url", image_url: { url: "   " } },
        { type: "image_url", image_url: { url: "https://ok/x.png" } },
      ] as unknown[],
    },
  ]);
  assert.deepEqual(urls, ["https://ok/x.png"]);
});

test("returns empty when the last user turn has string content even if earlier turns had images", () => {
  const urls = extractCurrentTurnImageUrls([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://old/a.png" } }],
    },
    { role: "assistant", content: "ok" },
    { role: "user", content: "now just text" },
  ]);
  assert.deepEqual(urls, []);
});

test("reads only the LAST user turn's images", () => {
  const urls = extractCurrentTurnImageUrls([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://old/first.png" } }],
    },
    { role: "assistant", content: "ok" },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://new/second.png" } }],
    },
  ]);
  assert.deepEqual(urls, ["https://new/second.png"]);
});

// ── readImageDimensions ─────────────────────────────────────────────────────

test("reads PNG dimensions from IHDR", () => {
  const png = Buffer.alloc(24);
  png[0] = 0x89;
  png[1] = 0x50;
  png[2] = 0x4e;
  png[3] = 0x47;
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(readImageDimensions(png), { width: 640, height: 480 });
});

test("reads GIF dimensions", () => {
  const gif = Buffer.alloc(10);
  gif.write("GIF8", 0, "ascii");
  gif.writeUInt16LE(300, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(readImageDimensions(gif), { width: 300, height: 200 });
});

test("reads JPEG dimensions from SOF0", () => {
  // FFD8 SOI, then FFC0 SOF0 with len, precision, height, width
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80]);
  // height @ off+5 = 0x0190 = 400, width @ off+7 = 0x0280 = 640
  assert.deepEqual(readImageDimensions(jpeg), { width: 640, height: 400 });
});

test("returns null for unrecognized bytes", () => {
  assert.equal(readImageDimensions(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
});
