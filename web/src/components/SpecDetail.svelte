<script lang="ts">
  import {
    prettifyTarget,
    domainTint,
    extractFrAcRefs,
    groupRefsByFamily,
    countRefStatuses,
    refTone,
    worstStatus,
    parseHeadings,
    type RefStatus,
  } from "~/lib/format";
  import { renderMarkdown, linkifyRefs, injectHeadingIds, highlightFind } from "~/lib/markdown";
  import type { SourceRecord, CoverageRef, SliceWithDetail, ReviewFinding } from "~/lib/types";
  import RefChip from "~/components/RefChip.svelte";
  import RequirementDetail from "~/components/RequirementDetail.svelte";

  let {
    source,
    markdown,
    refMap,
    slices = [],
    onOpenRef,
  }: {
    source: SourceRecord;
    markdown: string;
    /** UPPERCASE ref → CoverageRef for refs owned by THIS source (empty when coverage is null). */
    refMap: Map<string, CoverageRef>;
    /** snapshot.slices — used to resolve the per-AC reviewer finding for an expanded ref. */
    slices?: SliceWithDetail[];
    onOpenRef?: (ref: string) => void;
  } = $props();

  const domain = $derived(source.metadata?.domain as string | undefined);
  const tags = $derived((source.metadata?.tags as string[] | undefined) ?? []);
  const priority = $derived(source.metadata?.priority as number | undefined);
  const spine = $derived(domainTint(domain));

  const refs = $derived(extractFrAcRefs(markdown));
  const counts = $derived(countRefStatuses(refs, refMap));
  const pct = $derived(counts.indexed > 0 ? Math.round((100 * counts.done) / counts.indexed) : 0);
  const families = $derived(groupRefsByFamily(refs));

  // Status → uppercase-ref map handed to the markdown linkify pass.
  const statusByRef = $derived.by(() => {
    const m = new Map<string, string>();
    for (const [k, v] of refMap) m.set(k, v.status);
    return m;
  });

  // Segmented coverage band widths (proportion of TOTAL extracted refs).
  const seg = $derived.by(() => {
    const t = counts.total || 1;
    const remaining = counts.notStarted + (counts.total - counts.indexed);
    return {
      done: (100 * counts.done) / t,
      inprog: (100 * counts.inProgress) / t,
      bad: (100 * counts.blockedFailed) / t,
      none: (100 * remaining) / t,
    };
  });

  // Non-zero status buckets for the Zone-2 legend (each locally filters the ledger).
  const legend = $derived.by(() => {
    const out: Array<{ status: RefStatus; n: number }> = [];
    if (counts.done) out.push({ status: "done", n: counts.done });
    if (counts.inProgress) out.push({ status: "in_progress", n: counts.inProgress });
    if (counts.blockedFailed) out.push({ status: "blocked", n: counts.blockedFailed });
    if (counts.notStarted) out.push({ status: "not_started", n: counts.notStarted });
    return out;
  });

  // ── Local filters (do NOT navigate) ────────────────────────────────────
  let statusFilter = $state<RefStatus | null>(null);
  let find = $state("");
  // debounced copy of `find` for the (heavier) body-highlight pass
  let findDebounced = $state("");
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const v = find;
    clearTimeout(findTimer);
    findTimer = setTimeout(() => (findDebounced = v), 140);
    return () => clearTimeout(findTimer);
  });

  function toggleStatus(s: RefStatus) {
    statusFilter = statusFilter === s ? null : s;
  }

  // ── Per-ref detail disclosure (chip-as-expander) ───────────────────────
  // Clicking a RefChip toggles that ref's RequirementDetail inline as a full-width
  // band beneath the family's chip cloud — the chip IS the expander here (no separate
  // obligation toggle). Only one ref is open per spec. The cross-link to Coverage now
  // lives INSIDE RequirementDetail ("View in coverage →"); the chip itself never
  // navigates in this surface.
  let expandedRef = $state<string | null>(null);
  function toggleRef(ref: string) {
    expandedRef = expandedRef === ref.toUpperCase() ? null : ref.toUpperCase();
  }

  // Resolve the richest per-AC reviewer finding for a ref: coverage row → owning slice
  // (via sliceId) → its reviewResult.frAcFindings, matched case-insensitively (findings
  // key on the UPPERCASE ref). Undefined when no slice / no review / no matching finding.
  function findingFor(ref: string): ReviewFinding | undefined {
    const rec = refMap.get(ref.toUpperCase());
    if (!rec?.sliceId) return undefined;
    const slice = slices.find((s) => s.id === rec.sliceId);
    const want = ref.toUpperCase();
    return slice?.reviewResult?.frAcFindings.find((f) => f.ref.toUpperCase() === want);
  }

  // Reset expandedRef when the source/spec changes so a same-named ref from a
  // previous spec is never shown pre-expanded in the new one.
  $effect(() => {
    void source.uri; // depend on the source identity
    expandedRef = null;
  });

  // ── Per-family roll-up (collapsible) ───────────────────────────────────
  // Families are COLLAPSED by default — the header (progress bar + done/total +
  // worst-status glyph) conveys the family's state at a glance, and the operator
  // expands only the families they want to drill into. A click records a
  // component-local override. An active find query or status filter force-expands
  // any family with matching refs (so a search hit is never hidden in a collapsed family).
  let familyOverride = $state<Record<string, boolean>>({});

  // Clear overrides on spec change so families re-collapse per spec.
  $effect(() => {
    void source.uri;
    familyOverride = {};
  });

  function familyOpen(family: string): boolean {
    const filtering = !!find.trim() || !!statusFilter;
    if (filtering) return true; // a matching ref exists (familyRows already filtered) → reveal it
    return familyOverride[family] ?? false; // collapsed by default
  }
  function toggleFamily(family: string) {
    familyOverride = { ...familyOverride, [family]: !(familyOverride[family] ?? false) };
  }

  // A ref matches the active status filter when its (blocked|failed) collapse to "blocked".
  function matchesStatus(rec: CoverageRef | undefined): boolean {
    if (!statusFilter) return true;
    if (!rec) return false;
    if (statusFilter === "blocked") return rec.status === "blocked" || rec.status === "failed";
    return rec.status === statusFilter;
  }
  function matchesFind(ref: string): boolean {
    const q = find.trim().toLowerCase();
    return !q || ref.toLowerCase().includes(q);
  }

  // Per-family rendering rows with counts, the worst status (for the header glyph),
  // and the filter-narrowed ref list.
  const familyRows = $derived.by(() =>
    families
      .map((g) => {
        const fc = countRefStatuses(g.refs, refMap);
        const worst = worstStatus(g.refs.map((r) => refMap.get(r.toUpperCase())?.status));
        const visible = g.refs.filter((r) => matchesStatus(refMap.get(r.toUpperCase())) && matchesFind(r));
        return { family: g.family, counts: fc, worst, allRefs: g.refs, visible };
      })
      .filter((row) => row.visible.length > 0),
  );

  const fpct = (n: number, d: number) => (d ? (100 * n) / d : 0);

  // ── TOC (headings) ─────────────────────────────────────────────────────
  const toc = $derived(parseHeadings(markdown));
  let activeSlug = $state<string | null>(null);

  function tocMatches(text: string): boolean {
    const q = find.trim().toLowerCase();
    return !q || text.toLowerCase().includes(q);
  }

  // ── Body post-processing (status chips + heading ids + find marks) ─────
  // Keyed to (markdown, refMap, findDebounced): rebuilt from the raw render each
  // pass, so it stays idempotent (we never reprocess our own output).
  const bodyHtml = $derived.by(() => {
    if (markdown == null) return "";
    let html = renderMarkdown(markdown);
    html = injectHeadingIds(html);
    html = linkifyRefs(html, statusByRef);
    const { html: marked } = highlightFind(html, findDebounced);
    return marked;
  });

  // ── Find navigation over body hits (k / N + prev/next) ────────────────
  let scrollEl = $state<HTMLElement | null>(null);
  let bodyEl = $state<HTMLElement | null>(null);
  let hits = $state<HTMLElement[]>([]);
  let hitIndex = $state(0);

  // Recollect hit elements after each body render / find change.
  $effect(() => {
    // depend on bodyHtml + findDebounced so we re-query after the DOM updates
    void bodyHtml;
    void findDebounced;
    if (!bodyEl) {
      hits = [];
      return;
    }
    queueMicrotask(() => {
      if (!bodyEl) return;
      hits = Array.from(bodyEl.querySelectorAll<HTMLElement>("mark.find-hit"));
      hitIndex = 0;
      if (hits.length) focusHit(0);
    });
  });

  function focusHit(i: number) {
    hits.forEach((h, idx) => h.classList.toggle("find-hit-current", idx === i));
    const el = hits[i];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  function nextHit() {
    if (!hits.length) return;
    hitIndex = (hitIndex + 1) % hits.length;
    focusHit(hitIndex);
  }
  function prevHit() {
    if (!hits.length) return;
    hitIndex = (hitIndex - 1 + hits.length) % hits.length;
    focusHit(hitIndex);
  }
  function onFindKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prevHit();
      else nextHit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      find = "";
    }
  }

  // ── Delegated ref-click over the prose chips ──────────────────────────
  // A Svelte action wires a single delegated listener imperatively, so the inline
  // RefChip buttons (rebuilt from raw HTML each pass) need no per-button bindings,
  // and the non-interactive body <div> takes no svelte event handler (a11y-clean).
  function refDelegate(node: HTMLElement) {
    const handler = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>("button.spec-ref[data-ref]");
      if (!btn || btn.hasAttribute("disabled")) return;
      const ref = btn.dataset.ref;
      if (ref) onOpenRef?.(ref);
    };
    node.addEventListener("click", handler);
    return { destroy: () => node.removeEventListener("click", handler) };
  }

  // ── Scrollspy: highlight the active TOC chip via IntersectionObserver ──
  // Scoped to the scroll container; re-created when the body/spec changes.
  $effect(() => {
    void bodyHtml;
    if (!scrollEl || !bodyEl || toc.length === 0) {
      activeSlug = null;
      return;
    }
    let observer: IntersectionObserver | null = null;
    const visible = new Map<string, number>();
    queueMicrotask(() => {
      if (!bodyEl || !scrollEl) return;
      const headings = Array.from(bodyEl.querySelectorAll<HTMLElement>("h2[id], h3[id]"));
      if (!headings.length) return;
      observer = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            const id = (en.target as HTMLElement).id;
            if (en.isIntersecting) visible.set(id, en.intersectionRatio);
            else visible.delete(id);
          }
          // topmost visible heading (by document order) wins
          for (const h of headings) {
            if (visible.has(h.id)) {
              activeSlug = h.id;
              break;
            }
          }
        },
        { root: scrollEl, rootMargin: "0px 0px -70% 0px", threshold: [0, 1] },
      );
      headings.forEach((h) => observer!.observe(h));
    });
    return () => observer?.disconnect();
  });

  function jumpTo(slug: string) {
    const el = bodyEl?.querySelector<HTMLElement>(`#${CSS.escape(slug)}`);
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      activeSlug = slug;
    }
  }
</script>

<div class="spec-detail-scroll" bind:this={scrollEl}>
  <!-- ZONE 1 — sticky masthead -->
  <header class="spec-masthead">
    <span class="spec-spine" style="background:{spine}"></span>
    <div class="spec-masthead-main">
      <h2 class="spec-masthead-title">{source.title}</h2>
      <div class="spec-masthead-meta">
        <span class="spec-dot" style="background:{spine}"></span>
        <span class="spec-domain">{domain ?? "no domain"}</span>
        {#if priority !== undefined}
          <span class="spec-prio mono" class:high={priority <= 1}>P{priority}</span>
        {/if}
        {#each tags as t}<span class="spec-tag">{t}</span>{/each}
        <span class="spec-uri mono faint" title={source.uri}>{prettifyTarget(source.uri)}</span>
      </div>
    </div>
    <div class="spec-masthead-readout">
      <div class="spec-masthead-pct mono">{pct}%</div>
      <div class="spec-masthead-frac mono">{counts.done}/{counts.indexed || counts.total} done</div>
    </div>
  </header>

  <!-- ZONE 2 — coverage band -->
  <section class="spec-band">
    <span class="cov-domain-bar spec-band-bar" title="{counts.done} of {counts.total} requirements done">
      {#if counts.total > 0}
        <span class="spec-seg seg-done" style="width:{seg.done}%"></span>
        <span class="spec-seg seg-inprog" style="width:{seg.inprog}%"></span>
        <span class="spec-seg seg-bad" style="width:{seg.bad}%"></span>
        <span class="spec-seg seg-none" style="width:{seg.none}%"></span>
      {/if}
    </span>
    <div class="spec-band-row">
      <span class="spec-band-caption">
        {#if counts.total === 0}
          No requirements detected in this spec.
        {:else}
          {counts.done} of {counts.total} requirements done
          {#if counts.indexed < counts.total}
            <span class="faint">· {counts.total - counts.indexed} not indexed</span>
          {/if}
        {/if}
      </span>
      {#if legend.length}
        <div class="spec-legend">
          {#each legend as l}
            <button
              type="button"
              class="cov-badge {refTone(l.status).cls} spec-legend-chip"
              class:active={statusFilter === l.status}
              onclick={() => toggleStatus(l.status)}
              title="Filter the ledger to {refTone(l.status).label}"
            >
              <span class="spec-ref-glyph">{refTone(l.status).glyph}</span>{l.n} {refTone(l.status).label}
            </button>
          {/each}
          {#if statusFilter}
            <button type="button" class="spec-legend-clear" onclick={() => (statusFilter = null)}>clear</button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- find + TOC -->
    <div class="spec-band-tools">
      <div class="spec-find">
        <input
          class="search spec-find-input"
          aria-label="Find in spec"
          placeholder="Find in spec…"
          bind:value={find}
          onkeydown={onFindKey}
        />
        {#if findDebounced.trim()}
          <span class="spec-find-count mono">{hits.length ? hitIndex + 1 : 0} / {hits.length}</span>
        {/if}
        {#if hits.length > 0}
          <button type="button" class="spec-find-nav" onclick={prevHit} title="Previous (Shift+Enter)">↑</button>
          <button type="button" class="spec-find-nav" onclick={nextHit} title="Next (Enter)">↓</button>
        {/if}
      </div>
      {#if toc.length}
        <nav class="spec-toc" aria-label="Sections">
          {#each toc as h}
            <button
              type="button"
              class="spec-toc-chip"
              class:lvl3={h.level === 3}
              class:active={activeSlug === h.slug}
              class:dim={!tocMatches(h.text)}
              onclick={() => jumpTo(h.slug)}
            >{h.text}</button>
          {/each}
        </nav>
      {/if}
    </div>
  </section>

  <!-- ZONE 3 — requirement ledger + body -->
  <section class="spec-ledger">
    <div class="run-subhead spec-ledger-head">Requirements</div>
    {#if refs.length === 0}
      <p class="empty">No FR/AC references found in this spec.</p>
    {:else if familyRows.length === 0}
      <p class="empty">No requirements match the current filter.</p>
    {:else}
      {#each familyRows as row (row.family)}
        {@const open = familyOpen(row.family)}
        {@const tone = refTone(row.worst)}
        <div class="spec-family" class:collapsed={!open}>
          <button
            type="button"
            class="spec-family-head"
            aria-expanded={open}
            onclick={() => toggleFamily(row.family)}
          >
            <span class="spec-family-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span class="run-subhead spec-family-name">{row.family}</span>
            <span class="cov-domain-bar spec-family-bar">
              <span class="spec-seg seg-done" style="width:{fpct(row.counts.done, row.counts.total)}%"></span>
              <span class="spec-seg seg-inprog" style="width:{fpct(row.counts.inProgress, row.counts.total)}%"></span>
              <span class="spec-seg seg-bad" style="width:{fpct(row.counts.blockedFailed, row.counts.total)}%"></span>
              <span class="spec-seg seg-none" style="width:{fpct(row.counts.notStarted + (row.counts.total - row.counts.indexed), row.counts.total)}%"></span>
            </span>
            <span class="cov-count spec-family-count">{row.counts.done}/{row.counts.total}</span>
            <span class="spec-family-status {tone.cls}" title={tone.label}>
              <span class="spec-ref-glyph">{tone.glyph}</span>
            </span>
          </button>
          {#if open}
            <div class="spec-family-refs">
              {#each row.visible as r (r)}
                {@const expanded = expandedRef === r.toUpperCase()}
                {@const rec = refMap.get(r.toUpperCase()) ?? null}
                <span class="spec-ref-unit" class:expanded>
                  <span class="spec-ref-row">
                    <RefChip
                      ref={r}
                      record={rec}
                      onToggle={toggleRef}
                      {expanded}
                      hit={!!find.trim() && r.toLowerCase().includes(find.trim().toLowerCase())}
                    />
                  </span>
                  {#if expanded && rec}
                    <div class="spec-ref-detail">
                      <RequirementDetail ref={rec} finding={findingFor(r)} {onOpenRef} />
                    </div>
                  {/if}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  <div class="spec-body-divider"><span class="run-subhead">Specification</span></div>

  <!-- BODY — post-processed markdown with inline status chips + find marks -->
  <div
    class="spec-md md"
    bind:this={bodyEl}
    use:refDelegate
  >{@html bodyHtml}</div>
</div>
