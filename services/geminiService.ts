import { GoogleGenAI } from "@google/genai";
import { Batch, Donation } from "../types";

export const generateFinancialInsight = async (
  totalValue: number, 
  totalBatches: number, 
  recentDonations: Donation[]
): Promise<string> => {
  if (!process.env.API_KEY) {
    return "AI Assistant offline. (API Key missing)";
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `
    You are a helpful church treasurer assistant.
    Current Vault Stats:
    - Total Vault Value: $${totalValue.toFixed(2)}
    - Total Batches Processed: ${totalBatches}
    - Recent Donation Count: ${recentDonations.length}

    Provide a 1-sentence encouraging summary or financial tip for the treasurer based on this activity. Keep it professional yet warm.
  `;

  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
      });
      return response.text || "Keep up the good work managing the funds!";
    } catch (error: any) {
      console.error(`Gemini API Error (Attempt ${attempt + 1}/${maxRetries}):`, error);
      
      // Check for rate limit (429) or server errors (5xx)
      if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
        attempt++;
        if (attempt < maxRetries) {
          let delay = Math.pow(2, attempt) * 1000; // Default exponential backoff
          
          // Try to parse specific retry time from error message
          // Example: "Please retry in 54.659086913s."
          const match = error.message?.match(/retry in (\d+(\.\d+)?)s/);
          if (match && match[1]) {
            // Use the requested time plus a small buffer (1s)
            delay = Math.ceil(parseFloat(match[1])) * 1000 + 1000;
          }

          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      // If not retryable or max retries reached, return fallback
      return "Unable to generate insights at this moment.";
    }
  }
  
  return "Unable to generate insights at this moment.";
};