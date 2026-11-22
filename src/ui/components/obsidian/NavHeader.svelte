<script lang="ts">
    import type { Snippet } from "svelte";

    interface Props {
        container?: Snippet;
    }

    let {container}: Props = $props();
</script>

<div class="nav-header">
    <div class="nav-buttons-container">
        <!-- NOTE: slot-in using svelte:fragment to avoid extra dom layer being added -->
        {#if container}
            {@render container()}
        {:else}
            <span>Empty navheader</span>
        {/if}
    </div>
</div>
