import { handleChat } from './_lib/engine/chatEngine.js';
// Force redeploy v3
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Mode');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check if test mode
  const isTestMode = req.headers['x-test-mode'] === 'true';
  if (isTestMode) {
    console.log('🧪 TEST MODE ENABLED');
  }

  const { prompt, history, sessionId, customerId, slug } = req.body || {};

  // Validate prompt
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }

  // Handle chat
  const result = await handleChat({
    prompt,
    history,
    sessionId,
    customerId,
    slug,
    isTestMode
  });

  // Check for errors
  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }

  return res.status(200).json(result);
}
