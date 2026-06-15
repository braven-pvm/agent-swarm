<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "~/lib/api";
  import { prettifyTarget, extractFrAcRefs } from "~/lib/format";
  import type { SourceRecord } from "~/lib/types";
  import Markdown from "~/components/Markdown.svelte";

  let sources = $state<SourceRecord[]>([]);
  let loading = $state(true);
  let q = $state("");

  let selectedId = $state<string | null>(null);
  let detailLoading = $state(false);
  let detailSource = $state<SourceRecord | null>(null);
  let detailMarkdown = $state<string | null>(null);
  let detailError = $state<string | null>(null);

  const filtered = $derived((() => {
    const lq = q.toLowerCase();
    if (!lq) return sources;
    return sources.filter((s) => {
      const domain = (s.metadata?.domain as string | undefined) ?? "";
      return (
        s.title.toLowerCase().includes(lq) ||
        s.uri.toLowerCase().includes(lq) ||
        domain.toLowerCase().includes(lq)
      );
    });
  })());

  const detailRefs = $derived(detailMarkdown ? extractFrAcRefs(detailMarkdown) : []);

  onMount(async () => {
    try {
      const snap = await api.snapshot();
      sources = snap.sources;
    } catch (e) {
      // leave sources empty; UI shows empty state
    } finally {
      loading = false;
    }
  });

  async function selectSource(id: string) {
    if (selectedId === id) return;
    selectedId = id;
    detailSource = null;
    detailMarkdown = null;
    detailError = null;
    detailLoading = true;
    try {
      const result = await api.source(id);
      detailSource = result.source as SourceRecord;
      detailMarkdown = result.markdown;
    } catch (e) {
      detailError = e instanceof Error ? e.message : String(e);
    } finally {
      detailLoading = false;
    }
  }
</script>

<section class="route specs-route">
  <h2>Specs</h2>
  <div class="specs-layout">
    <div class="specs-sidebar">
      <input
        class="search"
        placeholder="Filter by title, domain, or URI…"
        bind:value={q}
        oninput={() => {}}
      />
      {#if loading}
        <div class="empty">Loading…</div>
      {:else if filtered.length === 0}
        <div class="empty">{q ? "No matches." : "No specs registered."}</div>
      {:else}
        <ul class="spec-list">
          {#each filtered as src (src.id)}
            <li>
              <button
                class="spec-row{selectedId === src.id ? ' selected' : ''}"
                onclick={() => selectSource(src.id)}
              >
                <span class="spec-title">{src.title}</span>
                <span class="spec-meta muted">
                  {(src.metadata?.domain as string | undefined) ?? "—"}
                  &nbsp;·&nbsp;
                  {prettifyTarget(src.uri)}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if selectedId}
      <div class="spec-detail">
        {#if detailLoading}
          <div class="empty">Loading…</div>
        {:else if detailError}
          <div class="error">{detailError}</div>
        {:else if detailSource && detailMarkdown !== null}
          <div class="spec-detail-meta">
            <div class="kv"><b>title</b> {detailSource.title}</div>
            {#if detailSource.metadata?.domain}
              <div class="kv"><b>domain</b> {detailSource.metadata.domain as string}</div>
            {/if}
            {#if detailSource.metadata?.tags}
              <div class="kv"><b>tags</b> {(detailSource.metadata.tags as string[]).join(", ")}</div>
            {/if}
            {#if detailSource.metadata?.priority !== undefined}
              <div class="kv"><b>priority</b> {detailSource.metadata.priority as number}</div>
            {/if}
            <div class="kv"><b>uri</b> <span class="muted">{detailSource.uri}</span></div>
          </div>
          {#if detailRefs.length > 0}
            <div class="refs spec-refs">
              {#each detailRefs as r}
                <span class="ref">{r}</span>
              {/each}
            </div>
          {/if}
          <div class="spec-md"><Markdown md={detailMarkdown} /></div>
        {/if}
      </div>
    {/if}
  </div>
</section>
