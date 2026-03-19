/**
 * Claude API Service
 * Handles all interactions with the Anthropic Claude API.
 * Used for: AI conversation partner, passage generation, grammar explanations.
 */
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** System prompts for each conversation mode */
const SYSTEM_PROMPTS = {
  casual: `You are a friendly Korean conversation partner. Respond primarily in Korean at an intermediate level. After each response, provide a brief English explanation of any difficult grammar or vocabulary you used. Keep responses conversational (2-4 sentences). Correct any errors the user makes, but gently.`,

  business: `You are a Korean business language tutor. Respond in formal Korean (격식체, 합쇼체). Focus on business contexts: emails, meetings, reports. After each response, explain the formality level and any business-specific expressions used. Correct errors with professional alternatives.`,

  topik_prep: `You are a TOPIK exam preparation tutor. Respond in Korean at TOPIK II level. Use academic and analytical language. After each response, note which TOPIK grammar patterns you used and their level. Ask comprehension questions to check understanding.`,
};

/**
 * AI Conversation Partner
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {'casual' | 'business' | 'topik_prep'} mode - Conversation mode
 * @returns {Promise<string>} AI response text
 */
async function conversationPartner(messages, mode) {
  const systemPrompt = SYSTEM_PROMPTS[mode];
  if (!systemPrompt) {
    throw new Error(`Invalid conversation mode: ${mode}`);
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

/**
 * Generate a reading passage at specified difficulty
 * @param {'elementary' | 'middle' | 'high' | 'adult'} level - Reading difficulty level
 * @param {'business' | 'daily' | 'academic' | 'casual'} mode - Content context mode
 * @returns {Promise<{title: string, content: string, questions: string[], translation: string}>}
 */
async function generateReadingPassage(level, mode) {
  const prompt = `Generate a Korean reading passage for language learners.
Level: ${level} school level Korean
Context/mode: ${mode}
Length: 150-200 words

Requirements:
- Write entirely in Korean
- Appropriate vocabulary and grammar for ${level} level
- Natural, authentic writing style
- After the passage, provide 3 comprehension questions in Korean
- Then provide an English translation of the passage

Format as JSON:
{ "title": "", "content": "", "questions": [], "translation": "" }`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

/**
 * Explain a Korean grammar pattern
 * @param {string} pattern - Korean grammar pattern (e.g., "-아/어서")
 * @returns {Promise<{meaning: string, usage: string, examples: Array, common_mistakes: string[], topik_level: string}>}
 */
async function explainGrammar(pattern) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content: `Explain the Korean grammar pattern "${pattern}" concisely. Include: meaning, usage rules, 3 example sentences (Korean + English), common mistakes, and TOPIK level if applicable. Format as JSON.`,
      },
    ],
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = { conversationPartner, generateReadingPassage, explainGrammar };
