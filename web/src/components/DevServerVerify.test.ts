import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import DevServerVerify from "~/components/DevServerVerify.svelte";

function stubFetch(response: unknown, ok = true, status = 200) {
  let lastPath: string | undefined;
  let lastInit: RequestInit | undefined;
  const fetchMock = vi.fn().mockImplementation(async (path: string, init?: RequestInit) => {
    lastPath = path;
    lastInit = init;
    return { ok, status, json: async () => response, text: async () => String(response) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    get path() { return lastPath; },
    get body() { return lastInit?.body ? JSON.parse(lastInit.body as string) : undefined; },
  };
}

describe("DevServerVerify", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts the dev server for the action target and shows the URL to open for verification", async () => {
    const f = stubFetch({ ok: true, server: { targetName: "support-ui", status: "running", url: "http://127.0.0.1:4322/" } });
    const { getByText, container } = render(DevServerVerify, { props: { targetName: "support-ui" } });
    await fireEvent.click(getByText("Start dev server to verify"));
    await waitFor(() => expect(container.querySelector(".ha-verify-ok")).toBeTruthy());
    expect(f.path).toBe("/api/control/dev-server/start");
    expect(f.body).toEqual({ targetName: "support-ui" });
    const link = container.querySelector(".ha-verify-ok a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:4322/");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows a no-start-script failure inline (with stderr) and never blocks manual sign-off", async () => {
    stubFetch(
      { ok: false, error: "Target has no start script.", server: { targetName: "support-ui", status: "failed", stderrHref: "/api/artifacts/e.log" } },
      false,
      400,
    );
    const { getByText, container } = render(DevServerVerify, { props: { targetName: "support-ui" } });
    await fireEvent.click(getByText("Start dev server to verify"));
    await waitFor(() => expect(container.querySelector(".ha-verify-fail")).toBeTruthy());
    const failText = container.querySelector(".ha-verify-fail")!.textContent ?? "";
    expect(failText).toMatch(/no start script/i);
    expect(failText).toMatch(/record sign-off manually/i); // does not block the manual form
    const link = container.querySelector(".ha-verify-fail a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/artifacts/e.log");
  });

  it("disables the start button and explains when there is no resolvable target", () => {
    const f = stubFetch({ ok: true });
    const { getByText } = render(DevServerVerify, { props: { targetName: undefined } });
    expect((getByText("Start dev server to verify") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText(/No resolvable target/i)).toBeTruthy();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("does not double-submit while a start is in flight", async () => {
    // Hang the first request so the in-flight guard (`starting`) is still set on the second click.
    let resolve!: (v: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((r) => { resolve = () => r({ ok: true, status: 200, json: async () => ({ ok: true, server: { url: "http://127.0.0.1:1/", status: "running" } }), text: async () => "" }); }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getByText } = render(DevServerVerify, { props: { targetName: "support-ui" } });
    const btn = getByText("Start dev server to verify");
    await fireEvent.click(btn);
    await fireEvent.click(btn);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second click is blocked while in flight
    resolve(undefined);
    await waitFor(() => expect((btn as HTMLButtonElement).textContent).toContain("Start dev server"));
  });
});
