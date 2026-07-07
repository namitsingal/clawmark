import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cosine,
  createEmbeddingClient,
  deserializeVector,
  l2Normalize,
  serializeVector,
} from "../src/embeddings.js";

const CONFIG = { embeddingUrl: "http://embed.example.internal", embeddingModel: "m", embeddingDim: 4 };

function okResponse(embeddings: number[][]): Response {
  return new Response(
    JSON.stringify({ data: embeddings.map((embedding, index) => ({ index, embedding })) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("embeddings", () => {
  it("returns normalized vectors on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([[3, 4, 0, 0], [0, 0, 5, 12]])));
    const client = createEmbeddingClient(CONFIG);
    const [a, b] = await client.embedTexts(["one", "two"]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const norm = (v: Float32Array) => Math.sqrt([...v].reduce((s, x) => s + x * x, 0));
    expect(norm(a!)).toBeCloseTo(1, 5);
    expect(norm(b!)).toBeCloseTo(1, 5);
  });

  it("returns all-null on network failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const client = createEmbeddingClient(CONFIG);
    expect(await client.embedTexts(["a", "b"])).toEqual([null, null]);
  });

  it("returns all-null on non-200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const client = createEmbeddingClient(CONFIG);
    expect(await client.embedTexts(["a"])).toEqual([null]);
  });

  it("rejects wrong-dimension vectors and logs", async () => {
    const logs: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([[1, 2]])));
    const client = createEmbeddingClient(CONFIG, (m) => logs.push(m));
    expect(await client.embedTexts(["a"])).toEqual([null]);
    expect(logs.join(" ")).toMatch(/dim mismatch/);
  });

  it("serialize/deserialize roundtrip is exact", () => {
    const vec = l2Normalize(new Float32Array([0.1, -2.5, 3.25, 0]));
    const back = deserializeVector(serializeVector(vec));
    expect([...back]).toEqual([...vec]);
  });

  it("caches query embeddings (one fetch for repeated query) but not failures", async () => {
    const fetchMock = vi.fn(async () => okResponse([[1, 0, 0, 0]]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbeddingClient(CONFIG);
    await client.embedQuery("same");
    await client.embedQuery("same");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cosine of identical normalized vectors is 1", () => {
    const v = l2Normalize(new Float32Array([1, 2, 3, 4]));
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });
});
