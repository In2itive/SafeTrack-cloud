import { authedFetch } from './repo';

/**
 * One-line treasurer insight. The Gemini key lives only on the server; the
 * browser sends aggregate numbers, never donor names or amounts per giver.
 */
export const generateFinancialInsight = async (
  totalValue: number,
  totalBatches: number,
  donationCount: number
): Promise<string> => {
  try {
    const { insight } = await authedFetch<{ insight: string }>('/api/insight', {
      method: 'POST',
      body: JSON.stringify({ totalValue, totalBatches, donationCount }),
    });
    return insight;
  } catch {
    return 'AI Assistant offline.';
  }
};
