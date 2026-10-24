export type QuotaCreditsSettings = {
  source: 'statusline' | 'credits_panel';
  pattern: string;
};

export type AbsoluteQuotaCredits = {
  label: string;
  usedFraction: null;
  remaining: number | null;
  unit: 'credits';
  source: QuotaCreditsSettings['source'];
  observedAt: string;
  reliable: boolean;
  issue?: string;
};

export type QuotaCreditsObservation = {
  text: string;
  observedAt: string;
  truncated: boolean;
  reliable: boolean;
};

export function parseQuotaCredits(settings: QuotaCreditsSettings | null, input: QuotaCreditsObservation): AbsoluteQuotaCredits | null {
  throw new Error('NotImplemented');
}
