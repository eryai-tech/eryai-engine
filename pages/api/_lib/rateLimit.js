// Simple in-memory rate limiting for Vercel serverless
const rateLimitMap = new Map();

const WINDOW_MS = 30 * 1000; // 30 seconds
const MAX_REQUESTS = 5; // 5 requests per window

export function rateLimit(identifier) {
  const now = Date.now();
  const key = identifier;
  
  let data = rateLimitMap.get(key);
  
  if (!data || now - data.windowStart > WINDOW_MS) {
    data = { windowStart: now, count: 1 };
    rateLimitMap.set(key, data);
    return { success: true, remaining: MAX_REQUESTS - 1, resetIn: WINDOW_MS };
  }
  
  data.count++;
  
  if (data.count > MAX_REQUESTS) {
    const resetIn = WINDOW_MS - (now - data.windowStart);
    return { 
      success: false, 
      remaining: 0,
      retryAfter: Math.ceil(resetIn / 1000)
    };
  }
  
  return { 
    success: true, 
    remaining: MAX_REQUESTS - data.count,
    resetIn: WINDOW_MS - (now - data.windowStart)
  };
}

export function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}
