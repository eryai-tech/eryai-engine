# EryAI Engine

Universal AI engine that powers all EryAI customer chatbots.

## How it works

1. **Customer identified** by `slug` or `customerId`
2. **AI config loaded** from `customer_ai_config` table
3. **Actions checked** from `customer_actions` table
4. **Response generated** using Gemini AI + customer's knowledge base
5. **Handoff triggered** if needed (complaints, special requests)

## API Endpoint

```
POST /api/chat
```

### Request body:

```json
{
  "prompt": "Har ni glutenfritt?",
  "slug": "bella-italia",
  "sessionId": null,
  "history": []
}
```

### Response:

```json
{
  "response": "Ja! Vi har glutenfri pasta...",
  "sessionId": "uuid",
  "customerId": "uuid",
  "customerName": "Bella Italia",
  "aiName": "Sofia",
  "triggeredActions": ["add_context"],
  "needsHandoff": false
}
```

## Database Tables

### customer_ai_config
- `ai_name` - AI assistant name (Sofia)
- `ai_role` - Role (hovmästare)
- `personality` - Personality description
- `greeting` - Initial greeting
- `system_prompt` - Full personality and rules
- `knowledge_base` - All facts the AI knows

### customer_actions
- `trigger_type` - keyword, intent, or regex
- `trigger_value` - What triggers the action
- `action_type` - collect_info, handoff, add_context, send_email
- `action_config` - JSON configuration

## Environment Variables

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=xxx
GEMINI_API_KEY=xxx
RESEND_API_KEY=xxx
```

## Usage

Widgets call this engine instead of having their own AI logic:

```javascript
const response = await fetch('https://engine.eryai.tech/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: userMessage,
    slug: 'bella-italia',
    sessionId: currentSessionId,
    history: conversationHistory
  })
});
```

## Adding a new customer

1. Add row to `customers` table
2. Add row to `customer_ai_config` with personality + knowledge
3. Add rows to `customer_actions` for behavior rules
4. Done! No code changes needed.


fix: trigger redeploy 1
