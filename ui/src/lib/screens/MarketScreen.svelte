<script lang="ts">
  import Icon from '../Icon.svelte';
  import { t } from '../i18n/i18n.svelte';
</script>

<div class="screen-head">
  <div>
    <p class="kicker">{t('market.kicker')}</p>
    <h1>{t('market.title')}</h1>
    <p class="screen-lede">{t('market.lede')}</p>
  </div>
  <div class="screen-actions">
    <span class="status-pill"><span class="dot"></span> {t('common.notAvailable')}</span>
  </div>
</div>

<section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
  <span class="empty-state__icon"><Icon name="market" size={24} /></span>
  <h2>{t('market.notOpen')}</h2>
  <p>{t('market.notOpenBody')}</p>
  <div class="trust-row" aria-label={t('market.policy')}>
    <span class="status-pill status-pill--ok"><Icon name="check" size={13} /> {t('market.trustOfficial')}</span>
    <span class="status-pill"><Icon name="shield" size={13} /> {t('market.trustReviewed')}</span>
    <span class="status-pill status-pill--warn"><Icon name="alert" size={13} /> {t('market.trustUnreviewed')}</span>
  </div>
  <details class="market-policy">
    <summary>{t('market.policy')}</summary>
    <p>{t('market.policyBody')}</p>
  </details>
</section>
