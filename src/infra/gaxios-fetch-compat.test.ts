import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("gaxios fetch compat", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses native fetch without defining window or importing node-fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("node-fetch", () => {
      throw new Error("node-fetch should not load");
    });
    vi.doMock("gaxios", () => {
      class MockGaxios {
        async request(config: RequestInit & { responseType?: string; url: string }) {
          const response = await MockGaxios.prototype._defaultAdapter.call(this, config);
          return {
            ...(response as object),
            data: await (response as Response).text(),
          };
        }
      }

      MockGaxios.prototype._defaultAdapter = async (
        config: RequestInit & { fetchImplementation?: typeof fetch; url: string },
      ) => {
        const fetchImplementation = config.fetchImplementation ?? fetch;
        return await fetchImplementation(config.url, config);
      };

      return { Gaxios: MockGaxios };
    });

    const { installGaxiosFetchCompat } = await import("./gaxios-fetch-compat.js");
    const { Gaxios } = await import("gaxios");

    await installGaxiosFetchCompat();

    const res = await new Gaxios().request({
      responseType: "text",
      url: "https://example.com",
    });

    expect(res.data).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect("window" in globalThis).toBe(false);
  });

  it("falls back to a legacy window fetch shim when gaxios is unavailable", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis as object, "window");
    vi.doMock("gaxios", () => ({
      get Gaxios() {
        throw Object.assign(new Error("Cannot find package 'gaxios'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    }));
    const { installGaxiosFetchCompat } = await import("./gaxios-fetch-compat.js");

    try {
      await expect(installGaxiosFetchCompat()).resolves.toBeUndefined();
      expect((globalThis as { window?: { fetch?: typeof fetch } }).window?.fetch).toBe(fetch);
      await expect(installGaxiosFetchCompat()).resolves.toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis as object, "window");
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });

  it("translates proxy agents into undici dispatchers for native fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    });
    const { createGaxiosCompatFetch } = await import("./gaxios-fetch-compat.js");

    const compatFetch = createGaxiosCompatFetch(fetchMock);
    await compatFetch("https://example.com", {
      agent: new HttpsProxyAgent("http://proxy.example:8080"),
    } as RequestInit);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];

    expect(init).not.toHaveProperty("agent");
    expect((init as { dispatcher?: unknown })?.dispatcher).toBeInstanceOf(ProxyAgent);
  });
});
