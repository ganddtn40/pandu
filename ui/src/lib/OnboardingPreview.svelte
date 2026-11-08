<script lang="ts">
  import HeroObject from './HeroObject.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import { navigate } from './router.svelte';

  interface Step {
    kicker: string;
    title: string;
    body: string;
    points: string[];
  }

  const steps: Step[] = [
    {
      kicker: 'Step 1 of 3',
      title: 'Meet your control tower.',
      body: 'Cockpit records what your coding agents do, shows it live, and keeps every run on this machine.',
      points: ['One calm dashboard', 'No account or cloud', 'Works with the agents you already use'],
    },
    {
      kicker: 'Step 2 of 3',
      title: 'Every step, recorded.',
      body: 'Each flight keeps the request, tool calls, file changes, cost, and context so you can replay a run instead of guessing.',
      points: ['Live and replay views', 'Exact diffs', 'Fork from any recorded step'],
    },
    {
      kicker: 'Step 3 of 3',
      title: 'You stay in control.',
      body: 'Risky actions wait for an explicit yes. Guards, budgets, and approvals stay visible, even from your phone.',
      points: ['Approve or deny from anywhere', 'Guard rules you can read', 'Fail-open, never blocks your agent'],
    },
  ];

  let index = $state(0);
  const step = $derived(steps[index]!);
  const last = $derived(index === steps.length - 1);

  function next(): void {
    if (last) {
      navigate('/');
      return;
    }
    index += 1;
  }

  function back(): void {
    if (index > 0) index -= 1;
  }
</script>

<div class="onboarding">
  <header class="onboarding__top">
    <a class="brand" href="/" data-route aria-label="Cockpit home">
      <Logo size={34} />
      <span class="brand__name">Cockpit</span>
    </a>
    <a class="btn btn--small btn--ghost" href="/" data-route>Skip</a>
  </header>

  <section
    class="onboarding__card card"
    aria-labelledby="onboarding-title"
    data-glass
    data-glass-layer="card"
    data-glass-depth="2"
  >
    <div class="onboarding__visual">
      <HeroObject size={360} />
      <span class="onboarding__badge"><span class="dot dot--live"></span> Local by default</span>
    </div>

    <div class="onboarding__copy">
      <p class="kicker">{step.kicker}</p>
      <h1 id="onboarding-title">{step.title}</h1>
      <p class="onboarding__body">{step.body}</p>

      <ul class="onboarding__points">
        {#each step.points as point}
          <li><Icon name="check" size={16} /> {point}</li>
        {/each}
      </ul>

      <div class="onboarding__dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
        {#each steps as _, dotIndex}
          <span class:is-active={dotIndex === index}></span>
        {/each}
      </div>

      <div class="onboarding__actions">
        {#if index > 0}
          <button class="btn btn--ghost" type="button" onclick={back}>
            <Icon name="arrow-left" size={16} />
            Back
          </button>
        {/if}
        <button class="btn btn--primary" type="button" onclick={next}>
          {last ? 'Open Cockpit' : 'Continue'}
          <Icon name={last ? 'check' : 'arrow-right'} size={16} />
        </button>
        <span class="onboarding__note">Preview · the full tour arrives in Phase 5</span>
      </div>
    </div>
  </section>
</div>
