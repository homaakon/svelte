<script>
	let items = $state(typeof window !== 'undefined' ? [{name: 'a'}]: [{name: 'a'}, {name: 'b'}]);
</script>

<ul>
	{#each items as item}
		<li>{item.name}</li>
	{/each}
</ul>
<ul>
	{#each items as item (item)}
		<li>{item.name}</li>
	{/each}
</ul>
<ul>
	{#each items as item (item.name)}
		<li>{item.name}</li>
	{/each}
</ul>

{#each items as item}
	<li>{item.name}</li>
	<li>{item.name}</li>
{/each}
{#each items as item (item)}
	<li>{item.name}</li>
	<li>{item.name}</li>
{/each}
{#each items as item (item.name)}
	<li>{item.name}</li>
	<li>{item.name}</li>
{/each}
