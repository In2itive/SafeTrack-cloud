import { invokeFunction } from './repo';

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
    const { insight } = await invokeFunction<{ insight: string }>('insight', { totalValue, totalBatches, donationCount });
    return insight;
  } catch {
    return 'AI Assistant offline.';
  }
};
