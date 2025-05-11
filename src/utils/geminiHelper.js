import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "@/utils/logger";

class GeminiHelper {
    constructor() {
        const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
        if (!apiKey) {
            logger.warn('[GeminiHelper] No API key found. Set GOOGLE_GEMINI_API_KEY in environment variables.');
            return;
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-1.0-pro" });
    }

    async analyzePageContent(page, selectors = [], expectedState = '') {
        try {
            const content = await page.content();
            const title = await page.title();
            
            // First try traditional selector-based search
            const domResults = await this.searchPageForElements(page, selectors);
            
            if (domResults.found) {
                logger.info('[GeminiHelper] Found through traditional DOM search');
                return {
                    ...domResults,
                    pageState: expectedState,
                    aiAnalysis: null,
                    confidence: 1.0
                };
            }

            // Only proceed with AI analysis if we're looking for verification
            if (expectedState === 'verification') {
                const aiAnalysis = await this.analyzePageState(content, title, expectedState);
                if (aiAnalysis) {
                    return {
                        found: aiAnalysis.matches === true,
                        elements: [],
                        pageState: aiAnalysis.detectedState || 'unknown',
                        aiAnalysis: aiAnalysis.analysis || 'No analysis provided',
                        confidence: aiAnalysis.confidence || 0
                    };
                }
            }

            return {
                found: false,
                elements: [],
                pageState: 'unknown',
                aiAnalysis: null,
                confidence: 0
            };
        } catch (error) {
            logger.error('[GeminiHelper] Page analysis error:', error);
            return {
                found: false,
                elements: [],
                pageState: 'unknown',
                error: error.message,
                confidence: 0
            };
        }
    }

    async analyzePageState(content, title, expectedState) {
        if (!this.model) {
            return null;
        }

        try {
            const prompt = `Analyze this webpage to determine if it's a "${expectedState}" page.
Title: ${title}
Content sample: ${content.substring(0, 1000)}

Return a JSON object that looks exactly like this (replace values only):
{
    "matches": false,
    "detectedState": "unknown",
    "confidence": 0,
    "analysis": "description"
}

Rules:
- matches: true only if this is definitely a ${expectedState} page
- detectedState: must be one of: "login", "password", "verification", "inbox", "unknown"
- confidence: number between 0 and 1
- analysis: brief description of the page purpose`;

            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            
            try {
                // Extract JSON from the response
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    logger.error('[GeminiHelper] No JSON found in response');
                    return null;
                }

                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    matches: Boolean(parsed.matches),
                    detectedState: String(parsed.detectedState || 'unknown'),
                    confidence: Number(parsed.confidence || 0),
                    analysis: String(parsed.analysis || 'No analysis provided')
                };
            } catch (parseError) {
                logger.error('[GeminiHelper] Failed to parse AI response:', parseError);
                return null;
            }
        } catch (error) {
            if (error.message.includes('404')) {
                logger.error('[GeminiHelper] API Error: Invalid model or API key');
            } else {
                logger.error('[GeminiHelper] AI analysis error:', error);
            }
            return null;
        }
    }

    async searchPageForElements(page, selectors) {
        const results = {
            found: false,
            elements: []
        };

        try {
            for (const selector of selectors) {
                if (typeof selector === 'string') {
                    const elements = await page.$$(selector);
                    if (elements.length > 0) {
                        results.found = true;
                        results.elements.push(...elements);
                    }
                } else if (selector.xpath) {
                    const elements = await page.$x(selector.xpath);
                    if (elements.length > 0) {
                        results.found = true;
                        results.elements.push(...elements);
                    }
                }
            }
        } catch (error) {
            logger.error('[GeminiHelper] Element search error:', error);
        }

        return results;
    }
}

export default new GeminiHelper();