<script lang="ts">
  import { renderMarkdown, renderInline } from "~/lib/markdown";
  let { md = "", inline = false }: { md?: string; inline?: boolean } = $props();
  const html = $derived(inline ? renderInline(md) : renderMarkdown(md));
</script>
{#if inline}<span class="md-inline">{@html html}</span>{:else}<div class="md">{@html html}</div>{/if}
