<script lang="ts">
  import { api } from "~/lib/api";
  let q = $state("");
  let matches = $state<any[]>([]);
  async function search() { matches = (await api.searchSpecs(q)).matches as any[]; }
</script>
<section class="route">
  <h2>Specs</h2>
  <form onsubmit={(e) => { e.preventDefault(); search(); }}>
    <input class="search" placeholder="Search specs…" bind:value={q} />
    <button type="submit">Search</button>
  </form>
  {#each matches as m}
    <div class="match"><b>{m.section?.title ?? m.source?.title}</b><pre class="snippet">{m.snippet}</pre></div>
  {/each}
</section>
