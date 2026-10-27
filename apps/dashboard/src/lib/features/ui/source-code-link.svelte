<script lang="ts">
  import { resolve } from '$app/paths';
  import { t } from '$lib/utils/functions/translations';
  import { cn } from '@cio/ui/tools';

  type Props = {
    class?: string;
  };

  let { class: className }: Props = $props();
</script>

<a
  href={resolve('/source', {})}
  target="_blank"
  rel="noopener noreferrer"
  title={$t('common.source_code_title')}
  class={cn('ui:text-muted-foreground text-xs hover:underline', className)}
  data-testid="source-code-link"
>
  {$t('common.source_code')}
</a>
