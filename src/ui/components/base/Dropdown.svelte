<!-- Copied over from obsidian-periodic-notes -->
<script lang="ts">
  interface IOption {
    value: string;
    text: string;
  }

  interface Props {
    onChange: (value: string, el: HTMLSelectElement) => void;
    options: IOption[];
    value: string;
    disabled?: boolean;
    class?: string;
  }

    let {
        onChange = () => {},
        options = [],
        value = "",
        disabled = false,
        class: className = ""
    }: Props = $props();
</script>

<select
  class={className ? className + " dropdown" : "dropdown"}
  {disabled}
  onchange={(e) => onChange(e.currentTarget.value, e.currentTarget)}
  {value}
>
  {#each options as { value, text } (value)}
    <option {value}>{text}</option>
  {/each}
</select>
