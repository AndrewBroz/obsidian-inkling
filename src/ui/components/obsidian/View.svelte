<script lang="ts">
    import type { Snippet } from "svelte";

    interface Props {
        header?: Snippet<[string]>;
        view?: Snippet<[string]>;

        class?: string;
    }

    let {header, view, class: className = ""}: Props = $props();
</script>


{#if header}
    {@render header(className)}
{/if}
{#if view}
    {@render view(className)}
{/if}
