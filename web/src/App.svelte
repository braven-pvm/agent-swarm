<script lang="ts">
  import { onMount } from "svelte";
  import { createConsoleStore } from "~/lib/console.svelte";
  import { api } from "~/lib/api";
  import { connectStream } from "~/lib/sse";
  import StatusBar from "~/components/StatusBar.svelte";
  import AgentRoster from "~/components/AgentRoster.svelte";
  import WorkBoard from "~/components/WorkBoard.svelte";
  import OverseerTimeline from "~/components/OverseerTimeline.svelte";
  import EscalationsRail from "~/components/EscalationsRail.svelte";
  import FocusRail from "~/components/FocusRail.svelte";
  import InspectorDrawer from "~/components/InspectorDrawer.svelte";
  import ObservabilityCallout from "~/components/ObservabilityCallout.svelte";

  const store = createConsoleStore();
  let route = $state<"bridge" | "specs" | "history" | "coverage">("bridge");
  // Cross-link seed: a requirement ref clicked in Specs opens Coverage filtered to it.
  // The top Coverage nav button resets this to "" so it always opens unfiltered.
  let coverageSeed = $state<string>("");

  function openCoverageFiltered(ref: string) {
    coverageSeed = ref;
    route = "coverage";
  }
  function openCoverageNav() {
    coverageSeed = "";
    route = "coverage";
  }

  const clamp = (n: number) => Math.max(180, Math.min(560, Number.isFinite(n) ? n : 240));
  let agentsW = $state(240);
  let cockpitEl = $state<HTMLElement | null>(null);
  let resizing = $state(false);

  async function refresh() {
    try {
      const [snap, cov] = await Promise.all([api.snapshot(200), api.coverage().catch(() => null)]);
      store.hydrate(snap);
      if (cov) store.setCoverage(cov);
    } catch (e) { console.error("snapshot failed", e); }
  }

  function startResize(e: PointerEvent) {
    resizing = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    document.body.classList.add("cb-resizing");
    e.preventDefault();
  }
  function onMove(e: PointerEvent) {
    if (!resizing || !cockpitEl) return;
    const left = cockpitEl.getBoundingClientRect().left;
    const pad = parseFloat(getComputedStyle(cockpitEl).paddingLeft) || 0;
    agentsW = clamp(e.clientX - left - pad);
  }
  function endResize() {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove("cb-resizing");
    localStorage.setItem("cb.agentsWidth", String(Math.round(agentsW)));
  }

  onMount(() => {
    const s = localStorage.getItem("cb.agentsWidth");
    if (s) agentsW = clamp(+s);

    refresh();
    const poll = setInterval(refresh, 2500);
    const handle = connectStream({
      onOpen: () => { store.setConnected(true); refresh(); },
      onError: () => store.setConnected(false),
      onFrame: (frame) => {
        if (frame.type === "event.appended") store.applyEvent(frame.data);
        else if (frame.type === "heartbeat.changed") store.applyHeartbeat(frame.data);
        else if (frame.type === "snapshot.invalidated") refresh();
      },
    });
    return () => { clearInterval(poll); handle.close(); };
  });
</script>

<div class="bridge">
  <StatusBar {store} />
  <nav class="routes">
    <button class:active={route === "bridge"} onclick={() => (route = "bridge")}>Bridge</button>
    <button class:active={route === "coverage"} onclick={openCoverageNav}>Coverage</button>
    <button class:active={route === "specs"} onclick={() => (route = "specs")}>Specs</button>
    <button class:active={route === "history"} onclick={() => (route = "history")}>History</button>
  </nav>
  {#if route !== "coverage"}
    <ObservabilityCallout {store} onGoCoverage={() => (route = "coverage")} />
  {/if}

  {#if route === "bridge"}
    <main
      class="cockpit"
      bind:this={cockpitEl}
      style="grid-template-columns: {agentsW}px 6px 1fr 280px;"
      onpointermove={onMove}
      onpointerup={endResize}
      onpointerleave={endResize}
    >
      <AgentRoster {store} onSelect={(actor) => store.select({ kind: "agent", actor })} />
      <div
        class="col-resizer"
        class:resizing={resizing}
        role="separator"
        aria-orientation="vertical"
        onpointerdown={startResize}
      ></div>
      <div class="center">
        <WorkBoard {store} onSelect={(id) => store.select({ kind: "slice", id })} />
        <OverseerTimeline {store} onSelect={(eventId) => store.select({ kind: "overseerTurn", eventId })} />
      </div>
      <div class="right-rail">
        <FocusRail
          {store}
          onZoomSlice={(id) => store.select({ kind: "focusSlice", id })}
          onZoomRun={(id) => store.select({ kind: "focusRun", id })}
        />
        <EscalationsRail {store} onSelect={(id) => store.select({ kind: "escalation", id })} />
      </div>
      <InspectorDrawer {store} />
    </main>
  {:else if route === "specs"}
    {#await import("~/routes/Specs.svelte") then m}<m.default {store} onOpenRef={openCoverageFiltered} />{:catch}<div class="error">Route failed to load.</div>{/await}
  {:else if route === "history"}
    {#await import("~/routes/History.svelte") then m}<m.default />{:catch}<div class="error">Route failed to load.</div>{/await}
  {:else if route === "coverage"}
    {#await import("~/routes/Coverage.svelte") then m}<m.default {store} seed={coverageSeed} />{:catch}<div class="error">Route failed to load.</div>{/await}
  {/if}
</div>
