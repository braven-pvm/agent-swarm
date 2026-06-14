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
  import InspectorDrawer from "~/components/InspectorDrawer.svelte";

  const store = createConsoleStore();
  let route = $state<"bridge" | "specs" | "history">("bridge");

  async function refresh() {
    try { store.hydrate(await api.snapshot(200)); } catch (e) { console.error("snapshot failed", e); }
  }

  onMount(() => {
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
    <button class:active={route === "specs"} onclick={() => (route = "specs")}>Specs</button>
    <button class:active={route === "history"} onclick={() => (route = "history")}>History</button>
  </nav>

  {#if route === "bridge"}
    <main class="cockpit">
      <AgentRoster {store} onSelect={(actor) => store.select({ kind: "agent", actor })} />
      <div class="center">
        <WorkBoard {store} onSelect={(id) => store.select({ kind: "slice", id })} />
        <OverseerTimeline {store} onSelect={(eventId) => store.select({ kind: "overseerTurn", eventId })} />
      </div>
      <EscalationsRail {store} onSelect={(id) => store.select({ kind: "escalation", id })} />
      <InspectorDrawer {store} />
    </main>
  {:else if route === "specs"}
    {#await import("~/routes/Specs.svelte") then m}<m.default />{:catch}<div class="error">Route failed to load.</div>{/await}
  {:else if route === "history"}
    {#await import("~/routes/History.svelte") then m}<m.default />{:catch}<div class="error">Route failed to load.</div>{/await}
  {/if}
</div>
