/** Browser credential isolation relies on Secure and __Host- enforcement. */
export function assertProductionConfig(config: { PUBLIC_SCHEME: string; EXTRA_TRUSTED_ORIGINS?: string }, production: boolean): void {
  if (production && config.PUBLIC_SCHEME !== 'https') {
    throw new Error('Production deployment requires PUBLIC_SCHEME=https for protected host-only cookies')
  }
  if (production && config.EXTRA_TRUSTED_ORIGINS?.split(',').some(origin => origin.trim() !== '')) {
    throw new Error('Production deployment requires empty EXTRA_TRUSTED_ORIGINS; only the console origin is trusted')
  }
}
